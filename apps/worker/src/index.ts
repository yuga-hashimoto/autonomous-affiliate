import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createLogger,
  dayKeyInTz,
  parsePolicyText,
  type AffiliateOffer,
  type PolicyConfig,
  type SerpObservation,
} from "@aff/domain";
import { createMemoryRepository, createPgRepository, type Repository } from "@aff/db";
import {
  BudgetLedger,
  CliLlmProvider,
  MockProvider,
  OpenAiCompatibleProvider,
  createGateway,
  mockJson,
} from "@aff/llm";
import {
  runPlan,
  runPlanQueue,
  splitByAllowlist,
  refreshSweep,
  growthPlan,
  FixtureFactExtractor,
  LlmFactExtractor,
  LlmPlanLister,
  LlmQuoteSelector,
  discoverPlans,
  ensureBrandOffers,
  mergeDiscovered,
  parseA8ProgramsFile,
  activeScoutedSources,
  vetAdvertiserSite,
  scoutedInUse,
  withScoutedBrands,
  withScoutedDomains,
  parseDiscoveryFile,
  type DiscoverySummary,
  type FactExtractor,
  type PlanLister,
  type QuoteSelector,
  type ArticlePlan,
  type HeldPlan,
  type HoldReason,
  type PlanRunResult,
} from "@aff/agents";
import { AspReportImporter, HttpFetcher, MapFetcher, checkRobots, type Fetcher } from "@aff/integrations";
import { buildMonthlyReport, renderMonthlyReportMarkdown } from "@aff/analytics";
import { runA8Apply } from "./a8-apply.js";
import { runA8AdUrlProbe } from "./a8-adurl.js";
import { runA8ExportApproved } from "./a8-export.js";
import { runA8Inspect } from "./a8-inspect.js";
import { runA8LinkProbe } from "./a8-linkpage.js";
import { runA8LoginSmoke } from "./a8-login.js";
import { runA8Programs } from "./a8-programs.js";
import { runA8SubmitUrls } from "./a8-submit.js";
import { runA8Scout } from "./a8-scout.js";
import { runA8Sync, type ScoutDeps } from "./a8-sync.js";
import { exportGoOffers } from "./go-offers.js";
import { createHeroImageService, runImageSmoke } from "./hero-image.js";
import { LivePublisherIO } from "./live-io.js";
import plansFixture from "../../../config/plans.dry-run.json" with { type: "json" };
import offersFixture from "../../../config/offers.dry-run.json" with { type: "json" };

/** The stop switch for advertisers the run picked itself (docs/21): unset or anything but "true" and none of them is used. */
function scoutingEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.A8_SCOUT_ENABLED === "true";
}

/** New advertisers: sites looked at per run, and advertisers in use at the most (docs/21). */
const SCOUT_MAX_VETS = 2;
const SCOUT_MAX_REGISTERED = 3;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface PlansFile {
  plans: ArticlePlan[];
}

export interface WorkerOptions {
  policyPath: string;
  outDir: string;
  repo?: Repository;
  logger?: ReturnType<typeof createLogger>;
  clock?: () => Date;
  env?: NodeJS.ProcessEnv;
  /**
   * Live research and QA against real pages with the real LLM, but with no
   * database (state in memory), no git and publishing forced off. Used to see
   * whether a plan would pass QA without any lasting effect.
   */
  preview?: boolean;
  /** Replaces the network fetcher (tests). */
  fetcher?: Fetcher;
  /** Replaces the LLM fact extractor (tests). */
  extractor?: FactExtractor;
  /** Replaces the LLM quote selector that drafts brief-only plans (tests). */
  quoteSelector?: QuoteSelector;
  /** Replaces the LLM that names the services on a discovery source's page (tests). */
  planLister?: PlanLister;
  /**
   * A discovery file (docs/19): official pages that list a company's services. The
   * plans are made from them on every run and follow the plans of the plans file.
   */
  discoverPath?: string;
  /**
   * The A8 brands file (docs/20): before the plans run, each brand's offers are made to match
   * what its program allows now, so an article carries a revenue link only when everything holds.
   */
  a8ProgramsPath?: string;
  /**
   * Names a change of the article generator (for example "figures-1"). Every live
   * article of the plans is regenerated once per revision (docs/04 "既存記事更新").
   */
  templateRevision?: string;
  /**
   * Preview only: after each plan's normal preview run, run the update path on the
   * article the preview just "published" (in memory), to see the regenerated draft.
   */
  previewUpdate?: boolean;
}

const TEMPLATE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The revision becomes part of a job key and a workflow input, so it is a short plain token. */
export function parseTemplateRevision(value: string): string {
  if (!TEMPLATE_REVISION_PATTERN.test(value)) {
    throw new Error(
      `template revision must be 1-64 characters of letters, digits, '.', '_' or '-' (starting with a letter or digit), got "${value}"`,
    );
  }
  return value;
}

