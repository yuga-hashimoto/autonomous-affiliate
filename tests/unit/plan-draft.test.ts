import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { createLogger, parsePolicyText, type Fact, type PolicyConfig, type SourceRecord } from "@aff/domain";
import { type Fetcher } from "@aff/integrations";
import {
  FixtureFactExtractor,
  checkPlanEvidence,
  completeDraftedPlan,
  runArticlePipeline,
  runPlan,
  type ArticlePlan,
  type PlanDraft,
  type PublisherIO,
} from "@aff/agents";
import { readFileSync } from "./helpers.js";

const NOW = "2026-10-28T00:00:00.000Z";
const PAGE = "https://water-a.example.com/price";
const SOURCE: SourceRecord = {
  id: "src",
  canonicalUrl: PAGE,
  sourceType: "official",
  fetchedAt: NOW,
  hash: "h",
  provenance: "test",
  contentType: "text/html",
};

function fact(text: string, claimType: Fact["claimType"] = "price", id = `f-${text.length}-${text.slice(0, 6)}`): Fact {
  return { id, text, claimType, sourceIds: ["src"], verifiedAt: NOW, confidence: 1, verificationStatus: "VERIFIED" };
}

const COMPLETE_FACTS: Fact[] = [
  fact("ウォーターA モデルX 月額4,190円（税込・12.5L×2本）"),
  fact("ウォーターA 送料は無料"),
  fact("ウォーターA 電気代の目安は月669円（税込・月36L使用時）"),
  fact("ウォーターA 初回登録事務手数料 3,300円（税込）"),
  fact("ウォーターA の最低利用期間は5年", "contract_term"),
];

function planOf(draft: Partial<PlanDraft> = {}, slug = "drafted-water-a"): ArticlePlan {
  return {
    slug,
    title: "ウォーターAの24ヶ月総額",
    audience: "家庭でウォーターサーバーを検討している人",
    purpose: "公式の料金ページの金額から24ヶ月の総額を試算します。",
    verticalId: "water_delivery",
    keyword: "ウォーターサーバー 総額",
    sourceUrls: [PAGE],
    calculators: [],
    offerIds: [],
    draft: {
      calculator: "water",
      offerId: "offer-water-a",
      title: "ウォーターA モデルX",
      evidenceTerms: ["ウォーターA"],
      months: 24,
      monthlyLiters: 25,
      ...draft,
    },
  };
}

function draftOf(facts: Fact[], draft: Partial<PlanDraft> = {}) {
  return completeDraftedPlan(planOf(draft), facts, [SOURCE]);
}

