import { createHash } from "node:crypto";
import { z } from "zod";
import type { LLMGateway } from "@aff/llm";
import type { PolicyConfig } from "@aff/domain";
import type { Repository } from "@aff/db";
import { htmlToVisibleText, selectRelevantWindows, type Fetcher } from "@aff/integrations";
import { collectPlanSources } from "./pipeline-support.js";
import type { ArticlePlan } from "./pipeline.js";
import { splitByAllowlist } from "./plan-queue.js";

/**
 * Finding the plans (docs/19). A stock kept by hand stops growing the day the last
 * plan is published. A discovery source names one official page that lists the
 * services of a company (for water: its servers); the plans are made from that page
 * every day, as brief-only plans that `plan-quotes.ts` fills from the page's own words.
 *
 * A model only points at names on the page. The code keeps a name only when it is a
 * line of the page that appears more than once, orders the names by the page rather
 * than by the model, and derives the slug from the name alone, so the same server is
 * the same plan on every day whatever the model says. A name that is not a real
 * product costs one failed draft, never a published article: the draft and QA fail closed.
 */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const httpsUrl = z
  .string()
  .url()
  .refine((url) => url.startsWith("https://"), { message: "must be an https URL" });

export interface DiscoverySource {
  /** Only the water calculator can draft a plan from quotes (docs/18). */
  verticalId: "water_delivery";
  /** Lowercase ASCII, the start of every slug of this company. */
  brandSlug: string;
  /** The company as the page names it; a term every service's quote must be about. */
  brandName: string;
  /** The plan of the page's table of servers (for example "もっとPREMIUM"); the minimum term is read for it. */
  planName?: string | undefined;
  /** Official pages that list the services. */
  listUrls: string[];
  /** Pages each plan reads for its amounts; the list pages when absent. */
  sourceUrls?: string[] | undefined;
  months: number;
  monthlyLiters: number;
}

const sourceSchema = z
  .object({
    verticalId: z.literal("water_delivery"),
    brandSlug: z.string().regex(SLUG_PATTERN).max(40),
    brandName: z.string().min(1).max(60),
    planName: z.string().min(1).max(60).optional(),
    listUrls: z.array(httpsUrl).min(1).max(5),
    sourceUrls: z.array(httpsUrl).min(1).max(8).optional(),
    months: z.number().int().min(1).max(120).default(24),
    monthlyLiters: z.number().positive().max(1000).default(25),
  })
  .strict();

const fileSchema = z
  .object({ $comment: z.string().optional(), sources: z.array(sourceSchema).min(1).max(20) })
  .strict();

