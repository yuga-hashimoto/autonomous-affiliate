import { describe, expect, it } from "vitest";
import {
  AD_DISCLOSURE,
  buildDraft,
  DraftRejectedError,
  findProhibitedPhrases,
  QaEngine,
} from "@aff/content";
import { calculateFiberTotalCost, calculateSimTotalCost, calculateWaterServerCost } from "@aff/analysis";
import { createFreshnessPolicy, type FreshnessPolicy } from "@aff/integrations";
import {
  type AffiliateOffer,
  type Fact,
  type PolicyConfig,
  type SourceRecord,
  parsePolicyText,
} from "@aff/domain";
import { readFileSync } from "node:fs";
import { extractBreakdownSection, findNonJapaneseBreakdownLines } from "../helpers/breakdown-leaks.js";

const policy: PolicyConfig = parsePolicyText(
  readFileSync(new URL("../../config/policy.example.yaml", import.meta.url), "utf8"),
);

const fetchedAt = new Date().toISOString();
const source: SourceRecord = {
  id: "src_1",
  canonicalUrl: "https://provider.example.com/price",
  sourceType: "official",
  fetchedAt,
  hash: "a".repeat(64),
  provenance: "fixture",
  contentType: "text/html",
};

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "fact_1",
    text: "SIM A 20GBの月額は2980円",
    claimType: "price",
    sourceIds: ["src_1"],
    verifiedAt: fetchedAt,
    confidence: 1,
    verificationStatus: "VERIFIED",
    ...overrides,
  };
}

function offer(overrides: Partial<AffiliateOffer> = {}): AffiliateOffer {
  return {
    id: "offer_a",
    programId: "prog_1",
    verticalId: "mobile",
    title: "SIM A 20GB",
    rewardModel: "fixed_jpy",
    rewardAmountJpy: 3000,
    channelPermissions: ["site"],
    active: true,
    status: "APPROVED",
    constraints: {},
    ...overrides,
  };
}

function buildTestDraft(overrides: Partial<Parameters<typeof buildDraft>[0]> = {}) {
  const calculation = calculateSimTotalCost({
    offerId: "offer_a",
    title: "SIM A 20GB",
    monthlyJpy: 2980,
    dataGb: 20,
    initialFeeJpy: 3300,
    months: 24,
  });
  return buildDraft({
    slug: "sim-20gb-hikaku",
    title: "20GB系SIMの24ヶ月総額比較",
    audience: "月20GB程度使う人",
    purpose: "公式料金に基づき24ヶ月の総額を比較します。",
    facts: [fact()],
    sources: [source],
    offers: [offer()],
    calculations: [calculation],
    ctaOffers: [offer()],
    ...overrides,
  });
}

function qaEngine(overrides: Partial<{ existing: Set<string>; freshness: FreshnessPolicy }> = {}) {
  return new QaEngine(policy, {
    freshness: overrides.freshness ?? createFreshnessPolicy(policy),
    existingContentHashes: overrides.existing ?? new Set(),
  });
}

