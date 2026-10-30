import { z } from "zod";
import type { LLMGateway } from "@aff/llm";
import { newId, type Fact, type PolicyConfig } from "@aff/domain";
import type { Repository } from "@aff/db";
import {
  MapFetcher,
  createFreshnessPolicy,
  htmlToVisibleText,
  selectRelevantWindows,
  type CollectedSource,
  type Fetcher,
} from "@aff/integrations";
import { completeDraftedPlan, type DraftResult } from "./plan-draft.js";
import { collectPlanSources } from "./pipeline-support.js";
import type { ArticlePlan, PlanDraft } from "./pipeline.js";
import { toFact } from "./research.js";

/**
 * Drafting from quotes of the page (docs/18). The facts an LLM writes from a page
 * are paraphrases and their wording changes from run to run, so the amounts of a
 * plan are not read from them. A model only points at passages of the fetched page
 * text; the code checks that every passage is really there, and only the passages
 * that pass are read, by the deterministic rules of `plan-draft.ts`. A model that
 * quotes wrongly, or invents a figure, loses the passage; it cannot add a number.
 */
export interface QuoteBrief {
  title: string;
  evidenceTerms: string[];
  priceTerms?: string[];
  planTerms?: string[];
  monthlyLiters: number;
}

export interface QuoteRequest {
  brief: QuoteBrief;
  /** A window of the page's visible text. */
  window: string;
}

/** Returns passages that it claims are copied from `window`; nothing it returns is trusted. */
export interface QuoteSelector {
  select(request: QuoteRequest): Promise<string[]>;
}

/** A passage from a product's name down to its figure can be long; a longer quote is not one statement. */
const MAX_QUOTE_CHARS = 1200;

/** Whitespace, table separators and width variants do not make a quote different from the page. */
const squash = (text: string): string => text.normalize("NFKC").replace(/[\s|]+/g, "");

/**
 * Keeps the quotes that are a contiguous passage of `pageText` (up to whitespace and
 * table separators). Returns them with their whitespace collapsed, once each, and
 * how many were not on the page, empty or too long to be one passage.
 */
