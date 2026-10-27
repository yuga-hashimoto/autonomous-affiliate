import { describe, expect, it } from "vitest";
import {
  buildCostMatrix,
  buildDecisionMatrix,
  calculateBuybackNet,
  calculateFiberTotalCost,
  calculateSimTotalCost,
  calculateWaterServerCost,
  competitionGaps,
  FORMULA_VERSION,
  scoreOpportunity,
  unknownLabel,
  verifySimTotalCost,
} from "@aff/analysis";
import type { SerpObservation } from "@aff/domain";

describe("B007 SIM total cost calculator", () => {
  it("computes the 24-month total with discounts and initial fee", () => {
    const input = {
      offerId: "offer-sim-a",
      title: "SIM A 20GB",
      monthlyJpy: 2980,
      dataGb: 20,
      initialFeeJpy: 3300,
      months: 24,
      discountPeriods: [{ fromMonth: 1, toMonth: 6, monthlyJpy: 1080 }],
      universalServiceFeeJpy: 2,
    };
    const calc = calculateSimTotalCost(input);
    // 3300 + 2980*24 - (2980-1080)*6 + 2*24 = 3300 + 71520 - 11400 + 48 = 63468
    expect(calc.totalJpy).toBe(63468);
    expect(calc.monthlyAverageJpy).toBe(Math.round(63468 / 24));
    expect(verifySimTotalCost(input, calc)).toEqual({ ok: true, expected: 63468 });
    expect(calc.formulaVersion).toBe(FORMULA_VERSION);
  });

  it("propagates UNKNOWN monthly price instead of assuming zero", () => {
    const input = {
      offerId: "offer-sim-b",
      title: "SIM B",
      monthlyJpy: "UNKNOWN" as const,
      dataGb: 20,
      initialFeeJpy: 3300,
      months: 24,
    };
    const calc = calculateSimTotalCost(input);
    expect(calc.totalJpy).toBe("UNKNOWN");
    expect(calc.monthlyAverageJpy).toBe("UNKNOWN");
    expect(calc.unknowns).toContain("monthlyJpy");
    expect(verifySimTotalCost(input, calc).ok).toBe(true);
  });
});