export interface PipelineRunResult {
  mode: "dry-run" | "live";
  /** Freshness sweep done before the plans (live runs with a database only). */
  refresh?: { updateCandidates: string[]; revoked: string[] };
  /**
   * Plans that waited this run, counted by reason. Only counts: the run output goes
   * to a public log, and the plans themselves (slugs, companies) are private.
   * `plans-status` lists them on the owner's machine.
   */
  held?: Partial<Record<HoldReason, number>>;
  /** Plans made from discovery sources (docs/19), by count only for the same reason. */
  discovery?: DiscoverySummary;
  /** Offers of the A8 brands (docs/20) and how many may carry a link now; counts only, the programs are private. */
  a8Offers?: { offers: number; active: number };
  results: {
    slug: string;
    finalState: string;
    qaStatus: string;
    published: boolean;
    publishReason?: string;
    /** Failed QA checks (id + detail); present only for articles QA blocked. */
    qaFailures?: { id: string; status: string; detail: string }[];
    /** "pipeline" is a new article, "update" regenerates a live one. */
    action: "pipeline" | "update";
    /** Present for updates: updated | previewed | kept_previous | skipped. */
    update?: { outcome: string; trigger: string; reasons: string[]; commitSha?: string };
  }[];
  llmCostJpy: number;
}

const DEFAULT_EXTRACT_TIMEOUT_MS = 60_000;
const MIN_EXTRACT_TIMEOUT_MS = 1_000;

/**
 * Time allowed per fact-extraction call. A page is read in several windows and
 * each call writes dozens of facts, so slower model routes (a local CLI agent)
 * need more than the default; set LLM_EXTRACT_TIMEOUT_MS to raise it.
 */
export function extractTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.LLM_EXTRACT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_EXTRACT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_EXTRACT_TIMEOUT_MS) {
    throw new Error(
      `LLM_EXTRACT_TIMEOUT_MS must be an integer of at least ${MIN_EXTRACT_TIMEOUT_MS} (milliseconds), got "${raw}"`,
    );
  }
  return value;
}

function resolveInputPath(path: string): string {
  return isAbsolute(path) ? path : join(ROOT, path);
}

async function loadRepository(
  options: WorkerOptions,
  { requirePg }: { requirePg: boolean },
): Promise<Repository> {
  if (options.repo) return options.repo;
  const env = options.env ?? process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    if (requirePg) {
      throw new Error("DATABASE_URL is required for live operation (persistent state)");
    }
    return createMemoryRepository();
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const { runMigrations } = await import("@aff/db");
  await runMigrations(pool);
  return createPgRepository(pool);
}

/**
 * Builds the configured LLM provider. Two modes:
 * - openai-compatible (default): any OpenAI-compatible API (OpenAI, OpenRouter,
 *   Z.ai/GLM, ...) with mandatory per-token JPY rates.
 * - cli: shells out to a local coding-agent CLI (opencode run / claude -p /
 *   agy -p) with a mandatory conservative per-call cost allocation
 *   (subscriptions have no per-token price).
 * Returns null when the mode's env is incomplete; live mode refuses to run.
 */
function buildLlmFromEnv(env: NodeJS.ProcessEnv): OpenAiCompatibleProvider | CliLlmProvider | null {
  const mode = env.LLM_PROVIDER ?? "openai-compatible";
  if (mode === "cli") {
    const command = env.LLM_CLI_COMMAND;
    const cost = Number(env.LLM_CLI_COST_JPY_PER_CALL ?? NaN);
    if (!command || !Number.isFinite(cost) || cost <= 0) return null;
    let args: string[] | undefined;
    if (env.LLM_CLI_ARGS) {
      try {
        args = JSON.parse(env.LLM_CLI_ARGS) as string[];
      } catch {
        throw new Error("LLM_CLI_ARGS must be a JSON array, e.g. [\"run\",\"-m\",\"zai-coding-plan/glm-5.2\",\"{{PROMPT}}\"]");
      }
    }
    return new CliLlmProvider({
      providerId: `cli:${command}`,
      command,
      args,
      useStdin: env.LLM_CLI_STDIN === "1" || env.LLM_CLI_STDIN === "true",
      costJpyPerCall: cost,
    });
  }
  if (mode !== "openai-compatible") {
    throw new Error(`unknown LLM_PROVIDER: ${mode} (use "openai-compatible" or "cli")`);
  }
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_MODEL;
  const inputRate = Number(env.LLM_INPUT_COST_JPY_PER_1M ?? NaN);
  const outputRate = Number(env.LLM_OUTPUT_COST_JPY_PER_1M ?? NaN);
  if (!apiKey || !model || !Number.isFinite(inputRate) || !Number.isFinite(outputRate)) {
    return null;
  }
  if (inputRate <= 0 || outputRate <= 0) {
    throw new Error(
      "LLM cost rates must be positive numbers (JPY per 1M tokens); unpriceable calls are forbidden",
    );
  }
  const baseUrl = env.LLM_BASE_URL ?? "https://api.openai.com/v1";
  return new OpenAiCompatibleProvider({
    providerId: "openai-compatible",
    baseUrl,
    apiKey,
    model,
    inputCostJpyPer1m: inputRate,
    outputCostJpyPer1m: outputRate,
    reasoningEffort: baseUrl.includes("api.z.ai")
      ? env.LLM_REASONING_EFFORT === "high" || env.LLM_REASONING_EFFORT === "max"
        ? env.LLM_REASONING_EFFORT
        : "low"
      : undefined,
  });
}