describe("B009 draft engine", () => {
  it("builds a draft with disclosure, formula, assumptions and sources", () => {
    const draft = buildTestDraft();
    expect(draft.bodyMarkdown.startsWith(AD_DISCLOSURE)).toBe(true);
    expect(draft.bodyMarkdown).toContain("計算式:");
    expect(draft.bodyMarkdown).toContain("前提:");
    expect(draft.bodyMarkdown).toContain("[公式](https://provider.example.com/price)");
    expect(draft.claims[0]!.sourceIds).toContain("src_1");
    expect(draft.disclosure).toBe(AD_DISCLOSURE);
  });

  it("renders the 試算の内訳 section with Japanese labels and assumptions", () => {
    const draft = buildTestDraft();
    const section = extractBreakdownSection(draft.bodyMarkdown);
    expect(section).toContain("- 前提: 比較期間は24ヶ月");
    expect(section).toContain("- 初期費用: 3,300円");
    expect(section).toContain("- 月額料金（24ヶ月 × 月2,980円）: 71,520円");
    expect(findNonJapaneseBreakdownLines(draft.bodyMarkdown)).toEqual([]);
  });

  it("leaks no English label from any calculator, UNKNOWN rows included", () => {
    const calculations = [
      calculateSimTotalCost({
        offerId: "sim_full",
        title: "SIM full",
        monthlyJpy: 2980,
        dataGb: 20,
        initialFeeJpy: 3300,
        months: 24,
        discountPeriods: [{ fromMonth: 1, toMonth: 6, monthlyJpy: 1080 }],
        universalServiceFeeJpy: 2,
      }),
      calculateSimTotalCost({
        offerId: "sim_unknown",
        title: "SIM unknown",
        monthlyJpy: "UNKNOWN",
        dataGb: "UNKNOWN",
        initialFeeJpy: "UNKNOWN",
        months: 24,
        discountPeriods: [{ fromMonth: 1, toMonth: 3, monthlyJpy: 980 }],
        universalServiceFeeJpy: "UNKNOWN",
      }),
      calculateFiberTotalCost({
        offerId: "fiber_full",
        title: "Fiber full",
        monthlyJpy: 5390,
        months: 24,
        installationFeeJpy: 44000,
        installationFeeMonths: 24,
        contractTermMonths: 24,
        cancellationFeeJpy: 1000,
        apartmentType: "mansion",
      }),
      calculateFiberTotalCost({
        offerId: "fiber_unknown",
        title: "Fiber unknown",
        monthlyJpy: "UNKNOWN",
        months: 24,
        installationFeeJpy: "UNKNOWN",
        installationFeeMonths: 24,
        contractTermMonths: "UNKNOWN",
        cancellationFeeJpy: "UNKNOWN",
        apartmentType: "kodate",
      }),
      calculateWaterServerCost({
        offerId: "water_full",
        title: "Water full",
        waterChargeJpy: 4100,
        shippingFeeJpy: 260,
        electricityFeeJpy: 250,
        months: 12,
        initialFeeJpy: 0,
        cancellationFeeJpy: 11000,
        monthlyLiters: 24,
      }),
      calculateWaterServerCost({
        offerId: "water_unknown",
        title: "Water unknown",
        waterChargeJpy: "UNKNOWN",
        shippingFeeJpy: "UNKNOWN",
        electricityFeeJpy: "UNKNOWN",
        months: 12,
        initialFeeJpy: "UNKNOWN",
        cancellationFeeJpy: "UNKNOWN",
        monthlyLiters: 24,
      }),
    ];
    const draft = buildTestDraft({ calculations });
    expect(extractBreakdownSection(draft.bodyMarkdown)).toContain("ユニバーサルサービス料");
    expect(findNonJapaneseBreakdownLines(draft.bodyMarkdown)).toEqual([]);
  });

  it("the leak check really flags English labels and assumptions", () => {
    const english = [
      "## 試算の内訳（公式料金に基づく計算）",
      "",
      "### SIM A",
      "",
      "- 計算式: `totalJpy = initialFeeJpy + monthlyJpy * months`",
      "- 式バージョン: analysis-formulas-v1",
      "- 前提: comparison period is 24 months",
      "- initial fee: 3,300円",
      "- monthly fee (24 months × 2980 JPY): 71,520円",
      "- 月額料金（24ヶ月）: 71,520円",
      "",
      "## 条件別の比較表",
    ].join("\n");
    expect(findNonJapaneseBreakdownLines(english)).toEqual([
      "- 前提: comparison period is 24 months",
      "- initial fee: 3,300円",
      "- monthly fee (24 months × 2980 JPY): 71,520円",
    ]);
  });

  it("reads comparisonMonths from the calculation, not from assumption prose", () => {
    const calculation = {
      ...calculateSimTotalCost({
        offerId: "offer_a",
        title: "SIM A 20GB",
        monthlyJpy: 2980,
        dataGb: 20,
        initialFeeJpy: 3300,
        months: 12,
      }),
      assumptions: ["期間は一年間とする"],
    };
    const draft = buildTestDraft({ calculations: [calculation] });
    expect(draft.metadata.comparisonMonths).toBe(12);
    const decision = qaEngine().evaluate({ draft, facts: [fact()], offers: [offer()], sources: [source] });
    expect(decision.checks.find((c) => c.id === "comparison_units_match")?.status).toBe("PASS");
  });

  it("has no comparison period without calculations (fail-closed QA input)", () => {
    const draft = buildTestDraft({ calculations: [] });
    expect(draft.metadata.comparisonMonths).toBeNull();
  });

  it("rejects fabricated hands-on experience before any QA runs", () => {
    const violations = findProhibitedPhrases("このSIMを実際に使ってみた結果、快適でした。");
    expect(violations).toHaveLength(1);
    const input = {
      slug: "x",
      title: "x",
      audience: "a",
      purpose: "p",
      facts: [],
      sources: [],
      offers: [],
      calculations: [],
      ctaOffers: [],
    };
    expect(() =>
      buildDraft({ ...input, purpose: "使ってみた感想を紹介します。" }),
    ).toThrow(DraftRejectedError);
  });

  describe("conditions outside the total", () => {
    const waterCalc = (overrides: Record<string, unknown> = {}) =>
      calculateWaterServerCost({
        offerId: "offer_w",
        title: "Water 25L",
        waterChargeJpy: 4190,
        shippingFeeJpy: 0,
        electricityFeeJpy: 669,
        months: 24,
        initialFeeJpy: 3300,
        cancellationFeeJpy: "UNKNOWN",
        minimumTermMonths: 60,
        monthlyLiters: 25,
        ...overrides,
      });

    it("lists unknown conditions in the 不明点 column instead of reporting なし", () => {
      const draft = buildTestDraft({ calculations: [waterCalc()] });
      const row = draft.bodyMarkdown.split("\n").find((line) => line.startsWith("| Water 25L")) ?? "";
      expect(row).toContain("契約解除料");
      expect(row).not.toMatch(/\| なし \|$/);
    });

    it("keeps なし when every condition is known", () => {
      const draft = buildTestDraft({
        calculations: [waterCalc({ cancellationFeeJpy: 12980, minimumTermMonths: 24 })],
      });
      const row = draft.bodyMarkdown.split("\n").find((line) => line.startsWith("| Water 25L")) ?? "";
      expect(row).toMatch(/\| なし \|$/);
    });

    it("renders a conditions section with every condition and its value", () => {
      const body = buildTestDraft({ calculations: [waterCalc()] }).bodyMarkdown;
      expect(body).toContain("## 契約条件（総額に含めない項目）");
      expect(body).toMatch(/- 最低利用期間: 60ヶ月/);
      expect(body).toMatch(/- 契約解除料: UNKNOWN/);
    });

    it("puts the term warning right under the comparison table", () => {
      const body = buildTestDraft({ calculations: [waterCalc()] }).bodyMarkdown;
      const warningAt = body.indexOf("> 注意");
      expect(warningAt).toBeGreaterThan(body.indexOf("## 総額比較"));
      expect(warningAt).toBeLessThan(body.indexOf("## 試算の内訳"));
      expect(body.slice(warningAt)).toContain("60ヶ月");
    });

    it("leaves articles without conditions unchanged", () => {
      const body = buildTestDraft().bodyMarkdown;
      expect(body).not.toContain("契約条件（総額に含めない項目）");
      expect(body).not.toContain("> 注意");
      const row = body.split("\n").find((line) => line.startsWith("| SIM A 20GB")) ?? "";
      expect(row).toMatch(/\| なし \|$/);
    });
  });

  it("omits affiliate CTAs when no approved offer exists", () => {
    const draft = buildTestDraft({ ctaOffers: [] });
    expect(draft.offerIds).toHaveLength(0);
    expect(draft.bodyMarkdown).toContain("掲載可能な紹介プログラムがありません");
  });
});