describe("fiber / water / buyback calculators", () => {
  it("computes fiber effective cost with installation fee", () => {
    const calc = calculateFiberTotalCost({
      offerId: "offer-fiber-1",
      title: "Fiber 1G mansion",
      monthlyJpy: 5390,
      months: 24,
      installationFeeJpy: 44000,
      installationFeeMonths: 24,
      contractTermMonths: 24,
      cancellationFeeJpy: 1000,
      apartmentType: "mansion",
    });
    expect(calc.totalJpy).toBe(5390 * 24 + 44000);
    expect(calc.monthlyAverageJpy).toBe(Math.round((5390 * 24 + 44000) / 24));
  });

  it("keeps cancellation fee as a condition, not in the total", () => {
    const calc = calculateWaterServerCost({
      offerId: "offer-water-1",
      title: "Water 24L",
      waterChargeJpy: 4100,
      shippingFeeJpy: 260,
      electricityFeeJpy: 250,
      months: 12,
      initialFeeJpy: 0,
      cancellationFeeJpy: 11000,
      monthlyLiters: 24,
    });
    expect(calc.totalJpy).toBe((4100 + 260 + 250) * 12);
    expect(calc.assumptions.join("\n")).toContain("11,000円");
  });

  describe("water conditions that stay outside the total", () => {
    const base = {
      offerId: "offer-water-2",
      title: "Water 25L",
      waterChargeJpy: 4190,
      shippingFeeJpy: 0,
      electricityFeeJpy: 669,
      months: 24,
      initialFeeJpy: 3300,
      monthlyLiters: 25,
    };
    const find = (calc: ReturnType<typeof calculateWaterServerCost>, label: string) =>
      calc.conditions?.find((c) => c.label === label);

    it("lists an unknown cancellation fee and a known minimum term without touching the total", () => {
      const calc = calculateWaterServerCost({ ...base, cancellationFeeJpy: "UNKNOWN", minimumTermMonths: 60 });
      expect(calc.totalJpy).toBe((4190 + 0 + 669) * 24 + 3300);
      expect(calc.unknowns).toEqual([]);
      expect(find(calc, "契約解除料")).toMatchObject({ known: false });
      expect(find(calc, "契約解除料")?.value).toContain("UNKNOWN");
      expect(find(calc, "最低利用期間")).toEqual({ label: "最低利用期間", value: "60ヶ月", known: true });
    });

    it("shows a known cancellation fee with its amount", () => {
      const calc = calculateWaterServerCost({ ...base, cancellationFeeJpy: 12980, minimumTermMonths: 24 });
      expect(find(calc, "契約解除料")).toEqual({ label: "契約解除料", value: "12,980円", known: true });
    });

    it("treats a minimum term that was not provided as unknown, not as absent", () => {
      const calc = calculateWaterServerCost({ ...base, cancellationFeeJpy: 0 });
      expect(find(calc, "最低利用期間")).toMatchObject({ known: false });
    });

    it("warns when the comparison period is shorter than the minimum term", () => {
      const calc = calculateWaterServerCost({ ...base, cancellationFeeJpy: "UNKNOWN", minimumTermMonths: 60 });
      expect(calc.warnings).toHaveLength(1);
      expect(calc.warnings?.[0]).toContain("24ヶ月");
      expect(calc.warnings?.[0]).toContain("60ヶ月");
      expect(calc.warnings?.[0]).toContain("契約解除料");
    });

    it("exposes a known minimum term as a number for charts, and nothing when it is unknown or absent", () => {
      expect(calculateWaterServerCost({ ...base, cancellationFeeJpy: "UNKNOWN", minimumTermMonths: 60 }).minimumTermMonths).toBe(60);
      expect(calculateWaterServerCost({ ...base, cancellationFeeJpy: 0, minimumTermMonths: "UNKNOWN" }).minimumTermMonths).toBeUndefined();
      expect(calculateWaterServerCost({ ...base, cancellationFeeJpy: 0 }).minimumTermMonths).toBeUndefined();
    });

    it("gives no warning when the comparison period covers the minimum term or the term is unknown", () => {
      expect(calculateWaterServerCost({ ...base, cancellationFeeJpy: 0, minimumTermMonths: 24 }).warnings ?? []).toEqual([]);
      expect(calculateWaterServerCost({ ...base, cancellationFeeJpy: 0, minimumTermMonths: "UNKNOWN" }).warnings ?? []).toEqual([]);
    });

    it("says electricity is an official estimate, with its basis and the different assumed usage", () => {
      const calc = calculateWaterServerCost({
        ...base,
        cancellationFeeJpy: 0,
        minimumTermMonths: 24,
        electricityIsEstimate: true,
        electricityBasisLiters: 36,
      });
      const note = calc.assumptions.find((a) => a.includes("電気代")) ?? "";
      expect(note).toContain("目安");
      expect(note).toContain("36L");
      expect(note).toContain("25L");
    });

    it("says the basis of an electricity estimate is unknown when the page gives none", () => {
      const calc = calculateWaterServerCost({
        ...base,
        cancellationFeeJpy: 0,
        minimumTermMonths: 24,
        electricityIsEstimate: true,
      });
      const note = calc.assumptions.find((a) => a.includes("電気代")) ?? "";
      expect(note).toContain("目安");
      expect(note).toContain("算出条件");
      expect(note).not.toContain("36L");
    });

    it("adds no electricity note when the amount is not an estimate", () => {
      const calc = calculateWaterServerCost({ ...base, cancellationFeeJpy: 0, minimumTermMonths: 24 });
      expect(calc.assumptions.some((a) => a.includes("電気代"))).toBe(false);
    });
  });

  it("subtracts buyback costs and stays UNKNOWN without an assessed amount", () => {
    const calc = calculateBuybackNet({
      offerId: "offer-buyback-1",
      title: "Game buyback",
      assessedJpy: 10000,
      outboundShippingJpy: 0,
      returnShippingJpy: 700,
      packingKitJpy: 0,
    });
    expect(calc.netJpy).toBe(9300);
    const unknown = calculateBuybackNet({
      offerId: "offer-buyback-2",
      title: "Book buyback",
      assessedJpy: "UNKNOWN",
      outboundShippingJpy: 0,
      returnShippingJpy: 0,
      packingKitJpy: 0,
    });
    expect(unknown.netJpy).toBe("UNKNOWN");
    expect(unknown.breakdown[0]!.amountJpy).toBe("UNKNOWN");
  });
});