export async function runLlmSmoke(env: NodeJS.ProcessEnv = process.env): Promise<{
  providerId: string;
  modelId: string;
  costJpy: number;
  output: { ok: true };
}> {
  const provider = buildLlmFromEnv(env);
  if (!provider) {
    throw new Error("LLM provider configuration is incomplete; check LLM_* variables/secrets");
  }
  const ledger = new BudgetLedger(100, 85);
  const gateway = createGateway({ primary: provider, backoffBaseMs: 1_500 }, ledger);
  const result = await gateway.generateStructured({
    task: "smoke-test",
    system: "Return only the requested JSON object. No extra text.",
    input: { request: "Return { ok: true } as JSON." },
    schema: z.object({ ok: z.literal(true) }),
    limits: { timeoutMs: 45_000, maxCostJpy: 100, attempts: 3, maxOutputTokens: 512 },
  });
  return {
    providerId: result.usage.providerId,
    modelId: result.usage.modelId,
    costJpy: result.usage.costJpy,
    output: result.output,
  };
}

function assertLiveReadiness(
  policy: PolicyConfig,
  env: NodeJS.ProcessEnv,
  { requireDatabase }: { requireDatabase: boolean },
): void {
  if (policy.mode !== "live") {
    throw new Error("live run refused: policy mode is not 'live'");
  }
  if (policy.security.allowed_source_domains.length === 0) {
    throw new Error("live run refused: security.allowed_source_domains is empty (configure verified domains first)");
  }
  if (requireDatabase && !env.DATABASE_URL) {
    throw new Error("live run refused: DATABASE_URL is not configured");
  }
  if (!buildLlmFromEnv(env)) {
    throw new Error(
      "live run refused: LLM_API_KEY / LLM_MODEL / LLM_INPUT_COST_JPY_PER_1M / LLM_OUTPUT_COST_JPY_PER_1M must be configured",
    );
  }
}

/**
 * Dry-run: fixture sources → facts → analysis → draft → QA → preview write.
 * No secrets, no network, no real publishing (docs/11 B023).
 */
