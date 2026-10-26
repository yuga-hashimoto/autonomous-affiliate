import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { createLogger, parsePolicyText } from "@aff/domain";
import { MapFetcher } from "@aff/integrations";
import { runArticlePipeline, type ArticlePlan } from "@aff/agents";
import { readFileSync } from "./helpers.js";

const policy = parsePolicyText(
  readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"),
);

function services() {
  return {
    repo: createMemoryRepository(),
    policy,
    logger: createLogger({ level: "error", sink: () => undefined }),
    fetcher: new MapFetcher(new Map()),
    extractor: { extract: async () => [] },
    publisherIO: { writeArtifact: async () => undefined },
  };
}

const unknownPricePlan: ArticlePlan = {
  slug: "diagnostics-unknown-price",
  title: "UNKNOWN比較",
  audience: "a",
  purpose: "p",
  verticalId: "mobile",
  keyword: "k",
  sourceUrls: [],
  calculators: [
    {
      calculator: "sim",
      input: { offerId: "o", title: "UNKNOWN SIM", monthlyJpy: "UNKNOWN", dataGb: 20, initialFeeJpy: 0, months: 12 },
    },
  ],
  offerIds: [],
};

describe("QA failure diagnostics in the pipeline result", () => {
  it("lists every failed check with its id and detail when QA blocks an article", async () => {
    const outcome = await runArticlePipeline(unknownPricePlan, services());

    expect(outcome.published).toBe(false);
    expect(outcome.publishReason).toBe("qa_FAIL");
    expect(outcome.qaFailures).toBeDefined();
    const failures = outcome.qaFailures ?? [];
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.status).not.toBe("PASS");
      expect(failure.id).toMatch(/^[a-z_0-9]+$/);
      expect(failure.detail.length).toBeGreaterThan(0);
    }
    const ids = failures.map((f) => f.id);
    // no source was collected, so the claim is unevidenced; the UNKNOWN total is flagged too
    expect(ids).toContain("claims_all_evidenced");
    expect(ids).toContain("unknown_not_presented_as_fact");
  });
});