describe("reader-facing labels and assumptions are Japanese", () => {
  it("SIM: labels use 円/ヶ月 and the discount reads as a month range", () => {
    const calc = calculateSimTotalCost({
      offerId: "offer-sim-a",
      title: "SIM A 20GB",
      monthlyJpy: 2980,
      dataGb: 20,
      initialFeeJpy: 3300,
      months: 24,
      discountPeriods: [{ fromMonth: 1, toMonth: 6, monthlyJpy: 1080 }],
      universalServiceFeeJpy: 2,
    });
    expect(calc.breakdown).toEqual([
      { label: "初期費用", amountJpy: 3300 },
      { label: "月額料金（24ヶ月 × 月2,980円）", amountJpy: 71520 },
      { label: "割引（1〜6ヶ月目 × 月1,900円）", amountJpy: -11400 },
      { label: "ユニバーサルサービス料（24ヶ月）", amountJpy: 48 },
    ]);
    expect(calc.assumptions).toEqual([
      "比較期間は24ヶ月",
      "プランのデータ容量: 月20GB",
      "期間中の解約・プラン変更は想定しない",
    ]);
  });

  it("SIM: UNKNOWN rows keep Japanese labels", () => {
    const calc = calculateSimTotalCost({
      offerId: "offer-sim-b",
      title: "SIM B",
      monthlyJpy: "UNKNOWN",
      dataGb: "UNKNOWN",
      initialFeeJpy: "UNKNOWN",
      months: 12,
      discountPeriods: [{ fromMonth: 1, toMonth: 3, monthlyJpy: 980 }],
      universalServiceFeeJpy: "UNKNOWN",
    });
    expect(calc.breakdown.map((row) => row.label)).toEqual([
      "初期費用",
      "月額料金（12ヶ月）",
      "割引（1〜3ヶ月目）",
      "ユニバーサルサービス料",
    ]);
    expect(calc.assumptions).toContain("プランのデータ容量: UNKNOWN");
  });

  it("fiber: labels, assumptions and monthly conversion use 円/ヶ月", () => {
    const calc = calculateFiberTotalCost({
      offerId: "offer-fiber-1",
      title: "Fiber 1G mansion",
      monthlyJpy: 5390,
      months: 24,
      installationFeeJpy: 44000,
      installationFeeMonths: 24,
      contractTermMonths: 24,
      cancellationFeeJpy: 1000,
      apartmentType: "mansion",
    });
    expect(calc.breakdown).toEqual([
      { label: "月額料金（24ヶ月 × 月5,390円）", amountJpy: 129360 },
      { label: "工事費", amountJpy: 44000 },
    ]);
    expect(calc.assumptions).toEqual([
      "住居タイプ: 集合住宅（マンション）",
      "比較期間は24ヶ月で、期間中の解約は想定しない",
      "契約期間: 24ヶ月",
      "契約解除料: 1,000円（解約しない前提のため総額には含めない）",
      "工事費の月額換算: 1,833円/月",
    ]);
  });

  it("fiber: UNKNOWN conditions and detached houses stay Japanese", () => {
    const calc = calculateFiberTotalCost({
      offerId: "offer-fiber-2",
      title: "Fiber house",
      monthlyJpy: "UNKNOWN",
      months: 24,
      installationFeeJpy: "UNKNOWN",
      installationFeeMonths: 24,
      contractTermMonths: "UNKNOWN",
      cancellationFeeJpy: "UNKNOWN",
      apartmentType: "kodate",
    });
    expect(calc.breakdown.map((row) => row.label)).toEqual(["月額料金（24ヶ月）", "工事費"]);
    expect(calc.assumptions).toEqual([
      "住居タイプ: 戸建て",
      "比較期間は24ヶ月で、期間中の解約は想定しない",
      "契約期間: UNKNOWN",
      "契約解除料: UNKNOWN（解約しない前提のため総額には含めない）",
      "工事費の月額換算: UNKNOWN",
    ]);
  });

  it("water server: labels and assumptions use 円/ヶ月/L", () => {
    const calc = calculateWaterServerCost({
      offerId: "offer-water-1",
      title: "Water 24L",
      waterChargeJpy: 4100,
      shippingFeeJpy: 260,
      electricityFeeJpy: 250,
      months: 12,
      initialFeeJpy: 0,
      cancellationFeeJpy: 11000,
      monthlyLiters: 24,
    });
    expect(calc.breakdown).toEqual([
      { label: "水代（12ヶ月 × 月4,100円）", amountJpy: 49200 },
      { label: "配送料（12ヶ月 × 月260円）", amountJpy: 3120 },
      { label: "電気代（12ヶ月 × 月250円）", amountJpy: 3000 },
      { label: "初期費用", amountJpy: 0 },
    ]);
    expect(calc.assumptions).toEqual([
      "比較期間は12ヶ月",
      "使用量: 月24L（12ヶ月分）",
      "期間中のプラン変更・休止・解約は想定しない",
      "契約解除料: 11,000円（条件の記載のみで総額には含めない）",
    ]);
  });

  it("water server: UNKNOWN rows keep Japanese labels", () => {
    const calc = calculateWaterServerCost({
      offerId: "offer-water-2",
      title: "Water unknown",
      waterChargeJpy: "UNKNOWN",
      shippingFeeJpy: "UNKNOWN",
      electricityFeeJpy: "UNKNOWN",
      months: 12,
      initialFeeJpy: "UNKNOWN",
      cancellationFeeJpy: "UNKNOWN",
      monthlyLiters: 24,
    });
    expect(calc.breakdown.map((row) => row.label)).toEqual([
      "水代（12ヶ月）",
      "配送料（12ヶ月）",
      "電気代（12ヶ月）",
      "初期費用",
    ]);
    expect(calc.assumptions).toContain("契約解除料: UNKNOWN（条件の記載のみで総額には含めない）");
  });

  it("buyback: labels and assumptions are Japanese", () => {
    const calc = calculateBuybackNet({
      offerId: "offer-buyback-1",
      title: "Game buyback",
      assessedJpy: 10000,
      outboundShippingJpy: 0,
      returnShippingJpy: 700,
      packingKitJpy: "UNKNOWN",
    });
    expect(calc.breakdown).toEqual([
      { label: "査定額（見込み）", amountJpy: 10000 },
      { label: "発送時の送料", amountJpy: 0 },
      { label: "返送料（買取を断る場合）", amountJpy: -700 },
      { label: "梱包キット", amountJpy: "UNKNOWN" },
    ]);
    expect(calc.assumptions).toEqual([
      "査定額は見込みであり、確定価格は最終査定で決まります",
      "返送料は買取を断った場合にのみ発生します",
    ]);
  });
});

