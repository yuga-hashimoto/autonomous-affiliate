import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MapFetcher } from "@aff/integrations";
import { FixtureFactExtractor } from "@aff/agents";
import { createMemoryRepository } from "@aff/db";
import { extractTimeoutMs, parseTemplateRevision, runLivePipeline, runPlansStatus } from "../../apps/worker/src/index.js";
import { readFileSync } from "./helpers.js";

const ROOT = path.resolve(__dirname, "../..");
const TMP = path.join(ROOT, ".tmp/live-preview-test");
const PREVIEW_DIR = path.join(ROOT, ".tmp/live-preview");
const PAGE_URL = "https://sim-a.example.com/price";
const SLUG = "preview-mode-sim";

const LLM_ENV = {
  LLM_API_KEY: "test-key-never-used",
  LLM_MODEL: "test-model",
  LLM_INPUT_COST_JPY_PER_1M: "30",
  LLM_OUTPUT_COST_JPY_PER_1M: "100",
};

const PAGE = `<html><body><p>SIM A 20GB</p>
  <script type="application/x-aff-facts">[
    {"text":"SIM A 20GBの月額基本料は2980円","claimType":"price"},
    {"text":"SIM Aの事務手数料は3300円","claimType":"price"}
  ]</script></body></html>`;

const PLANS = {
  plans: [
    {
      slug: SLUG,
      title: "プレビュー確認",
      audience: "a",
      purpose: "p",
      verticalId: "mobile",
      keyword: "k",
      sourceUrls: [PAGE_URL],
      calculators: [
        {
          calculator: "sim",
          input: { offerId: "offer-x", title: "SIM A 20GB", monthlyJpy: 2980, dataGb: 20, initialFeeJpy: 3300, months: 24 },
          factEvidenceTerms: ["SIM A"],
        },
      ],
      offerIds: [],
    },
  ],
};

/** A live policy that would publish to git if it were honoured. */
function livePolicyText(): string {
  const example = readFileSync(new URL("../../config/policy.live.example.yaml", import.meta.url), "utf8");
  return example
    .replace("allowed_source_domains: []", "allowed_source_domains: [sim-a.example.com]")
    .replace("publish_enabled: false", "publish_enabled: true");
}

