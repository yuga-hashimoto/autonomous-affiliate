import {
  FORMULA_VERSION,
  type FiberOfferInput,
  type Known,
  type TotalCostCalculation,
} from "../types.js";
import { monthsLabel, yen, yenOrUnknown } from "./format.js";

/**
 * Fiber effective cost: (installation fee + monthly × months) over the
 * comparison window; contract term + cancellation fee are surfaced as
 * conditions, never folded into the total unless a cancellation occurs.
 */
export function calculateFiberTotalCost(input: FiberOfferInput): TotalCostCalculation {
  const unknowns: string[] = [];
  const breakdown: TotalCostCalculation["breakdown"] = [];
  let total = 0;

  if (input.monthlyJpy === "UNKNOWN") {
    unknowns.push("monthlyJpy");
    breakdown.push({ label: `月額料金（${monthsLabel(input.months)}）`, amountJpy: "UNKNOWN" });
  } else {
    const monthly = input.monthlyJpy * input.months;
    total += monthly;
    breakdown.push({
      label: `月額料金（${monthsLabel(input.months)} × 月${yen(input.monthlyJpy)}）`,
      amountJpy: monthly,
    });
  }

  if (input.installationFeeJpy === "UNKNOWN") {
    unknowns.push("installationFeeJpy");
    breakdown.push({ label: "工事費", amountJpy: "UNKNOWN" });
  } else {
    total += input.installationFeeJpy;
    breakdown.push({ label: "工事費", amountJpy: input.installationFeeJpy });
  }

  const installationMonthly: Known<number> =
    input.installationFeeJpy === "UNKNOWN"
      ? "UNKNOWN"
      : Math.round(input.installationFeeJpy / input.installationFeeMonths);

  const totalJpy: Known<number> = unknowns.length > 0 ? "UNKNOWN" : total;
  const monthlyAverageJpy: Known<number> = totalJpy === "UNKNOWN" ? "UNKNOWN" : Math.round(total / input.months);

  return {
    offerId: input.offerId,
    title: input.title,
    formulaVersion: FORMULA_VERSION,
    formula:
      "totalJpy = monthlyJpy * months + installationFeeJpy; installation monthly conversion = installationFeeJpy / installationFeeMonths",
    comparisonMonths: input.months,
    assumptions: [
      `住居タイプ: ${input.apartmentType === "mansion" ? "集合住宅（マンション）" : "戸建て"}`,
      `比較期間は${monthsLabel(input.months)}で、期間中の解約は想定しない`,
      `契約期間: ${input.contractTermMonths === "UNKNOWN" ? "UNKNOWN" : monthsLabel(input.contractTermMonths)}`,
      `契約解除料: ${yenOrUnknown(input.cancellationFeeJpy)}（解約しない前提のため総額には含めない）`,
      `工事費の月額換算: ${installationMonthly === "UNKNOWN" ? "UNKNOWN" : `${yen(installationMonthly)}/月`}`,
    ],
    totalJpy,
    monthlyAverageJpy,
    breakdown,
    unknowns,
  };
}
