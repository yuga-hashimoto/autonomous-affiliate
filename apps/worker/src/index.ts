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
  runArticlePipeline,
  refreshSweep,
  growthPlan,
  FixtureFactExtractor,
  LlmFactExtractor,
  type FactExtractor,
  type ArticlePlan,
} from "@aff/agents";
import { AspReportImporter, HttpFetcher, MapFetcher, checkRobots, type Fetcher } from "@aff/integrations";
import { buildMonthlyReport, renderMonthlyReportMarkdown } from "@aff/analytics";
import { LivePublisherIO } from "./live-io.js";
import plansFixture from "../../../config/plans.dry-run.json" with { type: "json" };
import offersFixture from "../../../config/offers.dry-run.json" with { type: "json" };

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
}

export interface PipelineRunResult {
  mode: "dry-run" | "live";
  results: {
    slug: string;
    finalState: string;
    qaStatus: string;
    published: boolean;
    publishReason?: string;
    /** Failed QA checks (id + detail); present only for articles QA blocked. */
    qaFailures?: { id: string; status: string; detail: string }[];
  }[];
  llmCostJpy: number;
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

  const results = await runPlans((plansFixture as PlansFile).plans, {
    repo,
    policy,
    logger,
    fetcher,
    extractor: new FixtureFactExtractor(),
    publisherIO: io,
    previewDir,
    clock,
  });
  return { mode: "dry-run", results, llmCostJpy: 0 };
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
  const parsedPolicy = parsePolicyText(await readFile(resolveInputPath(options.policyPath), "utf8"));
  // Preview can never publish, whatever the policy file says.
  const policy: PolicyConfig = options.preview
    ? { ...parsedPolicy, flags: { ...parsedPolicy.flags, publish_enabled: false } }
    : parsedPolicy;
  assertLiveReadiness(policy, env, { requireDatabase: options.preview !== true });
  const repo = options.preview
    ? (options.repo ?? createMemoryRepository())
    : await loadRepository(options, { requirePg: true });
  const logger = options.logger ?? createLogger({ level: "info" });

  const ledger = await createLedger(repo, policy, clock);
  const provider = buildLlmFromEnv(env)!;
  const gateway = createGateway({ primary: provider }, ledger);
  const extractor =
    options.extractor ??
    new LlmFactExtractor(gateway, {
      timeoutMs: 60_000,
      maxCostJpy: policy.limits.max_job_cost_jpy,
      attempts: policy.limits.task_retry_attempts,
    });

  const plansRaw = JSON.parse(await readFile(resolveInputPath(plansPath), "utf8")) as PlansFile;
  if (!Array.isArray(plansRaw.plans) || plansRaw.plans.length === 0) {
    throw new Error(`plans file has no plans: ${plansPath}`);
  }
  for (const url of plansRaw.plans.flatMap((p) => p.sourceUrls)) {
    const host = new URL(url).hostname.toLowerCase();
    const allowed = policy.security.allowed_source_domains.some(
      (d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`),
    );
    if (!allowed) {
      throw new Error(`plan source ${url} is not in the policy allowlist; run check-robots and update the policy first`);
    }
  }

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

  const spendBefore = await repo.spend.sumMonth(dayKeyInTz(clock()).slice(0, 7));
  const results = await runPlans(plansRaw.plans, {
    repo,
    policy,
    logger,
    fetcher: options.fetcher ?? new HttpFetcher(),
    extractor,
    publisherIO: io,
    previewDir: previewOnly ? livePreviewDir : undefined,
    clock,
  });
  const llmCostJpy = (await repo.spend.sumMonth(dayKeyInTz(clock()).slice(0, 7))) - spendBefore;
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
  return { mode: "live", results, llmCostJpy: Math.max(llmCostJpy, ledgerDelta) };
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

async function runPlans(
  plans: ArticlePlan[],
  services: Parameters<typeof runArticlePipeline>[1],
): Promise<PipelineRunResult["results"]> {
  const results: PipelineRunResult["results"] = [];
  for (const plan of plans) {
    const outcome = await runArticlePipeline(plan, services);
    results.push({
      slug: outcome.slug,
      finalState: outcome.finalState,
      qaStatus: outcome.qaStatus,
      published: outcome.published,
      publishReason: outcome.publishReason,
      ...(outcome.qaFailures ? { qaFailures: outcome.qaFailures } : {}),
    });
  }
  return results;
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
      live: { type: "boolean", default: false },
      preview: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] ?? "run-pipeline";
  const arg = positionals[1];
  if (values.preview && !values.live) {
    throw new Error("--preview only applies to a live run (use it with --live)");
  }
  const options: WorkerOptions = {
    policyPath: values.policy ?? "config/policy.dry-run.yaml",
    outDir: values.out ?? ".tmp/preview",
    ...(values.preview ? { preview: true } : {}),
  };
  try {
    options.logger = createLogger({ level: "info", sink: (line) => process.stderr.write(`${line}\n`) });
    if (command === "run-pipeline") {
      const result = values.live
        ? await runLivePipeline(options, values.plans ?? "config/plans.live.json")
        : await runDryRunPipeline(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