export async function runDryRunPipeline(options: WorkerOptions): Promise<PipelineRunResult> {
  const clock = options.clock ?? (() => new Date());
  const policy = parsePolicyText(await readFile(resolveInputPath(options.policyPath), "utf8"));
  const repo = await loadRepository(options, { requirePg: false });
  const logger = options.logger ?? createLogger({ level: "info" });

  for (const program of offersFixture.programs) {
    await repo.offers.upsertProgram({
      id: program.id,
      provider: program.provider,
      status: program.status as "APPROVED" | "PENDING" | "REJECTED" | "TERMINATED",
      payoutCurrency: program.payoutCurrency,
      termsUrl: program.termsUrl,
      termsCheckedAt: program.termsCheckedAt,
    });
  }
  for (const offer of offersFixture.offers) {
    await repo.offers.upsertOffer(offer as AffiliateOffer);
  }

  const ledger = await createLedger(repo, policy, clock);
  const gateway = createGateway(
    { primary: new MockProvider("mock-primary", "mock-model", [mockJson({ facts: [] })]) },
    ledger,
  );
  void gateway;

  const fetcher = await buildFixtureFetcher();
  const previewDir = join(ROOT, options.outDir);
  await mkdir(previewDir, { recursive: true });

  const io = {
    async writeArtifact(path: string, content: string) {
      const target = join(previewDir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
  };

  const { results, held } = await runPlans(
    (plansFixture as PlansFile).plans,
    {
      repo,
      policy,
      logger,
      fetcher,
      extractor: new FixtureFactExtractor(),
      publisherIO: io,
      previewDir,
      clock,
    },
    { allowedDomains: policy.security.allowed_source_domains },
  );
  return { mode: "dry-run", results, ...(held.length > 0 ? { held: countHeld(held) } : {}), llmCostJpy: 0 };
}

/**
 * Live: real sources via allowlist, LLM fact extraction with budget guard,
 * artifacts committed to content/articles after a successful site build.
 * Every precondition is re-checked here (fail closed).
 */
export async function runLivePipeline(
  options: WorkerOptions,
  plansPath: string,
): Promise<PipelineRunResult> {
  const clock = options.clock ?? (() => new Date());
  const env = options.env ?? process.env;
  if (options.previewUpdate && !options.preview) {
    throw new Error("previewUpdate only applies to a preview run");
  }
  const templateRevision =
    options.templateRevision === undefined ? undefined : parseTemplateRevision(options.templateRevision);
  const parsedPolicy = parsePolicyText(await readFile(resolveInputPath(options.policyPath), "utf8"));
  // Preview can never publish, whatever the policy file says.
  const policyFromFile: PolicyConfig = options.preview
    ? { ...parsedPolicy, flags: { ...parsedPolicy.flags, publish_enabled: false } }
    : parsedPolicy;
  assertLiveReadiness(policyFromFile, env, { requireDatabase: options.preview !== true });
  const repo = options.preview
    ? (options.repo ?? createMemoryRepository())
    : await loadRepository(options, { requirePg: true });
  // Advertisers the run picked itself (docs/21) join the written ones while A8_SCOUT_ENABLED is "true" (the
  // stop switch: without it none of them is used), and their sites are allowed as sources only once the
  // account has joined their program.
  const writtenA8 =
    options.a8ProgramsPath === undefined
      ? undefined
      : parseA8ProgramsFile(await readFile(resolveInputPath(options.a8ProgramsPath), "utf8"));
  const scouted = writtenA8 && scoutingEnabled(env) ? scoutedInUse(writtenA8, await repo.scout.list()) : [];
  const policy = withScoutedDomains(policyFromFile, scouted);
  const logger = options.logger ?? createLogger({ level: "info" });

  const ledger = await createLedger(repo, policy, clock);
  const provider = buildLlmFromEnv(env)!;
  const gateway = createGateway({ primary: provider }, ledger);
  const extractor =
    options.extractor ??
    new LlmFactExtractor(gateway, {
      timeoutMs: extractTimeoutMs(env),
      maxCostJpy: policy.limits.max_job_cost_jpy,
      attempts: policy.limits.task_retry_attempts,
    });

  // A plan whose domain is not allowed yet is held, not an error: the stock may be
  // ahead of the owner's terms checks, and it must not stop the live articles' updates.
  const written = await readPlans(plansPath, { allowEmpty: options.discoverPath !== undefined });
  // A bad discovery file stops the run here, before any page is fetched.
  const discoverySources =
    options.discoverPath === undefined
      ? undefined
      : [...parseDiscoveryFile(await readFile(resolveInputPath(options.discoverPath), "utf8")), ...activeScoutedSources(scouted)];
  const a8Programs = writtenA8 ? withScoutedBrands(writtenA8, scouted) : undefined;
  // A plan kept as a brief takes its amounts from quotes of the official page (docs/18).
  const quoteSelector =
    options.quoteSelector ??
    new LlmQuoteSelector(gateway, {
      timeoutMs: extractTimeoutMs(env),
      maxCostJpy: policy.limits.max_job_cost_jpy,
      attempts: policy.limits.task_retry_attempts,
    });

  const fetcher = options.fetcher ?? new HttpFetcher();
  const discovered = discoverySources
    ? await discoverPlans(discoverySources, {
        repo,
        policy,
        clock,
        fetcher,
        lister:
          options.planLister ??
          new LlmPlanLister(gateway, {
            timeoutMs: extractTimeoutMs(env),
            maxCostJpy: policy.limits.max_job_cost_jpy,
            attempts: policy.limits.task_retry_attempts,
          }),
      })
    : undefined;
  // The written plans come first and win on a slug; what the pages list follows, in the pages' order.
  const plans = mergeDiscovered(written, discovered?.plans ?? []);
  // Offers follow the programs before any article is drafted, so a link appears only while the
  // program is joined, has a link and its rules are as they were read (docs/20).
  const a8Offers = a8Programs ? await ensureBrandOffers(repo, plans, a8Programs, policy, clock()) : undefined;

  const previewOnly = !policy.flags.publish_enabled;
  const livePreviewDir = join(ROOT, ".tmp/live-preview");
  const io = previewOnly
    ? {
        async writeArtifact(path: string, content: string) {
          const target = join(livePreviewDir, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, "utf8");
        },
      }
    : new LivePublisherIO({
        repoRoot: ROOT,
        contentDir: join(ROOT, "content/articles"),
        pushAfterCommit: env.LIVE_GIT_PUSH === "true",
        remoteRef: env.LIVE_GIT_REMOTE_REF ?? "main",
      });

  // A preview never publishes, so it never pays for an image.
  const heroImages = previewOnly ? undefined : createHeroImageService(env, { repo, policy, clock, logger, repoRoot: ROOT });
  const spendBefore = await repo.spend.sumMonth(dayKeyInTz(clock()).slice(0, 7));
  // Expired facts turn a live article into UPDATE_CANDIDATE; the plan loop below regenerates it.
  const refresh = options.preview ? undefined : await refreshSweep(repo, policy, clock());
  const { results, held } = await runPlans(
    plans,
    {
      repo,
      policy,
      logger,
      fetcher,
      extractor,
      quoteSelector,
      publisherIO: io,
      ...(heroImages ? { heroImages: heroImages.service } : {}),
      previewDir: previewOnly ? livePreviewDir : undefined,
      clock,
    },
    {
      allowedDomains: policy.security.allowed_source_domains,
      templateRevision,
      previewUpdate: options.previewUpdate === true,
    },
  );
  // Image spend is stored as it happens; the LLM spend below is what the ledger added on top.
  const llmCostJpy =
    (await repo.spend.sumMonth(dayKeyInTz(clock()).slice(0, 7))) - spendBefore - (heroImages?.imageCostJpy() ?? 0);
  const ledgerDelta = ledger.spentJpy - spendBefore;
  if (ledgerDelta > 0) {
    await repo.spend.recordSpend({
      date: dayKeyInTz(clock()),
      category: "llm",
      provider: provider.id,
      costJpy: ledgerDelta,
      source: "pipeline",
      estimated: true,
    });
  }
  return {
    mode: "live",
    ...(refresh ? { refresh } : {}),
    results,
    held: countHeld(held),
    ...(discovered ? { discovery: discovered.summary } : {}),
    ...(a8Offers ? { a8Offers } : {}),
    llmCostJpy: Math.max(llmCostJpy, ledgerDelta),
  };
}

async function readPlans(plansPath: string, options: { allowEmpty?: boolean } = {}): Promise<ArticlePlan[]> {
  const raw = JSON.parse(await readFile(resolveInputPath(plansPath), "utf8")) as PlansFile;
  if (!Array.isArray(raw.plans) || (raw.plans.length === 0 && !options.allowEmpty)) {
    throw new Error(`plans file has no plans: ${plansPath}`);
  }
  return raw.plans;
}

function countHeld(held: readonly HeldPlan[]): NonNullable<PipelineRunResult["held"]> {
  return held.reduce<NonNullable<PipelineRunResult["held"]>>(
    (counts, { reason }) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }),
    {},
  );
}