describe("live pipeline in preview mode", () => {
  const policyPath = path.join(TMP, "policy.yaml");
  const plansPath = path.join(TMP, "plans.json");
  const seams = {
    fetcher: new MapFetcher(new Map([[PAGE_URL, { body: PAGE }]])),
    extractor: new FixtureFactExtractor(),
  };

  beforeAll(async () => {
    await rm(TMP, { recursive: true, force: true });
    await rm(PREVIEW_DIR, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
    await writeFile(policyPath, livePolicyText(), "utf8");
    await writeFile(plansPath, JSON.stringify(PLANS), "utf8");
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
    await rm(PREVIEW_DIR, { recursive: true, force: true });
  });

  it("refuses a normal live run without a database", async () => {
    await expect(
      runLivePipeline({ policyPath, outDir: ".tmp/unused", env: { ...LLM_ENV }, ...seams }, plansPath),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it("runs on real-page seams with no database, writes only a preview and never touches the article store", async () => {
    const result = await runLivePipeline(
      { policyPath, outDir: ".tmp/unused", env: { ...LLM_ENV, LIVE_GIT_PUSH: "true" }, preview: true, ...seams },
      plansPath,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ slug: SLUG, qaStatus: "PASS", finalState: "PUBLISHED" });

    const previewFiles = await readdir(path.join(PREVIEW_DIR, "content/articles"));
    expect(previewFiles.some((name) => name.startsWith(SLUG))).toBe(true);
    const stored = await readFile(path.join(PREVIEW_DIR, "content/articles", previewFiles[0]!), "utf8");
    expect(stored).toContain("SIM A 20GB");

    // publish_enabled: true in the policy was ignored: nothing reached the real article store
    const articles = await readdir(path.join(ROOT, "content/articles")).catch(() => [] as string[]);
    expect(articles.some((name) => name.startsWith(SLUG))).toBe(false);
  });
});

describe("update path in the live pipeline worker", () => {
  const policyPath = path.join(TMP, "update-policy.yaml");
  const plansPath = path.join(TMP, "update-plans.json");
  const seams = {
    fetcher: new MapFetcher(new Map([[PAGE_URL, { body: PAGE }]])),
    extractor: new FixtureFactExtractor(),
  };
  const T0 = new Date("2026-10-27T04:44:25.000Z");

  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    const example = readFileSync(new URL("../../config/policy.live.example.yaml", import.meta.url), "utf8");
    await writeFile(
      policyPath,
      example.replace("allowed_source_domains: []", "allowed_source_domains: [sim-a.example.com]"),
      "utf8",
    );
    await writeFile(plansPath, JSON.stringify(PLANS), "utf8");
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
    await rm(PREVIEW_DIR, { recursive: true, force: true });
  });

  it("--preview-update regenerates the article the preview just made and shows the figures", async () => {
    const result = await runLivePipeline(
      { policyPath, outDir: ".tmp/unused", env: { ...LLM_ENV }, preview: true, previewUpdate: true, clock: () => T0, ...seams },
      plansPath,
    );

    expect(result.results.map((r) => [r.action, r.update?.outcome ?? null])).toEqual([
      ["pipeline", null],
      ["update", "previewed"],
    ]);
    expect(result.results[1]).toMatchObject({ slug: SLUG, qaStatus: "PASS", published: true });
    expect(result.refresh).toBeUndefined();
    const previewFile = path.join(PREVIEW_DIR, "content/articles", `${SLUG}.ja-JP.md`);
    expect(await readFile(previewFile, "utf8")).toContain("```chart");
  });

  it("a preview-update outside a preview, and a malformed template revision, are refused", async () => {
    await expect(
      runLivePipeline({ policyPath, outDir: ".tmp/unused", env: { ...LLM_ENV, DATABASE_URL: "x" }, previewUpdate: true, ...seams }, plansPath),
    ).rejects.toThrow(/previewUpdate/);
    await expect(
      runLivePipeline(
        { policyPath, outDir: ".tmp/unused", env: { ...LLM_ENV }, preview: true, templateRevision: "bad revision;", ...seams },
        plansPath,
      ),
    ).rejects.toThrow(/template revision/);
    expect(parseTemplateRevision("figures-1")).toBe("figures-1");
    for (const bad of ["", " ", "-x", "a b", "a/b", "x".repeat(65)]) {
      expect(() => parseTemplateRevision(bad), JSON.stringify(bad)).toThrow(/template revision/);
    }
  });

  it("a daily run sweeps for stale facts first and routes the stale article to the update path", async () => {
    const repo = createMemoryRepository();
    const run = (now: Date) =>
      runLivePipeline(
        { policyPath, outDir: ".tmp/unused", env: { ...LLM_ENV, DATABASE_URL: "unused-with-injected-repo" }, repo, clock: () => now, ...seams },
        plansPath,
      );

    const first = await run(T0);
    expect(first.results[0]).toMatchObject({ slug: SLUG, action: "pipeline", finalState: "PUBLISHED" });
    expect(first.refresh).toEqual({ updateCandidates: [], revoked: [] });

    const later = await run(new Date(T0.getTime() + 8 * 86_400_000));
    expect(later.refresh).toEqual({ updateCandidates: [SLUG], revoked: [] });
    // publishing is off in this policy, so the update is a preview and the item keeps waiting
    expect(later.results[0]).toMatchObject({
      slug: SLUG,
      action: "update",
      qaStatus: "PASS",
      update: { outcome: "previewed", trigger: "stale" },
    });
    expect((await repo.content.getBySlug(SLUG, "ja-JP"))?.state).toBe("UPDATE_CANDIDATE");
  });
});

describe("extraction timeout setting", () => {
  it("defaults to 60 seconds and can be raised for slower model routes", () => {
    expect(extractTimeoutMs({})).toBe(60_000);
    expect(extractTimeoutMs({ LLM_EXTRACT_TIMEOUT_MS: "" })).toBe(60_000);
    expect(extractTimeoutMs({ LLM_EXTRACT_TIMEOUT_MS: "180000" })).toBe(180_000);
  });

  it("rejects values that are not a sensible number of milliseconds", () => {
    for (const bad of ["abc", "0", "-5", "999", "1.5", "60s"]) {
      expect(() => extractTimeoutMs({ LLM_EXTRACT_TIMEOUT_MS: bad })).toThrow(/LLM_EXTRACT_TIMEOUT_MS/);
    }
  });
});

describe("a stock of plans in the live pipeline worker", () => {
  const policyPath = path.join(TMP, "stock-policy.yaml");
  const plansPath = path.join(TMP, "stock-plans.json");
  const WAITING_SLUG = "waiting-for-terms-check";
  const WAITING_HOST = "other-company.example.org";
  const seams = {
    fetcher: new MapFetcher(new Map([[PAGE_URL, { body: PAGE }]])),
    extractor: new FixtureFactExtractor(),
  };

  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    const example = readFileSync(new URL("../../config/policy.live.example.yaml", import.meta.url), "utf8");
    await writeFile(
      policyPath,
      example.replace("allowed_source_domains: []", "allowed_source_domains: [sim-a.example.com]"),
      "utf8",
    );
    const waiting = { ...PLANS.plans[0]!, slug: WAITING_SLUG, sourceUrls: [`https://${WAITING_HOST}/price`] };
    await writeFile(plansPath, JSON.stringify({ plans: [PLANS.plans[0], waiting] }), "utf8");
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
    await rm(PREVIEW_DIR, { recursive: true, force: true });
  });

  it("holds a plan whose company is not allowed yet instead of stopping the run", async () => {
    const result = await runLivePipeline(
      { policyPath, outDir: ".tmp/unused", env: { ...LLM_ENV }, preview: true, ...seams },
      plansPath,
    );

    expect(result.results.map((r) => r.slug)).toEqual([SLUG]);
    expect(result.held).toEqual({ domain_not_allowlisted: 1 });
  });

  it("reports only counts, because the run output goes to a public log", async () => {
    const result = await runLivePipeline(
      { policyPath, outDir: ".tmp/unused", env: { ...LLM_ENV }, preview: true, ...seams },
      plansPath,
    );

    const printed = JSON.stringify(result);
    expect(printed).not.toContain(WAITING_SLUG);
    expect(printed).not.toContain(WAITING_HOST);
  });

  it("plans-status lists what waits and why, for the owner's own machine", async () => {
    const status = await runPlansStatus({ policyPath }, plansPath);

    expect(status.runnable).toEqual([SLUG]);
    expect(status.held).toEqual([
      { slug: WAITING_SLUG, reason: "domain_not_allowlisted", detail: expect.stringContaining(WAITING_HOST) },
    ]);
  });
});
