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
    expect(calc.assumptions.join("\n")).toContain("11,000 JPY".replace("11,000 JPY", "11000 JPY"));
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