describe("structured comparison period", () => {
  it("sim, fiber and water expose the comparison period in months", () => {
    const sim = calculateSimTotalCost({ offerId: "a", title: "A", monthlyJpy: 2980, dataGb: 20, initialFeeJpy: 0, months: 24 });
    const fiber = calculateFiberTotalCost({
      offerId: "f",
      title: "F",
      monthlyJpy: 5000,
      months: 36,
      installationFeeJpy: 0,
      installationFeeMonths: 36,
      contractTermMonths: 36,
      cancellationFeeJpy: 0,
      apartmentType: "kodate",
    });
    const water = calculateWaterServerCost({
      offerId: "w",
      title: "W",
      waterChargeJpy: 4000,
      shippingFeeJpy: 0,
      electricityFeeJpy: 0,
      months: 12,
      initialFeeJpy: 0,
      cancellationFeeJpy: 0,
      monthlyLiters: 24,
    });
    expect([sim.comparisonMonths, fiber.comparisonMonths, water.comparisonMonths]).toEqual([24, 36, 12]);
  });
});

describe("unknownLabel (the 不明点 column must not show input keys)", () => {
  it.each([
    ["monthlyJpy", "月額料金"],
    ["initialFeeJpy", "初期費用"],
    ["dataGb", "データ容量"],
    ["universalServiceFeeJpy", "ユニバーサルサービス料"],
    ["installationFeeJpy", "工事費"],
    ["waterChargeJpy", "水代"],
    ["shippingFeeJpy", "配送料"],
    ["electricityFeeJpy", "電気代"],
    ["assessedJpy", "査定額"],
    ["outboundShippingJpy", "発送時の送料"],
    ["returnShippingJpy", "返送料"],
    ["packingKitJpy", "梱包キット"],
    ["discount 1-6", "割引（1〜6ヶ月目）"],
  ])("labels %s as %s", (key, label) => {
    expect(unknownLabel(key)).toBe(label);
  });

  it("does not leak an identifier it has no label for", () => {
    expect(unknownLabel("someNewFeeJpy")).toBe("その他の未確認項目");
  });

  it("has a Japanese label for every key any calculator can report as unknown", () => {
    const U = "UNKNOWN" as const;
    const keys = [
      ...calculateSimTotalCost({
        offerId: "s",
        title: "s",
        monthlyJpy: U,
        dataGb: U,
        initialFeeJpy: U,
        months: 24,
        discountPeriods: [{ fromMonth: 1, toMonth: 6, monthlyJpy: U }],
        universalServiceFeeJpy: U,
      }).unknowns,
      ...calculateFiberTotalCost({
        offerId: "f",
        title: "f",
        monthlyJpy: U,
        months: 24,
        installationFeeJpy: U,
        installationFeeMonths: 24,
        contractTermMonths: U,
        cancellationFeeJpy: U,
        apartmentType: "mansion",
      }).unknowns,
      ...calculateWaterServerCost({
        offerId: "w",
        title: "w",
        waterChargeJpy: U,
        shippingFeeJpy: U,
        electricityFeeJpy: U,
        months: 24,
        initialFeeJpy: U,
        cancellationFeeJpy: U,
        monthlyLiters: 25,
      }).unknowns,
      ...calculateBuybackNet({
        offerId: "b",
        title: "b",
        assessedJpy: U,
        outboundShippingJpy: U,
        returnShippingJpy: U,
        packingKitJpy: U,
      }).unknowns,
    ];
    expect(keys.length).toBeGreaterThanOrEqual(13);
    for (const key of keys) {
      expect(unknownLabel(key), key).toMatch(/[぀-ヿ一-鿿]/);
      expect(unknownLabel(key), key).not.toBe("その他の未確認項目");
    }
  });
});