/**
 * Which plans of the stock can run with the current allowlist and which wait for
 * a domain, with names. No network, no database and no secrets: run it on the
 * machine that holds the plans file. (The daily cap is not shown: it depends on
 * what was published today.)
 */
export async function runPlansStatus(
  options: Pick<WorkerOptions, "policyPath">,
  plansPath: string,
): Promise<{ runnable: string[]; held: HeldPlan[] }> {
  const policy = parsePolicyText(await readFile(resolveInputPath(options.policyPath), "utf8"));
  const { runnable, held } = splitByAllowlist(await readPlans(plansPath), policy.security.allowed_source_domains);
  return { runnable: runnable.map((plan) => plan.slug), held };
}

async function createLedger(
  repo: Repository,
  policy: PolicyConfig,
  clock: () => Date,
): Promise<BudgetLedger> {
  const monthKey = dayKeyInTz(clock()).slice(0, 7);
  return new BudgetLedger(
    policy.limits.monthly_operating_cost_jpy,
    policy.limits.slow_down_threshold_percent,
    await repo.spend.sumMonth(monthKey),
  );
}

function toRunResult(outcome: PlanRunResult): PipelineRunResult["results"][number] {
  return {
    slug: outcome.slug,
    finalState: outcome.finalState,
    qaStatus: outcome.qaStatus,
    published: outcome.published,
    publishReason: outcome.publishReason,
    ...(outcome.qaFailures ? { qaFailures: outcome.qaFailures } : {}),
    action: outcome.action,
    ...(outcome.update
      ? {
          update: {
            outcome: outcome.update.outcome,
            trigger: outcome.update.trigger,
            reasons: outcome.update.reasons,
            ...(outcome.update.commitSha ? { commitSha: outcome.update.commitSha } : {}),
          },
        }
      : {}),
  };
}

async function runPlans(
  plans: ArticlePlan[],
  services: Parameters<typeof runPlan>[1],
  options: { allowedDomains: readonly string[]; templateRevision?: string; previewUpdate?: boolean },
): Promise<{ results: PipelineRunResult["results"]; held: HeldPlan[] }> {
  const queue = await runPlanQueue(plans, services, {
    allowedDomains: options.allowedDomains,
    templateRevision: options.templateRevision,
    // The preview run left the article "published" in memory; regenerate it as an update would.
    ...(options.previewUpdate
      ? {
          afterPlan: async (plan: ArticlePlan, outcome: PlanRunResult) =>
            outcome.published
              ? [await runPlan(plan, services, { templateRevision: options.templateRevision ?? "preview-update" })]
              : [],
        }
      : {}),
  });
  return { results: queue.results.map(toRunResult), held: queue.held };
}

async function buildFixtureFetcher(): Promise<MapFetcher> {
  const fixturesDir = join(ROOT, "config/fixtures");
  const responses = new Map<string, { body: string; contentType?: string; status?: number }>();
  const manifest = JSON.parse(await readFile(join(fixturesDir, "manifest.json"), "utf8")) as Record<
    string,
    string
  >;
  for (const [url, file] of Object.entries(manifest)) {
    new URL(url);
    responses.set(url, {
      body: await readFile(join(fixturesDir, file), "utf8"),
      contentType: "text/html; charset=utf-8",
    });
  }
  return new MapFetcher(responses);
}

export async function runRefresh(options: WorkerOptions): Promise<{ updateCandidates: string[]; revoked: string[] }> {
  const policy = parsePolicyText(await readFile(resolveInputPath(options.policyPath), "utf8"));
  const repo = await loadRepository(options, { requirePg: false });
  return refreshSweep(repo, policy, options.clock?.() ?? new Date());
}

