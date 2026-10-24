import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createLogger,
  dayKeyInTz,
  parsePolicyText,
  newId,
  type AffiliateOffer,
  type PolicyConfig,
} from "@aff/domain";
import { createMemoryRepository, type Repository } from "@aff/db";
import { BudgetLedger, MockProvider, createGateway, mockJson } from "@aff/llm";
import {
  runArticlePipeline,
  refreshSweep,
  growthPlan,
  FixtureFactExtractor,
  type ArticlePlan,
} from "@aff/agents";
import { MapFetcher } from "@aff/integrations";
import { buildMonthlyReport, renderMonthlyReportMarkdown } from "@aff/analytics";
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
}

export interface PipelineRunResult {
  results: {
    slug: string;
    finalState: string;
    qaStatus: string;
    published: boolean;
    publishReason?: string;
  }[];
  publishedPreviews: string[];
}

/**
 * Executes the B023 vertical slice entirely offline:
 * fixture sources → fact extraction → analysis → draft → QA → preview write.
 * No secrets, no external accounts, no real publishing (docs/11).
 */
export async function runDryRunPipeline(options: WorkerOptions): Promise<PipelineRunResult> {
  const clock = options.clock ?? (() => new Date());
  const policy = parsePolicyText(await readFile(join(ROOT, options.policyPath), "utf8"));
  const repo = options.repo ?? createMemoryRepository();
  const logger = options.logger ?? createLogger({ level: "info" });

  // Offers/programs are only usable when approved in the registry fixture.
  for (const program of offersFixture.programs) {
    await repo.offers.upsertProgram({
      id: program.id,
      provider: program.provider,
      status: program.status as "APPROVED" | "PENDING" | "REJECTED" | "TERMINATED",
      payoutCurrency: program.payoutCurrency,
    });
  }
  for (const offer of offersFixture.offers) {
    await repo.offers.upsertOffer(offer as AffiliateOffer);
  }

  // Budget ledger starts from the persisted month spend (0 in dry-run).
  const monthKey = dayKeyInTz(clock()).slice(0, 7);
  const ledger = new BudgetLedger(
    policy.limits.monthly_operating_cost_jpy,
    policy.limits.slow_down_threshold_percent,
    await repo.spend.sumMonth(monthKey),
  );
  // The gateway exists for future LLM-assisted steps; the deterministic
  // fixture extractor keeps the dry-run free of any model call.
  const gateway = createGateway(
    { primary: new MockProvider("mock-primary", "mock-model", [mockJson({ facts: [] })]) },
    ledger,
  );
  void gateway;

  const fetcher = await buildFixtureFetcher(policy);
  const previewDir = join(ROOT, options.outDir);
  await mkdir(previewDir, { recursive: true });

  const io = {
    async writeArtifact(path: string, content: string) {
      const target = join(previewDir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
  };

  const results: PipelineRunResult["results"] = [];
  for (const plan of (plansFixture as PlansFile).plans) {
    const outcome = await runArticlePipeline(plan, {
      repo,
      policy,
      logger,
      fetcher,
      extractor: new FixtureFactExtractor(),
      publisherIO: io,
      previewDir,
      clock,
    });
    results.push({
      slug: outcome.slug,
      finalState: outcome.finalState,
      qaStatus: outcome.qaStatus,
      published: outcome.published,
      publishReason: outcome.publishReason,
    });
  }
  void newId; // ids are minted inside the pipeline; kept for future scheduling tasks
  return { results, publishedPreviews: [] };
}

async function buildFixtureFetcher(policy: PolicyConfig): Promise<MapFetcher> {
  const fixturesDir = join(ROOT, "config/fixtures");
  const responses = new Map<string, { body: string; contentType?: string; status?: number }>();
  const manifest = JSON.parse(await readFile(join(fixturesDir, "manifest.json"), "utf8")) as Record<
    string,
    string
  >;
  for (const [url, file] of Object.entries(manifest)) {
    // Only fixture hosts in the policy allowlist may be wired.
    new URL(url); // throws on malformed fixture manifest entries
    responses.set(url, { body: await readFile(join(fixturesDir, file), "utf8"), contentType: "text/html; charset=utf-8" });
  }
  void policy;
  return new MapFetcher(responses);
}

export async function runRefresh(options: WorkerOptions): Promise<{ updateCandidates: string[]; revoked: string[] }> {
  const policy = parsePolicyText(await readFile(join(ROOT, options.policyPath), "utf8"));
  const repo = options.repo ?? createMemoryRepository();
  return refreshSweep(repo, policy, options.clock?.() ?? new Date());
}

export async function runGrowth(options: WorkerOptions): Promise<ReturnType<typeof growthPlan>> {
  const repo = options.repo ?? createMemoryRepository();
  const items = await repo.content.listAll();
  return growthPlan(repo, items.map((i) => i.id));
}

export async function runMonthlyReport(options: WorkerOptions, yearMonth: string): Promise<string> {
  const repo = options.repo ?? createMemoryRepository();
  const report = buildMonthlyReport({
    yearMonth,
    conversions: await repo.offers.listConversions(),
    payouts: await repo.offers.listPayouts(),
    spend: [],
  });
  return renderMonthlyReportMarkdown(report);
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
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] ?? "run-pipeline";
  const options: WorkerOptions = {
    policyPath: values.policy ?? "config/policy.dry-run.yaml",
    outDir: values.out ?? ".tmp/preview",
  };
  try {
    // Logs go to stderr; stdout carries only the machine-readable result.
    options.logger = createLogger({ level: "info", sink: (line) => process.stderr.write(`${line}\n`) });
    if (command === "run-pipeline") {
      const result = await runDryRunPipeline(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