export function verifyQuotes(quotes: readonly string[], pageText: string): { verified: string[]; rejected: number } {
  const page = squash(pageText);
  const seen = new Set<string>();
  const verified: string[] = [];
  let rejected = 0;
  for (const quote of quotes) {
    const key = squash(quote);
    if (key.length === 0 || key.length > MAX_QUOTE_CHARS || !page.includes(key)) {
      rejected += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    verified.push(quote.replace(/\s+/g, " ").trim());
  }
  return { verified, rejected };
}

export const QUOTE_SELECTION_TASK = `You read the text of an official price page for ONE service and plan, named in the brief. Find the passages that state the amounts listed below for that service and plan.
Return JSON: {"quotes":[{"field":"water|shipping|electricity|electricity_basis|rental|initial|cancellation|term","quote":"..."}]}
Rules:
- Every quote must be copied character for character from the page text: one contiguous passage of at most 1000 characters. Never rewrite, translate, shorten inside the passage, join separate passages or correct anything.
- A quote must contain the figure AND the words that say what it is for (the plan, the server or product, the kind of fee, the quantity). Prefer the shortest passage that does.
- A figure that belongs to one particular server or plan (its price, its electricity cost) must be quoted from the line that names that server or plan down to the figure, even when that is long, so the quote itself shows whose figure it is. A page-wide fee (shipping, setup fee) needs no name.
- water: the monthly water charge for the brief's monthly volume, for this plan and server (a price card whose label, figure and server name are on neighbouring lines is one passage).
- shipping: the shipping fee. electricity: this server's monthly electricity cost. electricity_basis: the sentence saying how much monthly use the electricity estimate assumes.
- rental: this server's monthly rental fee (サーバーレンタル料), including when the page says it is free. Quote the line that gives the rental together with this server's name; when the page lists one rental per plan side by side, quote the whole row.
- initial: the initial registration or setup fee. cancellation: the contract termination fee. term: the minimum contract period of this plan.
- Leave a field out when the text does not state it for this service and plan. Do not compute, convert or combine figures.`;

const QUOTE_SELECTION_SCHEMA = z.object({ quotes: z.array(z.unknown()) }).transform(({ quotes }) => ({
  quotes: quotes.flatMap((entry): string[] => {
    if (typeof entry === "string") return [entry];
    const quote = (entry as { quote?: unknown } | null)?.quote;
    return typeof quote === "string" ? [quote] : [];
  }),
}));

/** The LLM-backed selector; the gateway validates the shape and records the cost. */
export class LlmQuoteSelector implements QuoteSelector {
  constructor(
    private readonly gateway: LLMGateway,
    private readonly limits: { timeoutMs: number; maxCostJpy: number; attempts: number; maxOutputTokens?: number },
  ) {}

  async select(request: QuoteRequest): Promise<string[]> {
    const result = await this.gateway.generateStructured<{ quotes: string[] }>({
      task: QUOTE_SELECTION_TASK,
      input: { brief: request.brief, content: request.window },
      schema: QUOTE_SELECTION_SCHEMA,
      limits: { maxOutputTokens: 4_096, ...this.limits },
    });
    return result.output.quotes;
  }
}

export interface QuoteDraftDeps {
  repo: Repository;
  policy: PolicyConfig;
  clock: () => Date;
  selector?: QuoteSelector;
  /** This cycle's pages; fetched again (no model call) when the caller did not keep them. */
  collected?: CollectedSource[];
  fetcher?: Fetcher;
}

function claimTypeOf(text: string): Fact["claimType"] {
  const t = text.normalize("NFKC");
  if (/最低利用期間|契約期間/.test(t)) return "contract_term";
  if (/契約解除料|解約金|解約料|違約金|解除料/.test(t)) return "cancellation";
  return "price";
}

const failed = (...issues: string[]): DraftResult => ({ ok: false, issues });

type QuotePass =
  | { ok: true; candidates: Fact[]; read: { plan: ArticlePlan } }
  | { ok: false; issues: string[] };

/** One pass: the model picks quotes from every page, the code checks them, the rules read them. */
async function readQuotesOnce(
  plan: ArticlePlan,
  brief: QuoteBrief,
  collected: readonly CollectedSource[],
  selector: QuoteSelector,
  now: string,
): Promise<QuotePass> {
  const candidates: Fact[] = [];
  let rejected = 0;
  try {
    for (const source of collected) {
      const text = htmlToVisibleText(source.body, source.record.contentType);
      const quotes: string[] = [];
      for (const window of selectRelevantWindows(text)) {
        quotes.push(...(await selector.select({ brief, window })));
      }
      const checked = verifyQuotes(quotes, text);
      rejected += checked.rejected;
      candidates.push(
        ...checked.verified.map((quote, index) => ({
          id: `quote-${source.record.id}-${index}`,
          text: quote,
          claimType: claimTypeOf(quote),
          sourceIds: [source.record.id],
          verifiedAt: now,
          confidence: 1,
          verificationStatus: "VERIFIED" as const,
        })),
      );
    }
  } catch (error) {
    return { ok: false, issues: [`引用の選択に失敗しました: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const read = completeDraftedPlan(plan, candidates, collected.map((source) => source.record));
  if (!read.ok) {
    return { ok: false, issues: [...read.issues, ...(rejected > 0 ? [`本文に無い引用を${rejected}件破棄しました`] : [])] };
  }
  return { ok: true, candidates, read };
}

/**
 * Fills a brief-only plan's calculators from quotes of this cycle's pages. The
 * quotes that were read are saved as facts (verbatim passages of the official page),
 * so the QA number check and the article's price claims rest on them. A plan with
 * calculators, or with no `draft`, is returned as it is without any model call.
 */
export async function draftPlanFromPages(plan: ArticlePlan, deps: QuoteDraftDeps): Promise<DraftResult> {
  const draft: PlanDraft | undefined = plan.draft;
  if (!draft || plan.calculators.length > 0) return { ok: true, plan };
  if (!deps.selector) return failed("引用を選ぶ仕組みがありません（LLMの設定が必要です）");

  let collected = deps.collected;
  if (!collected) {
    const fetched = await collectPlanSources(plan, {
      repo: deps.repo,
      policy: deps.policy,
      fetcher: deps.fetcher ?? new MapFetcher(new Map()),
      clock: deps.clock,
    });
    if (fetched.unavailable.length > 0) return failed(...fetched.unavailable.map((url) => `source_unavailable:${url}`));
    collected = fetched.collected;
  }

  const brief: QuoteBrief = {
    title: draft.title,
    evidenceTerms: draft.evidenceTerms,
    ...(draft.priceTerms ? { priceTerms: draft.priceTerms } : {}),
    ...(draft.planTerms ? { planTerms: draft.planTerms } : {}),
    monthlyLiters: draft.monthlyLiters,
  };
  const selector = deps.selector;
  // A new plan that cannot be drafted is quarantined and never tried again, so a model that
  // picked badly once is asked again in this run. Each pass is independent; the first that reads wins.
  const attempts = Math.max(1, deps.policy.limits.task_retry_attempts);
  let pass: QuotePass = { ok: false, issues: [] };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    pass = await readQuotesOnce(plan, brief, collected, selector, deps.clock().toISOString());
    if (pass.ok) break;
  }
  if (!pass.ok) return failed(...pass.issues);
  const { candidates, read } = pass;

  const freshness = createFreshnessPolicy(deps.policy);
  const saved: Fact[] = [];
  for (const fact of candidates) {
    const source = collected.find((candidate) => candidate.record.id === fact.sourceIds[0])!.record;
    const expiresAt = new Date(Date.parse(source.fetchedAt) + freshness.maxAgeDaysFor(fact.claimType) * 86_400_000).toISOString();
    saved.push(await deps.repo.facts.save(toFact({ text: fact.text, claimType: fact.claimType, confidence: 1 }, source.id, source.fetchedAt, expiresAt, newId)));
  }
  return { ok: true, plan: read.plan, facts: saved };
}