export async function runGrowth(options: WorkerOptions): Promise<ReturnType<typeof growthPlan>> {
  const repo = await loadRepository(options, { requirePg: false });
  const items = await repo.content.listAll();
  return growthPlan(repo, items.map((i) => i.id));
}

export async function runMonthlyReport(options: WorkerOptions, yearMonth: string): Promise<string> {
  const repo = await loadRepository(options, { requirePg: false });
  const report = buildMonthlyReport({
    yearMonth,
    conversions: await repo.offers.listConversions(),
    payouts: await repo.offers.listPayouts(),
    spend: [],
  });
  return renderMonthlyReportMarkdown(report);
}

// ---- registries: offers / conversions / SERP capture ----

const registrySchema = z.object({
  programs: z.array(
    z.object({
      id: z.string().min(1),
      provider: z.string().min(1),
      status: z.enum(["PENDING", "APPROVED", "REJECTED", "TERMINATED"]),
      payoutCurrency: z.string().length(3),
      termsUrl: z.string().url().optional(),
      termsCheckedAt: z.string().datetime().optional(),
    }),
  ),
  offers: z.array(
    z.object({
      id: z.string().min(1),
      programId: z.string().min(1),
      verticalId: z.string().min(1),
      title: z.string().min(1),
      landingUrl: z.string().url().optional(),
      trackingUrlSecretRef: z.string().min(1).optional(),
      rewardModel: z.enum(["fixed_jpy", "rate_percent", "unknown"]),
      rewardAmountJpy: z.number().int().nonnegative().optional(),
      conversionEvent: z.string().min(1).optional(),
      channelPermissions: z.array(z.enum(["site", "search", "youtube", "x", "email"])),
      active: z.boolean(),
      status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
      constraints: z.record(z.union([z.string(), z.number(), z.boolean()])),
    }),
  ),
});

export interface RegistryImportResult {
  programs: number;
  offers: number;
}