describe("B010 QA engine", () => {
  it("passes a fully evidenced draft", () => {
    const draft = buildTestDraft();
    const decision = qaEngine().evaluate({ draft, facts: [fact()], offers: [offer()], sources: [source] });
    expect(decision.status).toBe("PASS");
    expect(decision.checks.every((c) => c.status === "PASS")).toBe(true);
    expect(decision.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails when the PR disclosure is removed", () => {
    const draft = buildTestDraft();
    const tampered = {
      ...draft,
      bodyMarkdown: draft.bodyMarkdown.replace(AD_DISCLOSURE, ""),
      disclosure: "",
    };
    const decision = qaEngine().evaluate({ draft: tampered, facts: [fact()], offers: [offer()], sources: [source] });
    expect(decision.status).toBe("FAIL");
    expect(decision.checks.find((c) => c.id === "ad_disclosure_present")?.status).toBe("FAIL");
  });

  it("fails drafts referencing unapproved offers", () => {
    const draft = buildTestDraft();
    const tampered = { ...draft, offerIds: ["offer_a"] };
    const decision = qaEngine().evaluate({
      draft: tampered,
      facts: [fact()],
      offers: [offer({ status: "PENDING" })],
      sources: [source],
    });
    expect(decision.checks.find((c) => c.id === "offers_approved_and_active")?.status).toBe("FAIL");
    expect(decision.status).toBe("FAIL");
  });

  it("fails when evidence is stale beyond the freshness window", () => {
    const draft = buildTestDraft();
    const staleFact = fact({ verifiedAt: "2026-01-01T00:00:00Z" });
    const decision = qaEngine().evaluate({ draft, facts: [staleFact], offers: [offer()], sources: [source] });
    expect(decision.checks.find((c) => c.id === "claims_fresh")?.status).toBe("FAIL");
    expect(decision.status).toBe("FAIL");
  });

  it("fails a price calculation that has a source URL but no linked structured Fact", () => {
    const draft = buildTestDraft({ facts: [] });
    const decision = qaEngine().evaluate({ draft, facts: [], offers: [offer()], sources: [source] });
    expect(decision.checks.find((c) => c.id === "price_claims_linked_to_facts")?.status).toBe("FAIL");
    expect(decision.status).toBe("FAIL");
  });

  it("fails duplicate content", () => {
    const draft = buildTestDraft();
    const first = qaEngine().evaluate({ draft, facts: [fact()], offers: [offer()], sources: [source] });
    const engine = qaEngine({ existing: new Set([first.artifactHash]) });
    const second = engine.evaluate({ draft, facts: [fact()], offers: [offer()], sources: [source] });
    expect(second.status).toBe("FAIL");
    expect(second.checks.find((c) => c.id === "no_duplicate_content")?.status).toBe("FAIL");
  });

  it("fails artifacts containing secrets or PII", () => {
    const draft = buildTestDraft();
    const leaked = {
      ...draft,
      bodyMarkdown: draft.bodyMarkdown + "\n問い合わせ: taro@example.com\n",
    };
    const decision = qaEngine().evaluate({ draft: leaked, facts: [fact()], offers: [offer()], sources: [source] });
    expect(decision.checks.find((c) => c.id === "no_secrets_or_pii")?.status).toBe("FAIL");
  });
});