/** Reads a discovery file; a bad file stops the run before any page is fetched. */
export function parseDiscoveryFile(text: string): DiscoverySource[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("discovery file invalid: not JSON");
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `discovery file invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data.sources;
}

// ---- names ----

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;
const BRACKETED = /[（(【[][^）)】\]]*[）)】\]]/g;
/** A product's name is a short line; a longer line is a sentence. */
const MAX_NAME_CHARS = 40;
const MIN_NAME_CHARS = 2;
/** A name that is a line of its own at least this many times is a heading of the page, not a sentence or a menu word. */
const MIN_LINE_OCCURRENCES = 2;

/** A line without the notes beside it: width variants, zero-width spaces and bracketed readings. */
function displayOf(line: string): string {
  return line
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(BRACKETED, "")
    .replace(/\s+/g, " ")
    .trim();
}

const canonicalOf = (display: string): string => displayOf(display).replace(/\s+/g, "");

export interface ServiceName {
  /** How the page writes the name most often. */
  display: string;
  /** The display without spaces: what makes two spellings one service. */
  canonical: string;
}

interface LineEntry {
  firstLine: number;
  lines: number;
  forms: Map<string, number>;
}

function indexLines(pageText: string): Map<string, LineEntry> {
  const index = new Map<string, LineEntry>();
  pageText.split("\n").forEach((raw, lineNo) => {
    const display = displayOf(raw);
    if (display.length < MIN_NAME_CHARS || display.length > MAX_NAME_CHARS) return;
    const canonical = display.replace(/\s+/g, "");
    const entry = index.get(canonical) ?? { firstLine: lineNo, lines: 0, forms: new Map<string, number>() };
    entry.lines += 1;
    entry.forms.set(display, (entry.forms.get(display) ?? 0) + 1);
    index.set(canonical, entry);
  });
  return index;
}

function mostCommonForm(forms: ReadonlyMap<string, number>): string {
  let best = "";
  let bestCount = 0;
  for (const [form, count] of forms) {
    if (count > bestCount) {
      best = form;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Keeps the proposed names that are real: a line of `pageText` (up to notes in
 * brackets and spaces) that appears as a line at least twice, and that is not the
 * company's or the plan's own name. Returns them in the order of the page, once each,
 * and how many proposals were dropped.
 */
export function findServiceNames(
  proposed: readonly string[],
  pageText: string,
  options: { exclude: readonly string[] },
): { names: ServiceName[]; rejected: number } {
  const index = indexLines(pageText);
  const excluded = options.exclude.map(canonicalOf).filter((term) => term.length > 0);
  const kept = new Map<string, LineEntry>();
  let rejected = 0;
  for (const proposal of proposed) {
    const canonical = canonicalOf(proposal);
    const entry = index.get(canonical);
    const usable =
      canonical.length >= MIN_NAME_CHARS &&
      entry !== undefined &&
      entry.lines >= MIN_LINE_OCCURRENCES &&
      !excluded.some((term) => canonical.includes(term));
    if (!usable) {
      rejected += 1;
      continue;
    }
    kept.set(canonical, entry);
  }
  const names = [...kept.entries()]
    .sort(([, a], [, b]) => a.firstLine - b.firstLine)
    .map(([canonical, entry]) => ({ display: mostCommonForm(entry.forms), canonical }));
  return { names, rejected };
}

// ---- plans ----

/** Readable for a name that is plain ASCII; otherwise the ASCII part and a fixed digest of the name. */
function slugPartOf(name: string): string {
  const display = displayOf(name);
  const ascii = display
    .replace(/[^ -~]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (/^[A-Za-z0-9 -]+$/.test(display) && ascii.length >= 2) return ascii;
  const digest = createHash("sha1").update(canonicalOf(display)).digest("hex").slice(0, 6);
  return `${ascii.length >= 3 ? ascii : "model"}-${digest}`;
}

/**
 * The plan's slug, from the company and the name only. It is what makes a server
 * the same plan on every day, and it must never change once an article has it.
 */
export function discoveredSlug(brandSlug: string, name: string, months: number): string {
  return `${brandSlug}-${slugPartOf(name)}-${months}month`;
}

/** A brief-only plan for one service: the amounts are read from the page's quotes (docs/18). */
export function planForService(source: DiscoverySource, name: ServiceName): ArticlePlan {
  const { brandSlug, brandName, planName, months, monthlyLiters } = source;
  const evidenceTerms = [...new Set([name.display, name.canonical, brandName])];
  return {
    slug: discoveredSlug(brandSlug, name.display, months),
    // The company's name stays in the title but not at its start: program terms can forbid that (docs/20).
    title: `ウォーターサーバー ${name.display}（${brandName}）の${months}ヶ月総額（公式料金ベースの試算）`,
    audience: "家庭でボトル型ウォーターサーバーの利用を検討している人",
    purpose: `公式の料金ページに載る月額・送料・手数料・電気代の目安から、月${monthlyLiters}Lを${months}ヶ月使った場合の総額を試算します。`,
    verticalId: source.verticalId,
    keyword: `ウォーターサーバー 総額 ${brandName} ${name.display}`,
    sourceUrls: source.sourceUrls ?? source.listUrls,
    calculators: [],
    draft: {
      calculator: "water",
      offerId: `offer-${brandSlug}-${slugPartOf(name.display)}`,
      title: planName ? `${brandName} ${name.display}（${planName}プラン）` : `${brandName} ${name.display}`,
      evidenceTerms,
      priceTerms: [name.display],
      ...(planName ? { planTerms: [planName] } : {}),
      months,
      monthlyLiters,
    },
    offerIds: [],
  };
}

/** The written plans come first and win on a slug; discovered plans follow, once each. */
export function mergeDiscovered(explicit: readonly ArticlePlan[], discovered: readonly ArticlePlan[]): ArticlePlan[] {
  const seen = new Set(explicit.map((plan) => plan.slug));
  const merged = [...explicit];
  for (const plan of discovered) {
    if (seen.has(plan.slug)) continue;
    seen.add(plan.slug);
    merged.push(plan);
  }
  return merged;
}

// ---- the model ----

export interface ListRequest {
  brand: string;
  /** A window of the page's visible text. */
  window: string;
}

/** Returns names that it claims are lines of `window`; nothing it returns is trusted. */
export interface PlanLister {
  list(request: ListRequest): Promise<string[]>;
}

export const SERVICE_LISTING_TASK = `You read the text of an official page of a company. The page lets a customer choose among products (for water delivery: the water server models).
Return JSON: {"names":["..."]}
Rules:
- List the names of the products themselves, for example the water server models.
- Every name must be copied character for character from the page text, and must be a whole line of it (the product's own name, not a sentence).
- Do not list plan names, the company's name, buttons, menu items, prices, section titles or descriptions.
- List each product once. Return an empty list when the text names none.`;

const SERVICE_LISTING_SCHEMA = z.object({ names: z.array(z.unknown()) }).transform(({ names }) => ({
  names: names.filter((name): name is string => typeof name === "string"),
}));

/** The LLM-backed lister; the gateway validates the shape and records the cost. */
export class LlmPlanLister implements PlanLister {
  constructor(
    private readonly gateway: LLMGateway,
    private readonly limits: { timeoutMs: number; maxCostJpy: number; attempts: number; maxOutputTokens?: number },
  ) {}

  async list(request: ListRequest): Promise<string[]> {
    const result = await this.gateway.generateStructured<{ names: string[] }>({
      task: SERVICE_LISTING_TASK,
      input: { brand: request.brand, content: request.window },
      schema: SERVICE_LISTING_SCHEMA,
      limits: { maxOutputTokens: 1_024, ...this.limits },
    });
    return result.output.names;
  }
}

// ---- discovery ----

export type DiscoverySkip =
  | "domain_not_allowlisted"
  | "invalid_source_url"
  | "source_unavailable"
  | "listing_failed"
  | "no_services";

/** Counts only: the run output goes to a public log. */
export interface DiscoverySummary {
  sources: number;
  found: number;
  skipped: Partial<Record<DiscoverySkip, number>>;
}

export interface DiscoveryResult {
  plans: ArticlePlan[];
  summary: DiscoverySummary;
}

export interface DiscoveryDeps {
  repo: Repository;
  policy: PolicyConfig;
  clock: () => Date;
  fetcher: Fetcher;
  /** Without it no source can be listed (the LLM is not configured). */
  lister?: PlanLister | undefined;
}

function probeOf(source: DiscoverySource, sourceUrls: string[]): ArticlePlan {
  return {
    slug: `discover-${source.brandSlug}`,
    title: source.brandName,
    audience: "",
    purpose: "",
    verticalId: source.verticalId,
    keyword: "",
    sourceUrls,
    calculators: [],
    offerIds: [],
  };
}

type SourceOutcome = { plans: ArticlePlan[] } | { skip: DiscoverySkip };

async function discoverFromSource(source: DiscoverySource, deps: DiscoveryDeps): Promise<SourceOutcome> {
  // Every page the plans will read must be allowed before any page is fetched, the list page included.
  const allUrls = [...new Set([...source.listUrls, ...(source.sourceUrls ?? [])])];
  const { held } = splitByAllowlist([probeOf(source, allUrls)], deps.policy.security.allowed_source_domains);
  if (held[0]) return { skip: held[0].reason === "invalid_source_url" ? "invalid_source_url" : "domain_not_allowlisted" };
  if (!deps.lister) return { skip: "listing_failed" };

  const { collected } = await collectPlanSources(probeOf(source, source.listUrls), {
    repo: deps.repo,
    policy: deps.policy,
    fetcher: deps.fetcher,
    clock: deps.clock,
  });
  if (collected.length === 0) return { skip: "source_unavailable" };

  const exclude = [source.brandName, ...(source.planName ? [source.planName] : [])];
  const names = new Map<string, ServiceName>();
  try {
    for (const page of collected) {
      const text = htmlToVisibleText(page.body, page.record.contentType);
      const proposed: string[] = [];
      for (const window of selectRelevantWindows(text)) {
        proposed.push(...(await deps.lister.list({ brand: source.brandName, window })));
      }
      for (const name of findServiceNames(proposed, text, { exclude }).names) {
        if (!names.has(name.canonical)) names.set(name.canonical, name);
      }
    }
  } catch {
    return { skip: "listing_failed" };
  }
  if (names.size === 0) return { skip: "no_services" };
  return { plans: [...names.values()].map((name) => planForService(source, name)) };
}

/**
 * Makes the plans of every discovery source. A source that cannot be used (its host
 * is not allowed, its page cannot be read, the model fails, no name is on the page)
 * is skipped and counted; it never stops the run or the other sources.
 */
export async function discoverPlans(sources: readonly DiscoverySource[], deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const plans: ArticlePlan[] = [];
  const seen = new Set<string>();
  const skipped: DiscoverySummary["skipped"] = {};
  for (const source of sources) {
    const outcome = await discoverFromSource(source, deps);
    if ("skip" in outcome) {
      skipped[outcome.skip] = (skipped[outcome.skip] ?? 0) + 1;
      continue;
    }
    for (const plan of outcome.plans) {
      if (seen.has(plan.slug)) continue;
      seen.add(plan.slug);
      plans.push(plan);
    }
  }
  return { plans, summary: { sources: sources.length, found: plans.length, skipped } };
}