describe("completeDraftedPlan: the amounts come from the official facts, or the plan is not made", () => {
  it("builds the calculator input from facts, and the QA number check accepts it", () => {
    const result = draftOf(COMPLETE_FACTS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [entry] = result.plan.calculators;
    expect(entry?.calculator).toBe("water");
    expect(entry?.input).toEqual({
      offerId: "offer-water-a",
      title: "ウォーターA モデルX",
      waterChargeJpy: 4190,
      shippingFeeJpy: 0,
      electricityFeeJpy: 669,
      electricityIsEstimate: true,
      electricityBasisLiters: 36,
      months: 24,
      initialFeeJpy: 3300,
      cancellationFeeJpy: "UNKNOWN",
      monthlyLiters: 25,
      minimumTermMonths: 60,
    });
    expect(entry?.factEvidenceTerms).toEqual(["ウォーターA"]);
    expect(checkPlanEvidence(result.plan, COMPLETE_FACTS, [SOURCE])).toEqual([]);
  });

  it("uses a stated cancellation fee instead of UNKNOWN", () => {
    const result = draftOf([...COMPLETE_FACTS, fact("ウォーターA の契約解除料は9,900円（税込）", "cancellation")]);

    expect(result.ok && result.plan.calculators[0]?.input.cancellationFeeJpy).toBe(9900);
  });

  it("turns a per-bottle price into the monthly charge and records how it was derived", () => {
    const facts = [
      fact("ウォーターA 12L ボトル 1本 1,620円（税込）"),
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("月額")),
    ];

    const result = draftOf(facts, { monthlyLiters: 24 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [entry] = result.plan.calculators;
    expect(entry?.input.waterChargeJpy).toBe(3240);
    expect(entry?.derivedAmounts).toEqual({ waterChargeJpy: [{ amountJpy: 1620, times: 2 }] });
    expect(checkPlanEvidence(result.plan, facts, [SOURCE])).toEqual([]);
  });

  it("does not take the price of a different volume as the monthly charge", () => {
    const result = draftOf(COMPLETE_FACTS, { monthlyLiters: 20 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toContain("水代");
  });

  it("refuses to choose between two different monthly charges for the same volume", () => {
    const result = draftOf([...COMPLETE_FACTS, fact("ウォーターA モデルY 月額4,410円（税込・12.5L×2本）")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toMatch(/水代.*複数/);
  });

  it("prefers the facts that name the service over a page-wide fact of the same kind", () => {
    const facts = [
      ...COMPLETE_FACTS,
      // from the same page but about another service: a different price must not create a conflict
      fact("ウォーターB 送料 880円（税込）"),
    ];

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.shippingFeeJpy).toBe(0);
  });

  it("reads a fee that applies to the whole service from the page even when it names no service", () => {
    const facts = COMPLETE_FACTS.map((f) => (f.text.includes("手数料") ? fact("初回登録事務手数料：3,300円（税込）") : f));

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.initialFeeJpy).toBe(3300);
  });

  it("keeps the installation fee out of the initial fee", () => {
    const result = draftOf([...COMPLETE_FACTS, fact("ウォーターA 有料設置 8,800円（税込）")]);

    expect(result.ok && result.plan.calculators[0]?.input.initialFeeJpy).toBe(3300);
  });

  it("does not use a fact that mixes two kinds of fee for either of them", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("手数料")),
      // one unambiguous figure, but the sentence is about the setup fee and shipping at once
      fact("ウォーターA 初回登録事務手数料は3,300円（税込）、送料は別途"),
    ];

    const result = draftOf(facts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([expect.stringContaining("初回費用")]);
  });

  it("fails closed when shipping is free in general but charged in some areas", () => {
    const facts = COMPLETE_FACTS.map((f) => (f.text.includes("送料") ? fact("ウォーターA 送料無料（離島は715円）") : f));

    const result = draftOf(facts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toContain("送料");
  });

  it("names every missing required amount, and leaves optional ones out", () => {
    const result = draftOf([fact("ウォーターA モデルX 月額4,190円（税込・12.5L×2本）")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toContain("送料");
    expect(result.issues.join("\n")).toContain("電気代");
    expect(result.issues.join("\n")).toContain("初回費用");
    expect(result.issues.join("\n")).not.toContain("解約");
  });

  it("omits the minimum term when no fact states it, and rejects two different terms", () => {
    const without = draftOf(COMPLETE_FACTS.filter((f) => f.claimType !== "contract_term"));
    expect(without.ok && "minimumTermMonths" in (without.plan.calculators[0]?.input ?? {})).toBe(false);

    const twoTerms = draftOf([...COMPLETE_FACTS, fact("ウォーターA の最低利用期間は2年", "contract_term")]);
    expect(twoTerms.ok).toBe(false);
  });

  it("reads the tax-inclusive figure when a fact states both tax-excluded and tax-included prices", () => {
    const facts = [
      fact("ウォーターA モデルX 月額3,880円（税込4,190円・12.5L×2本）"),
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("月額")),
    ];

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.waterChargeJpy).toBe(4190);
  });

  it("takes the normal-use electricity figure when a fact also gives an eco-mode one", () => {
    const facts = COMPLETE_FACTS.map((f) =>
      f.text.includes("電気代") ? fact("ウォーターA の電気代は通常使用時約669円、エコモード使用時約583円") : f,
    );

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.electricityFeeJpy).toBe(669);
  });

  it("reads the volume an electricity estimate is based on from another fact of the page", () => {
    const facts = [
      ...COMPLETE_FACTS.map((f) => (f.text.includes("電気代") ? fact("ウォーターA 電気代は通常使用時約669円") : f)),
      fact("電気料金の表示は温水・冷水ともに各600cc/日、36L/月使用時、27円/kwhとして算出", "terms"),
    ];

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.electricityBasisLiters).toBe(36);
  });

  it("does not take a pause, delivery or payment fee for the initial fee, or a pause for a cancellation fee", () => {
    const facts = [
      ...COMPLETE_FACTS,
      fact("ウォーターA 休止事務手数料: 880円（税込）。60日以上休止すると発生し、120日経過で強制解約となる"),
      fact("ウォーターA 配送事務手数料: お水1セットあたり1,100円（税込）"),
      fact("ウォーターA 決済事務手数料: 220円（税込）"),
    ];

    const result = draftOf(facts);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.calculators[0]?.input.initialFeeJpy).toBe(3300);
    expect(result.plan.calculators[0]?.input.cancellationFeeJpy).toBe("UNKNOWN");
  });

  it("does not take a regional surcharge as the shipping fee", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("送料")),
      fact("ウォーターA の送料は一部地域を除き無料"),
      fact("ウォーターA 追加送料: 離島の場合 715円（税込）/1セット"),
    ];

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.shippingFeeJpy).toBe(0);
  });

  it("lets the plan name the price line: only facts holding every priceTerms fragment are read for the water charge", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("月額")),
      fact("ウォーターA プランP（省エネサーバー利用・月12.5L×2本）: 3,880円/月（税込4,190円）"),
      fact("ウォーターA プランP（デザインサーバー利用・月12.5L×2本）: 4,080円/月（税込4,410円）"),
    ];

    expect(draftOf(facts).ok).toBe(false); // two lines, nothing says which is this service's
    const named = draftOf(facts, { priceTerms: ["プランP", "省エネサーバー"] });
    expect(named.ok && named.plan.calculators[0]?.input.waterChargeJpy).toBe(4190);
  });

  it("shows the facts it looked at when the price line has no volume it can check", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("月額")),
      fact("ウォーターA プランP（省エネサーバー利用）の天然水の料金: 3,880円/月（税込4,190円）"),
    ];

    const result = draftOf(facts, { priceTerms: ["プランP", "省エネサーバー"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const water = result.issues.find((issue) => issue.startsWith("水代")) ?? "";
    expect(water).toContain("候補");
    expect(water).toContain("天然水の料金: 3,880円/月（税込4,190円）");
  });

  it("says when the named price line matches no fact at all", () => {
    const result = draftOf(COMPLETE_FACTS, { priceTerms: ["存在しない語"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.find((issue) => issue.startsWith("水代"))).toContain("該当するFactがありません");
  });

  it("lets the plan name its own terms: another plan's minimum term is not read", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => f.claimType !== "contract_term"),
      fact("ウォーターA プランPの最低利用期間は5年", "contract_term"),
      fact("ウォーターA プランQの最低利用期間は3年", "contract_term"),
    ];

    expect(draftOf(facts).ok).toBe(false);
    const named = draftOf(facts, { planTerms: ["プランP"] });
    expect(named.ok && named.plan.calculators[0]?.input.minimumTermMonths).toBe(60);
  });

  it("leaves a plan alone when it has no draft, or already has calculators", () => {
    const hand = { ...planOf(), draft: undefined, calculators: [{ calculator: "water" as const, input: { offerId: "o" } }] };
    const result = completeDraftedPlan(hand, [], []);

    expect(result).toEqual({ ok: true, plan: hand });

    const both = { ...hand, draft: planOf().draft };
    expect(completeDraftedPlan(both, [], [])).toEqual({ ok: true, plan: both });
  });
});

