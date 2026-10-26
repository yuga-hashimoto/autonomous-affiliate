import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { createLogger, parsePolicyText, type Fact } from "@aff/domain";
import { MapFetcher } from "@aff/integrations";
import { FixtureFactExtractor, checkPlanEvidence, runArticlePipeline, type ArticlePlan } from "@aff/agents";
import { readFileSync } from "./helpers.js";

const NOW = "2026-10-26T00:00:00.000Z";

function fact(id: string, text: string, claimType: Fact["claimType"] = "price"): Fact {
  return { id, text, claimType, sourceIds: ["src"], verifiedAt: NOW, confidence: 1, verificationStatus: "VERIFIED" };
}

function waterPlan(input: Record<string, unknown>, extra: Record<string, unknown> = {}): Pick<ArticlePlan, "calculators"> {
  return {
    calculators: [
      {
        calculator: "water",
        input: { offerId: "offer-a", title: "サーバーA", months: 12, monthlyLiters: 24, ...input },
        factEvidenceTerms: ["サーバーA"],
        ...extra,
      },
    ],
  };
}

describe("checkPlanEvidence", () => {
  const facts = [
    fact("f1", "サーバーA 12L ボトル: 1本 1,620円（税込）"),
    fact("f2", "サーバーA 月額サポート料 1,100円（税込）"),
    fact("f3", "サーバーAの途中解除料は2年未満で12,980円", "cancellation"),
    fact("f4", "他社サーバーBの水代は月9,999円"),
  ];

  it("accepts amounts that appear in the linked facts, with or without thousands separators", () => {
    const plan = waterPlan({ shippingFeeJpy: 1620, electricityFeeJpy: 1100, cancellationFeeJpy: 12980 });
    expect(checkPlanEvidence(plan, facts)).toEqual([]);
  });

  it("flags an amount that no linked fact contains and names the offer, field and value", () => {
    const issues = checkPlanEvidence(waterPlan({ waterChargeJpy: 1650 }), facts);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("offer-a");
    expect(issues[0]).toContain("waterChargeJpy");
    expect(issues[0]).toContain("1650");
  });

  it("ignores facts of other services even when they contain the number", () => {
    expect(checkPlanEvidence(waterPlan({ waterChargeJpy: 9999 }), facts)).toHaveLength(1);
  });

  it("uses facts of any claim type, since fees live in cancellation or contract facts", () => {
    expect(checkPlanEvidence(waterPlan({ cancellationFeeJpy: 12980 }), facts)).toEqual([]);
  });

  it("requires evidence for zero amounts: a standalone 0 or the word 無料", () => {
    expect(checkPlanEvidence(waterPlan({ initialFeeJpy: 0 }), facts)).toHaveLength(1);
    const free = [...facts, fact("f5", "サーバーAの設置費用は無料")];
    expect(checkPlanEvidence(waterPlan({ initialFeeJpy: 0 }), free)).toEqual([]);
    const zero = [...facts, fact("f6", "サーバーAの事務手数料は0円")];
    expect(checkPlanEvidence(waterPlan({ initialFeeJpy: 0 }), zero)).toEqual([]);
  });

  it("does not mistake the digit inside a larger number for a zero amount", () => {
    // 1,100円 and 12,980円 contain "0円" as text but no number equal to 0
    expect(checkPlanEvidence(waterPlan({ initialFeeJpy: 0 }), facts)).toHaveLength(1);
  });

  it("accepts a derived amount when every component is in the facts and the sum matches", () => {
    const plan = waterPlan(
      { waterChargeJpy: 4340 },
      { derivedAmounts: { waterChargeJpy: [{ amountJpy: 1620, times: 2 }, { amountJpy: 1100 }] } },
    );
    expect(checkPlanEvidence(plan, facts)).toEqual([]);
  });

  it("rejects a derived amount whose components do not add up to the value", () => {
    const plan = waterPlan(
      { waterChargeJpy: 4400 },
      { derivedAmounts: { waterChargeJpy: [{ amountJpy: 1620, times: 2 }, { amountJpy: 1100 }] } },
    );
    const issues = checkPlanEvidence(plan, facts);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("4400");
    expect(issues[0]).toContain("4340");
  });

  it("rejects a derived amount built from a component the facts do not contain", () => {
    const plan = waterPlan(
      { waterChargeJpy: 3500 },
      { derivedAmounts: { waterChargeJpy: [{ amountJpy: 1750, times: 2 }] } },
    );
    const issues = checkPlanEvidence(plan, facts);
    expect(issues.some((i) => i.includes("1750"))).toBe(true);
  });

  it("checks nested yen fields such as discount periods", () => {
    const plan: Pick<ArticlePlan, "calculators"> = {
      calculators: [
        {
          calculator: "sim",
          input: { offerId: "o", title: "SIM A", monthlyJpy: 2980, discountPeriods: [{ fromMonth: 1, toMonth: 6, monthlyJpy: 1080 }], months: 24 },
          factEvidenceTerms: ["SIM A"],
        },
      ],
    };
    const only = [fact("s1", "SIM Aの月額基本料は2980円")];
    const issues = checkPlanEvidence(plan, only);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("discountPeriods.0.monthlyJpy");
  });

  it("does not treat month counts, liters or UNKNOWN as yen amounts", () => {
    const plan = waterPlan({ waterChargeJpy: "UNKNOWN", months: 12, monthlyLiters: 24 });
    expect(checkPlanEvidence(plan, facts)).toEqual([]);
  });
});

describe("plan evidence as a QA gate in the pipeline", () => {
  const policy = parsePolicyText(
    readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"),
  );
  const PAGE = `<html><body><p>SIM A 20GB</p>
    <script type="application/x-aff-facts">[
      {"text":"SIM A 20GBの月額基本料は2980円","claimType":"price"},
      {"text":"SIM Aの事務手数料は3300円","claimType":"price"}
    ]</script></body></html>`;

  function run(monthlyJpy: number) {
    const plan: ArticlePlan = {
      slug: `evidence-${monthlyJpy}`,
      title: "SIM比較",
      audience: "a",
      purpose: "p",
      verticalId: "mobile",
      keyword: "k",
      sourceUrls: ["https://sim-a.example.com/price"],
      calculators: [
        {
          calculator: "sim",
          input: { offerId: "offer-x", title: "SIM A 20GB", monthlyJpy, dataGb: 20, initialFeeJpy: 3300, months: 24 },
          factEvidenceTerms: ["SIM A"],
        },
      ],
      offerIds: [],
    };
    return runArticlePipeline(plan, {
      repo: createMemoryRepository(),
      policy,
      logger: createLogger({ level: "error", sink: () => undefined }),
      fetcher: new MapFetcher(new Map([["https://sim-a.example.com/price", { body: PAGE }]])),
      extractor: new FixtureFactExtractor(),
      publisherIO: { writeArtifact: async () => undefined },
    });
  }

  it("publishes when every yen amount in the plan is backed by an extracted fact", async () => {
    const outcome = await run(2980);
    expect(outcome.qaFailures).toBeUndefined();
    expect(outcome.published).toBe(true);
  });

  it("blocks the article when a plan amount contradicts the official page", async () => {
    const outcome = await run(2990);
    expect(outcome.published).toBe(false);
    expect(outcome.publishReason).toBe("qa_FAIL");
    const failure = outcome.qaFailures?.find((f) => f.id === "plan_numbers_match_facts");
    expect(failure).toBeDefined();
    expect(failure?.detail).toContain("monthlyJpy");
    expect(failure?.detail).toContain("2990");
  });
});
