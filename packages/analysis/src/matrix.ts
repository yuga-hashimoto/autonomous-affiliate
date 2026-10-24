import type { Known, TotalCostCalculation } from "./types.js";

export interface MatrixRow {
  offerId: string;
  title: string;
  totalJpy: Known<number>;
  monthlyAverageJpy: Known<number>;
  unknowns: string[];
}

/**
 * Builds a comparison matrix with a single, uniform billing unit
 * (docs requirement: currency, plan period, and billing unit must be aligned).
 * Rows sort cheapest-first; UNKNOWN rows always sink below every known row and
 * keep their unknown list so they are never presented as cheap (no 0-yen display).
 */
export function buildCostMatrix(
  calculations: TotalCostCalculation[],
  options: { maxUnknowns?: number } = {},
): { rows: MatrixRow[]; uniformUnit: string } {
  const rows: MatrixRow[] = calculations.map((c) => ({
    offerId: c.offerId,
    title: c.title,
    totalJpy: c.totalJpy,
    monthlyAverageJpy: c.monthlyAverageJpy,
    unknowns: c.unknowns,
  }));
  rows.sort((a, b) => {
    if (a.totalJpy === "UNKNOWN" && b.totalJpy === "UNKNOWN") return 0;
    if (a.totalJpy === "UNKNOWN") return 1;
    if (b.totalJpy === "UNKNOWN") return -1;
    return a.totalJpy - b.totalJpy;
  });
  const unknownCount = rows.filter((r) => r.totalJpy === "UNKNOWN").length;
  if (options.maxUnknowns !== undefined && unknownCount > options.maxUnknowns) {
    // Too much missing data to compare meaningfully: refuse rather than guess.
    throw new Error(
      `cost matrix has ${unknownCount} UNKNOWN totals (max ${options.maxUnknowns}); refusing to publish a comparison without official prices`,
    );
  }
  return { rows, uniformUnit: "JPY / total for the same number of months / tax-inclusive and tax-exclusive treated together" };
}

export interface DecisionCriterion {
  id: string;
  label: string;
}

export interface DecisionMatrixCell {
  offerId: string;
  criterionId: string;
  value: Known<string | number>;
}

export interface DecisionMatrix {
  criteria: DecisionCriterion[];
  cells: DecisionMatrixCell[];
}

/** Conditions-anchored decision table: values come from normalized facts only. */
export function buildDecisionMatrix(
  offers: { offerId: string; title: string; conditions: Record<string, Known<string | number>> }[],
  criteria: DecisionCriterion[],
): DecisionMatrix {
  const cells: DecisionMatrixCell[] = [];
  for (const offer of offers) {
    for (const criterion of criteria) {
      cells.push({
        offerId: offer.offerId,
        criterionId: criterion.id,
        value: offer.conditions[criterion.id] ?? "UNKNOWN",
      });
    }
  }
  return { criteria, cells };
}