/** Validates and stores the offer registry. Unapproved offers stay unusable. */
export async function importOffers(options: WorkerOptions, registryPath: string): Promise<RegistryImportResult> {
  const repo = await loadRepository(options, { requirePg: true });
  const parsed = registrySchema.safeParse(
    JSON.parse(await readFile(resolveInputPath(registryPath), "utf8")),
  );
  if (!parsed.success) {
    throw new Error(`offer registry invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  for (const program of parsed.data.programs) {
    await repo.offers.upsertProgram(program);
  }
  for (const offer of parsed.data.offers) {
    if (!parsed.data.programs.some((p) => p.id === offer.programId)) {
      throw new Error(`offer ${offer.id} references unknown program ${offer.programId}`);
    }
    await repo.offers.upsertOffer(offer);
  }
  return { programs: parsed.data.programs.length, offers: parsed.data.offers.length };
}

export interface ConversionImportResult {
  imported: number;
  skipped: number;
  duplicates: number;
  skippedReasons: string[];
}

export async function importConversions(
  options: WorkerOptions,
  csvPath: string,
): Promise<ConversionImportResult> {
  const repo = await loadRepository(options, { requirePg: true });
  const importer = new AspReportImporter(repo.offers);
  return importer.importCsv(await readFile(resolveInputPath(csvPath), "utf8"));
}

const serpSchema = z.array(
  z.object({
    id: z.string().min(1),
    keyword: z.string().min(1),
    capturedAt: z.string().datetime(),
    country: z.literal("JP"),
    language: z.literal("ja"),
    device: z.enum(["desktop", "mobile"]),
    position: z.number().int().min(1),
    url: z.string().url(),
    pageType: z.enum(["official", "corporate", "media", "personal", "comparison", "other"]),
    serpFeatures: z.array(z.string()),
    accessStatus: z.enum(["OK", "UNKNOWN"]),
  }),
);

/** B000B: records manually captured SERP observations (JP/ja, with timestamps). */
export async function importSerpObservations(
  options: WorkerOptions,
  observationsPath: string,
): Promise<number> {
  const repo = await loadRepository(options, { requirePg: true });
  const parsed = serpSchema.safeParse(
    JSON.parse(await readFile(resolveInputPath(observationsPath), "utf8")),
  );
  if (!parsed.success) {
    throw new Error(`SERP observations invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const observations: SerpObservation[] = parsed.data;
  await repo.serp.saveObservations(observations);
  return observations.length;
}

export async function runCheckRobots(url: string): Promise<unknown> {
  return checkRobots(new HttpFetcher(), url);
}

/**
 * What picking new advertisers needs besides the console (docs/21): the model that reads a price page, the
 * policy's limits, and a way to record what the model cost. The model's cost is booked like the pipeline's.
 */
async function buildScoutDeps(
  options: WorkerOptions,
  repo: Repository,
  fetcher: Fetcher,
  clock: () => Date,
): Promise<{ deps: ScoutDeps; recordSpend: () => Promise<void> }> {
  const env = options.env ?? process.env;
  const policy = parsePolicyText(await readFile(resolveInputPath(options.policyPath), "utf8"));
  const provider = buildLlmFromEnv(env);
  if (!provider) throw new Error("--scout needs the model: LLM_API_KEY / LLM_MODEL / LLM_INPUT_COST_JPY_PER_1M / LLM_OUTPUT_COST_JPY_PER_1M");
  const ledger = await createLedger(repo, policy, clock);
  const spendBefore = ledger.spentJpy;
  const lister = new LlmPlanLister(createGateway({ primary: provider }, ledger), {
    timeoutMs: extractTimeoutMs(env),
    maxCostJpy: policy.limits.max_job_cost_jpy,
    attempts: policy.limits.task_retry_attempts,
  });
  return {
    deps: {
      vet: (candidate) => vetAdvertiserSite(candidate, { fetcher, repo, policy, clock, lister }),
      maxVets: SCOUT_MAX_VETS,
      maxRegistered: SCOUT_MAX_REGISTERED,
    },
    async recordSpend() {
      const delta = ledger.spentJpy - spendBefore;
      if (delta > 0) {
        await repo.spend.recordSpend({
          date: dayKeyInTz(clock()),
          category: "llm",
          provider: provider.id,
          costJpy: delta,
          source: "a8-scout",
          estimated: true,
        });
      }
    },
  };
}

// ---- CLI ----

function isMain(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const { values, positionals } = parseArgs({
    options: {
      policy: { type: "string", default: "config/policy.dry-run.yaml" },
      out: { type: "string", default: ".tmp/preview" },
      month: { type: "string" },
      plans: { type: "string" },
      discover: { type: "string" },
      "a8-programs": { type: "string" },
      scout: { type: "boolean", default: false },
      dist: { type: "string" },
      live: { type: "boolean", default: false },
      preview: { type: "boolean", default: false },
      "template-revision": { type: "string" },
      "preview-update": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] ?? "run-pipeline";
  const arg = positionals[1];
  if (values.preview && !values.live) {
    throw new Error("--preview only applies to a live run (use it with --live)");
  }
  if (values["preview-update"] && !values.preview) {
    throw new Error("--preview-update only applies to a preview run (use it with --live --preview)");
  }
  if (values.discover !== undefined && !values.live) {
    throw new Error("--discover only applies to a live run (use it with --live)");
  }
  if (values["a8-programs"] !== undefined && !values.live && command !== "a8-sync" && command !== "a8-submit-urls" && command !== "a8-scout") {
    throw new Error("--a8-programs only applies to a live run, a8-sync, a8-submit-urls or a8-scout");
  }
  if (values.scout && command !== "a8-sync") {
    throw new Error("--scout only applies to a8-sync");
  }
  if (values["template-revision"] !== undefined && !values.live) {
    throw new Error("--template-revision only applies to a live run (use it with --live)");
  }
  const options: WorkerOptions = {
    policyPath: values.policy ?? "config/policy.dry-run.yaml",
    outDir: values.out ?? ".tmp/preview",
    ...(values.preview ? { preview: true } : {}),
    ...(values["preview-update"] ? { previewUpdate: true } : {}),
    ...(values.discover !== undefined ? { discoverPath: values.discover } : {}),
    ...(values["a8-programs"] !== undefined && values.live ? { a8ProgramsPath: values["a8-programs"] } : {}),
    ...(values["template-revision"] !== undefined ? { templateRevision: values["template-revision"] } : {}),
  };
  try {
    options.logger = createLogger({ level: "info", sink: (line) => process.stderr.write(`${line}\n`) });
    if (command === "run-pipeline") {
      const result = values.live
        ? await runLivePipeline(options, values.plans ?? "config/plans.live.json")
        : await runDryRunPipeline(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (command === "plans-status") {
      process.stdout.write(
        `${JSON.stringify(await runPlansStatus(options, values.plans ?? "config/plans.live.json"), null, 2)}\n`,
      );
    } else if (command === "import-offers") {
      if (!arg) throw new Error("usage: import-offers <registry.json>");
      process.stdout.write(`${JSON.stringify(await importOffers(options, arg), null, 2)}\n`);
    } else if (command === "import-conversions") {
      if (!arg) throw new Error("usage: import-conversions <report.csv>");
      process.stdout.write(`${JSON.stringify(await importConversions(options, arg), null, 2)}\n`);
    } else if (command === "serp-import") {
      if (!arg) throw new Error("usage: serp-import <observations.json>");
      process.stdout.write(`${JSON.stringify(await importSerpObservations(options, arg), null, 2)}\n`);
    } else if (command === "check-robots") {
      if (!arg) throw new Error("usage: check-robots <page-url>");
      process.stdout.write(`${JSON.stringify(await runCheckRobots(arg), null, 2)}\n`);
    } else if (command === "llm-smoke") {
      process.stdout.write(`${JSON.stringify(await runLlmSmoke(options.env ?? process.env), null, 2)}\n`);
    } else if (command === "image-smoke") {
      const smoke = await runImageSmoke(options.env ?? process.env, {
        verticalId: arg ?? "water_delivery",
        outDir: join(ROOT, options.outDir),
      });
      process.stdout.write(`${JSON.stringify(smoke, null, 2)}\n`);
    } else if (command === "a8-login-smoke") {
      const smoke = await runA8LoginSmoke(options.env ?? process.env);
      process.stdout.write(`${JSON.stringify(smoke, null, 2)}\n`);
      if (smoke.outcome !== "logged_in") process.exit(1);
    } else if (command === "a8-programs") {
      const { probe, ...report } = await runA8Programs(options.env ?? process.env);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      for (const [list, lines] of Object.entries(probe ?? {})) {
        process.stdout.write(`--- ${list}: page structure (content masked) ---\n${lines.join("\n")}\n`);
      }
      if (report.outcome !== "ok") process.exit(1);
    } else if (command === "a8-inspect-program") {
      const { probe, ...report } = await runA8Inspect(options.env ?? process.env);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      for (const [page, lines] of Object.entries(probe ?? {})) {
        process.stdout.write(`--- ${page}: page structure (content masked) ---\n${lines.join("\n")}\n`);
      }
      if (report.outcome !== "ok") process.exit(1);
    } else if (command === "a8-apply-start") {
      const { probe, ...report } = await runA8Apply(options.env ?? process.env);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (probe) process.stdout.write(`--- page reached: structure (content masked) ---\n${probe.join("\n")}\n`);
      if (report.outcome !== "reached") process.exit(1);
    } else if (command === "a8-link-probe") {
      const { probe, ...report } = await runA8LinkProbe(options.env ?? process.env);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (probe) process.stdout.write(`--- ad-link page: structure (content masked) ---\n${probe.join("\n")}\n`);
      if (report.outcome !== "ok") process.exit(1);
    } else if (command === "a8-sync") {
      const config = parseA8ProgramsFile(
        await readFile(resolveInputPath(values["a8-programs"] ?? "config/a8-programs.json"), "utf8"),
      );
      const repo = await loadRepository(options, { requirePg: true });
      const fetcher = new HttpFetcher();
      const clock = () => new Date();
      const scout = values.scout ? await buildScoutDeps(options, repo, fetcher, clock) : undefined;
      let report;
      try {
        report = await runA8Sync(options.env ?? process.env, {
          config,
          repo,
          fetcher,
          clock,
          ...(scout ? { scout: scout.deps } : {}),
        });
      } finally {
        await scout?.recordSpend();
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.outcome !== "ok") process.exit(1);
    } else if (command === "a8-scout") {
      const config = parseA8ProgramsFile(
        await readFile(resolveInputPath(values["a8-programs"] ?? "config/a8-programs.json"), "utf8"),
      );
      const { probe, ...report } = await runA8Scout(
        options.env ?? process.env,
        config.brands.map((brand) => brand.keyword),
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (probe) process.stdout.write(`--- detail page: structure (content masked) ---\n${probe.join("\n")}\n`);
      if (report.outcome !== "ok") process.exit(1);
    } else if (command === "a8-submit-urls") {
      const written = parseA8ProgramsFile(
        await readFile(resolveInputPath(values["a8-programs"] ?? "config/a8-programs.json"), "utf8"),
      );
      const repo = await loadRepository(options, { requirePg: true });
      const submitEnv = options.env ?? process.env;
      const report = await runA8SubmitUrls(submitEnv, {
        config: scoutingEnabled(submitEnv) ? withScoutedBrands(written, await repo.scout.list()) : written,
        distDir: resolveInputPath(values.dist ?? "apps/site/dist"),
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.outcome === "login_failed") process.exit(1);
    } else if (command === "export-go-offers") {
      const report = await exportGoOffers(
        await loadRepository(options, { requirePg: true }),
        resolveInputPath(arg ?? "content/go-offers.generated.json"),
        // Copied into the site's output as it is (public/): the host's redirect rules for /go/.
        resolveInputPath("apps/site/public/_redirects"),
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (command === "a8-adurl-probe") {
      const { probe, secondTab, ...report } = await runA8AdUrlProbe(options.env ?? process.env);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (probe) process.stdout.write(`--- ad-URL management: structure (content masked) ---\n${probe.join("\n")}\n`);
      if (secondTab) process.stdout.write(`--- ad-URL management, second tab: structure (content masked) ---\n${secondTab.join("\n")}\n`);
      if (report.outcome !== "ok") process.exit(1);
    } else if (command === "a8-export-approved") {
      const { encrypted, ...report } = await runA8ExportApproved(options.env ?? process.env);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (encrypted) process.stdout.write(`ENCRYPTED:${encrypted}\n`);
      if (report.outcome !== "ok") process.exit(1);
    } else if (command === "refresh") {
      process.stdout.write(`${JSON.stringify(await runRefresh(options), null, 2)}\n`);
    } else if (command === "growth") {
      process.stdout.write(`${JSON.stringify(await runGrowth(options), null, 2)}\n`);
    } else if (command === "report") {
      process.stdout.write(`${await runMonthlyReport(options, values.month ?? dayKeyInTz(new Date()).slice(0, 7))}\n`);
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    process.stderr.write(`worker failed: ${String(error)}\n`);
    process.exit(1);
  }
}