describe("a drafted plan in the pipeline", () => {
  const basePolicy = parsePolicyText(
    readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"),
  );
  const policy: PolicyConfig = {
    ...basePolicy,
    flags: { ...basePolicy.flags, publish_enabled: true },
    security: { ...basePolicy.security, allowed_source_domains: ["water-a.example.com"] },
  };

  function pageWith(lines: string[]): string {
    const facts = lines.map((text) => ({ text, claimType: "price" }));
    return `<html><body><p>ウォーターA</p><script type="application/x-aff-facts">${JSON.stringify(facts)}</script></body></html>`;
  }

  const FULL_PAGE = (monthly: number) => [
    `ウォーターA モデルX 月額${monthly.toLocaleString("en-US")}円（税込・12.5L×2本）`,
    "ウォーターA 送料は無料",
    "ウォーターA 電気代の目安は月669円（税込・月36L使用時）",
    "ウォーターA 初回登録事務手数料 3,300円（税込）",
  ];

  class FakeSite implements PublisherIO {
    readonly files = new Map<string, string>();
    async writeArtifact(path: string, content: string): Promise<void> {
      this.files.set(path, content);
    }
    async readArtifact(path: string): Promise<string | undefined> {
      return this.files.get(path);
    }
    async removeArtifact(path: string): Promise<void> {
      this.files.delete(path);
    }
    async buildSite(): Promise<void> {}
    async commitArtifact(path: string): Promise<string> {
      return `sha-${path}`;
    }
  }

  function setup(lines: string[]) {
    const page = { lines };
    const fetcher: Fetcher = {
      async fetch(url) {
        return { status: 200, body: pageWith(page.lines), contentType: "text/html", finalUrl: url };
      },
    };
    const site = new FakeSite();
    const services = {
      repo: createMemoryRepository(),
      policy,
      logger: createLogger({ level: "error", sink: () => undefined }),
      fetcher,
      extractor: new FixtureFactExtractor(),
      publisherIO: site,
      clock: () => new Date(NOW),
    };
    return { page, site, services };
  }

  const PATH = "content/articles/drafted-water-a.ja-JP.md";
  // 24 months: (4,190 + 0 + 669) × 24 + 3,300
  const TOTAL_4190 = "119,916";

  it("publishes an article whose figures were never typed in by hand", async () => {
    const env = setup(FULL_PAGE(4190));

    const result = await runArticlePipeline(planOf(), env.services);

    expect(result).toMatchObject({ finalState: "PUBLISHED", qaStatus: "PASS", published: true });
    expect(env.site.files.get(PATH)).toContain(TOTAL_4190);
  });

  it("quarantines with the reasons when the page does not support a plan, and publishes nothing", async () => {
    const env = setup(FULL_PAGE(4190).filter((line) => !line.includes("送料")));

    const result = await runArticlePipeline(planOf(), env.services);

    expect(result).toMatchObject({ finalState: "QUARANTINED", published: false, publishReason: "plan_draft_failed" });
    expect(result.reasons.join("\n")).toContain("送料");
    expect(env.site.files.size).toBe(0);
  });

  it("follows the page on update: a new price becomes the new article, with no plan edit", async () => {
    const env = setup(FULL_PAGE(4190));
    await runArticlePipeline(planOf(), env.services);

    env.page.lines = FULL_PAGE(4290);
    const update = await runPlan(planOf(), env.services, { templateRevision: "price-follow-1" });

    expect(update.update?.outcome).toBe("updated");
    const text = env.site.files.get(PATH) ?? "";
    expect(text).toContain("122,316"); // (4,290 + 669) × 24 + 3,300
    expect(text).not.toContain(TOTAL_4190);
  });

  it("keeps the live article when an update can no longer be drafted", async () => {
    const env = setup(FULL_PAGE(4190));
    await runArticlePipeline(planOf(), env.services);
    const live = env.site.files.get(PATH);

    env.page.lines = FULL_PAGE(4190).filter((line) => !line.includes("電気代"));
    const update = await runPlan(planOf(), env.services, { templateRevision: "price-follow-2" });

    expect(update.update?.outcome).toBe("kept_previous");
    expect(update.reasons.join("\n")).toContain("plan_draft_failed");
    expect(env.site.files.get(PATH)).toBe(live);
  });
});

