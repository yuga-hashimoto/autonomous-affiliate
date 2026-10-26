import { describe, expect, it } from "vitest";
import {
  AD_DISCLOSURE,
  buildDraft,
  DraftRejectedError,
  findProhibitedPhrases,
  QaEngine,
} from "@aff/content";
import { calculateSimTotalCost } from "@aff/analysis";
import { createFreshnessPolicy, type FreshnessPolicy } from "@aff/integrations";
import {
  type AffiliateOffer,
  type Fact,
  type PolicyConfig,
  type SourceRecord,
  parsePolicyText,
} from "@aff/domain";
import { readFileSync } from "node:fs";

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
