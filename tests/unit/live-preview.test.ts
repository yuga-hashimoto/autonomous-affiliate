import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MapFetcher } from "@aff/integrations";
import { FixtureFactExtractor } from "@aff/agents";
import { runLivePipeline } from "../../apps/worker/src/index.js";
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