describe("cost matrix", () => {
  it("sorts cheapest first and sinks UNKNOWN rows", () => {
    const a = calculateSimTotalCost({ offerId: "a", title: "A", monthlyJpy: 2980, dataGb: 20, initialFeeJpy: 0, months: 12 });
    const b = calculateSimTotalCost({ offerId: "b", title: "B", monthlyJpy: 1980, dataGb: 20, initialFeeJpy: 0, months: 12 });
    const c = calculateSimTotalCost({ offerId: "c", title: "C", monthlyJpy: "UNKNOWN", dataGb: 20, initialFeeJpy: 0, months: 12 });
    const { rows } = buildCostMatrix([a, b, c]);
    expect(rows.map((r) => r.offerId)).toEqual(["b", "a", "c"]);
    expect(rows[2]!.totalJpy).toBe("UNKNOWN");
  });

  it("refuses to publish a matrix that is mostly UNKNOWN", () => {
    const c = calculateSimTotalCost({ offerId: "c", title: "C", monthlyJpy: "UNKNOWN", dataGb: 20, initialFeeJpy: 0, months: 12 });
    expect(() => buildCostMatrix([c], { maxUnknowns: 0 })).toThrow(/UNKNOWN/);
  });
});

describe("decision matrix", () => {
  it("fills UNKNOWN for missing conditions instead of guessing", () => {
    const matrix = buildDecisionMatrix(
      [{ offerId: "a", title: "A", conditions: { monthlyJpy: 2980, coverageArea: "nationwide" } }],
      [
        { id: "monthlyJpy", label: "monthly fee" },
        { id: "cancellationFeeJpy", label: "cancellation fee" },
        { id: "coverageArea", label: "service area" },
      ],
    );
    const cancellation = matrix.cells.find((c) => c.criterionId === "cancellationFeeJpy");
    expect(cancellation?.value).toBe("UNKNOWN");
  });
});

