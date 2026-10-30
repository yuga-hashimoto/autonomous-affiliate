import { describe, expect, it } from "vitest";
import type { Fact, SourceRecord } from "@aff/domain";
import {
  checkPlanEvidence,
  completeDraftedPlan,
  type ArticlePlan,
  type PlanDraft,
} from "@aff/agents";

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
  fact("ウォーターA サーバーレンタル料は無料"),
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
      serverRentalFeeJpy: 0,
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
    const result = draftOf([...COMPLETE_FACTS, fact("ウォーターA 初回設置費用 8,800円（税込）")]);

    expect(result.ok && result.plan.calculators[0]?.input.initialFeeJpy).toBe(3300);
  });

  it("reads each fee from the words right after its own name, so a passage may carry neighbours", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("手数料") && !f.text.includes("送料")),
      // one passage, two fees and a price: each figure belongs to the label before it
      fact("ウォーターA 月12.5L×2本ご利用の場合 3,780円/月～ (税込4,082円) 送料 無料 ※一部地域を除く 初回登録事務手数料は3,300円（税込）"),
    ];

    const result = draftOf(facts);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.calculators[0]?.input.shippingFeeJpy).toBe(0);
    expect(result.plan.calculators[0]?.input.initialFeeJpy).toBe(3300);
    expect(result.plan.calculators[0]?.input.waterChargeJpy).not.toBe(4082); // the price in that passage is not a fee
  });

  it("ends a fee's words where the next fee's name begins", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("送料") && !f.text.includes("手数料")),
      fact("ウォーターA 送料は無料、初回登録事務手数料は3,300円（税込）"),
    ];

    const result = draftOf(facts);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.calculators[0]?.input.shippingFeeJpy).toBe(0);
    expect(result.plan.calculators[0]?.input.initialFeeJpy).toBe(3300);
  });

  it("stops reading the shipping fee where the regional surcharge begins in the same passage", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("送料")),
      fact("ウォーターA 送料 当社の工場より送料無料で配送します 追加送料【離島の場合】715円（税込）/1セット"),
    ];

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.shippingFeeJpy).toBe(0);
  });

  it("does not take an eco-mode figure in brackets as the electricity figure", () => {
    const facts = COMPLETE_FACTS.map((f) =>
      f.text.includes("電気代") ? fact("ウォーターA 月額電気料金※1 約669円/月（エコモード時 約583円/月）") : f,
    );

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.electricityFeeJpy).toBe(669);
  });

  it("binds a server's electricity figure through a long passage that starts at the server's name", () => {
    const longPassage = `ウォーターA モデルX ${"ボトルは下置きでかんたん交換。".repeat(30)} 【月額電気料金】 通常使用時：約669円、エコモード使用時：約583円`;
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("電気代")),
      fact(longPassage),
      fact("月額電気料金 ※1 約1,011円/月（エコモード時 約798円/月）"), // another server's row, which names none
    ];

    const result = draftOf(facts);

    expect(result.ok && result.plan.calculators[0]?.input.electricityFeeJpy).toBe(669);
  });

  it("stops when one passage gives two different electricity figures", () => {
    const facts = [
      ...COMPLETE_FACTS.filter((f) => !f.text.includes("電気代")),
      fact("ウォーターA 月額電気料金 約669円/月 ... スリムサーバー 月額電気料金 約630円/月"),
    ];

    const result = draftOf(facts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toContain("電気代");
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
    expect(result.issues.join("\n")).toContain("サーバーレンタル料");
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

  it("does not take the first of several terms from a comparison row that lists two plans", () => {
    const row = fact("ウォーターA プランQ プランP 最低利用期間 3年 5年", "contract_term");
    const base = COMPLETE_FACTS.filter((f) => f.claimType !== "contract_term");

    const alone = draftOf([...base, row], { planTerms: ["プランP"] });
    expect(alone.ok).toBe(true); // the term is optional: it is left out rather than guessed
    expect(alone.ok && "minimumTermMonths" in (alone.plan.calculators[0]?.input ?? {})).toBe(false);

    const withOwnLine = draftOf([...base, row, fact("ウォーターA プランPの最低利用期間は5年", "contract_term")], { planTerms: ["プランP"] });
    expect(withOwnLine.ok && withOwnLine.plan.calculators[0]?.input.minimumTermMonths).toBe(60);
  });

  it("shows the facts that disagreed when it cannot choose between two amounts", () => {
    const facts = [...COMPLETE_FACTS, fact("ウォーターA の送料は880円（税込）")];

    const result = draftOf(facts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const shipping = result.issues.find((issue) => issue.startsWith("送料")) ?? "";
    expect(shipping).toContain("候補");
    expect(shipping).toContain("送料は880円");
  });

  describe("the server rental fee is part of the total, or the plan is not made", () => {
    const withoutRental = COMPLETE_FACTS.filter((f) => !f.text.includes("レンタル"));
    const rentalOf = (result: ReturnType<typeof draftOf>) => (result.ok ? result.plan.calculators[0]?.input.serverRentalFeeJpy : undefined);

    it("reads a stated rental (the tax-included figure) and the QA number check backs it", () => {
      const facts = [...withoutRental, fact("ウォーターA サーバーレンタル料 200円/月 (税込220円)")];

      const result = draftOf(facts);

      expect(rentalOf(result)).toBe(220);
      expect(result.ok && checkPlanEvidence(result.plan, facts, [SOURCE])).toEqual([]);
    });

    it("names the rental when the page states none, instead of leaving it out of the total", () => {
      const result = draftOf(withoutRental);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.join("\n")).toContain("サーバーレンタル料");
    });

    it("ends the rental's words at the next label of a price card, so the card's water charge is not the rental", () => {
      const card = fact(
        "月12.5L×2本ご利用の場合 3,880円/月 (税込4,190円) サーバーレンタル料 無料 天然水の料金 3,880円/月 (税込4,190円) 選べるウォーターサーバー ウォーターA",
      );

      expect(rentalOf(draftOf([...withoutRental, card]))).toBe(0);
    });

    it("ends the rental's words at the term label of a comparison row, so a saving stated further on is not the rental", () => {
      const row = fact(
        "ウォーターA を使いたい場合 サーバー レンタル料 無料 無料 最低利用期間 3年 5年 天然水を毎月1セット注文した場合… プランQと比較して 1年間 税込 1,296円お得 毎月 税込 108円お得",
      );

      expect(rentalOf(draftOf([...withoutRental, row]))).toBe(0);
    });

    it("still reads the water charge and the term of a passage that also carries the rental", () => {
      const facts = [
        ...withoutRental.filter((f) => !f.text.includes("月額") && f.claimType !== "contract_term"),
        fact("月12.5L×2本ご利用の場合 3,880円/月 (税込4,190円) サーバーレンタル料 無料 選べるウォーターサーバー ウォーターA"),
        fact("ウォーターA サーバーレンタル料 無料 最低利用期間 5年", "contract_term"),
      ];

      const result = draftOf(facts);

      expect(result.ok && result.plan.calculators[0]?.input).toMatchObject({
        waterChargeJpy: 4190,
        serverRentalFeeJpy: 0,
        minimumTermMonths: 60,
      });
    });

    it("does not take a card's total, which includes the rental, as the water charge", () => {
      const card = fact("月12.5L×2本ご利用の場合 4,080円/月 (税込4,410円) サーバーレンタル料 200円/月 (税込220円) 天然水の料金 3,880円/月 (税込4,190円) ウォーターA");
      const facts = [...withoutRental.filter((f) => !f.text.includes("月額")), card];

      const result = draftOf(facts);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.find((issue) => issue.startsWith("水代"))).toBeDefined();
    });

    it("fails closed when one row gives a rental for each of two plans", () => {
      const row = fact("ウォーターA グランデ サーバー レンタル料 1,000円/月 （税込1,100円） 200円/月 （税込220円） 最低利用期間 3年 5年");

      const result = draftOf([...withoutRental, row]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.find((issue) => issue.startsWith("サーバーレンタル料"))).toContain("候補");
    });

    it("fails closed when two passages state different rentals for the same server", () => {
      const facts = [
        ...withoutRental,
        fact("ウォーターA サーバーレンタル料 200円/月 (税込220円)"),
        fact("ウォーターA サーバーレンタル料 1,000円/月 (税込1,100円)"),
      ];

      const result = draftOf(facts);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.join("\n")).toMatch(/サーバーレンタル料.*220円・1100円/);
    });

    it("refuses a server whose electricity differs by size instead of choosing one", () => {
      const facts = [
        ...COMPLETE_FACTS.filter((f) => !f.text.includes("電気代")),
        fact("ウォーターA 月額電気料金※1 ロング：約630円/月（エコモード時約520円/月） ショート：約666円/月（エコモード時約549円/月）"),
      ];

      const result = draftOf(facts);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.join("\n")).toContain("電気代");
    });
  });

  it("leaves a plan alone when it has no draft, or already has calculators", () => {
    const hand = { ...planOf(), draft: undefined, calculators: [{ calculator: "water" as const, input: { offerId: "o" } }] };
    const result = completeDraftedPlan(hand, [], []);

    expect(result).toEqual({ ok: true, plan: hand });

    const both = { ...hand, draft: planOf().draft };
    expect(completeDraftedPlan(both, [], [])).toEqual({ ok: true, plan: both });
  });
});