describe("calibration on facts extracted from the real official pages (2026-10-28)", () => {
  interface Captured {
    pages: { url: string; facts: { text: string; claimType: Fact["claimType"] }[] }[];
  }
  const captured = JSON.parse(
    readFileSync(new URL("../fixtures/premium-water-facts-2026-10-28.json", import.meta.url), "utf8"),
  ) as Captured;
  const sources: SourceRecord[] = captured.pages.map((page, i) => ({ ...SOURCE, id: `real-${i}`, canonicalUrl: page.url }));
  const facts: Fact[] = captured.pages.flatMap((page, i) =>
    page.facts.map((f, j) => ({ ...fact(f.text, f.claimType, `real-${i}-${j}`), sourceIds: [`real-${i}`] })),
  );
  const hand = JSON.parse(
    readFileSync(new URL("../../config/plans.live-preview-draft.json", import.meta.url), "utf8"),
  ).plans[0] as ArticlePlan;
  const handMade = JSON.parse(
    readFileSync(new URL("../../config/plans.live-preview.json", import.meta.url), "utf8"),
  ).plans[0] as ArticlePlan;

  it("draws the same input the hand-made famfit2 plan was typed with", () => {
    const result = completeDraftedPlan(hand, facts, sources);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.calculators[0]?.input).toEqual(handMade.calculators[0]?.input);
    expect(checkPlanEvidence(result.plan, facts, sources)).toEqual([]);
  });

  it("does not take another plan's term or another server's price", () => {
    const result = completeDraftedPlan(hand, facts, sources);

    expect(result.ok && result.plan.calculators[0]?.input.minimumTermMonths).toBe(60); // not ずっとPREMIUM's 3 years
    expect(result.ok && result.plan.calculators[0]?.input.waterChargeJpy).toBe(4190); // not 4,410 or 4,082
  });
});