describe("B000C opportunity scoring", () => {
  const serp: SerpObservation[] = [
    obs(1, "comparison", "OK"),
    obs(2, "official", "OK"),
    obs(3, "media", "OK"),
  ];

  it("weights dimensions and returns UNKNOWN totals when evidence is missing", () => {
    const score = scoreOpportunity({
      verticalId: "mobile",
      keyword: "20GB cheap SIM comparison",
      demand: { score: "UNKNOWN", evidence: [] },
      competition: { score: 7, evidence: ["top10 has few comparison pages"] },
      friction: { score: 8, evidence: ["online application only"] },
      monetization: { score: "UNKNOWN", evidence: [] },
      autonomy: { score: 9, evidence: ["official price pages are complete"] },
    });
    expect(score.weightedTotal).toBe("UNKNOWN");
    expect(score.notes.join("\n")).toContain("UNKNOWN");
    expect(score.evidenceCoverage).toBeCloseTo(3 / 5);
  });

  it("computes weighted totals when every dimension has evidence", () => {
    const score = scoreOpportunity({
      verticalId: "mobile",
      keyword: "20GB cheap SIM comparison",
      demand: { score: 8, evidence: ["keyword planner available"] },
      competition: { score: 7, evidence: ["x"] },
      friction: { score: 8, evidence: ["x"] },
      monetization: { score: 6, evidence: ["x"] },
      autonomy: { score: 9, evidence: ["x"] },
    });
    const expected = 8 * 0.2 + 7 * 0.2 + 8 * 0.2 + 6 * 0.25 + 9 * 0.15;
    expect(score.weightedTotal).toBeCloseTo(expected);
  });

  it("detects SERP gaps without inventing competitor counts", () => {
    const gaps = competitionGaps(serp);
    expect(gaps.comparisonShare).toBeCloseTo(1 / 3);
    expect(gaps.gapNote).toContain("dominate");
    const fewComparisons = competitionGaps([
      obs(1, "comparison", "OK"),
      obs(2, "official", "OK"),
      obs(3, "media", "OK"),
      obs(4, "media", "OK"),
      obs(5, "corporate", "OK"),
    ]);
    expect(fewComparisons.gapNote).toContain("differentiation");
    const none = competitionGaps([]);
    expect(none.comparisonShare).toBe("UNKNOWN");
    expect(none.gapNote).toContain("UNKNOWN");
  });
});

function obs(position: number, pageType: SerpObservation["pageType"], accessStatus: "OK" | "UNKNOWN"): SerpObservation {
  return {
    id: `serp-${position}`,
    keyword: "20GB cheap SIM comparison",
    capturedAt: "2026-10-24T00:00:00Z",
    country: "JP",
    language: "ja",
    device: "mobile",
    position,
    url: `https://result${position}.example.com`,
    pageType,
    serpFeatures: [],
    accessStatus,
  };
}
