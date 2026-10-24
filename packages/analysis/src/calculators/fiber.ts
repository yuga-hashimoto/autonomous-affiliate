import {
  FORMULA_VERSION,
  type FiberOfferInput,
  type Known,
  type TotalCostCalculation,
} from "../types.js";

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
    breakdown.push({ label: `monthly fee (${input.months} months)`, amountJpy: "UNKNOWN" });
  } else {
    const monthly = input.monthlyJpy * input.months;
    total += monthly;
    breakdown.push({ label: `monthly fee (${input.months} months × ${input.monthlyJpy} JPY)`, amountJpy: monthly });
  }

  if (input.installationFeeJpy === "UNKNOWN") {
    unknowns.push("installationFeeJpy");
    breakdown.push({ label: "installation fee", amountJpy: "UNKNOWN" });
  } else {
    total += input.installationFeeJpy;
    breakdown.push({ label: "installation fee", amountJpy: input.installationFeeJpy });
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
    assumptions: [
      `dwelling type: ${input.apartmentType === "mansion" ? "apartment" : "detached house"}`,
      `comparison period is ${input.months} months, no mid-term cancellation assumed`,
      `contract term: ${input.contractTermMonths === "UNKNOWN" ? "UNKNOWN" : `${input.contractTermMonths} months`}`,
      `contract cancellation fee: ${input.cancellationFeeJpy === "UNKNOWN" ? "UNKNOWN" : `${input.cancellationFeeJpy} JPY`} (not included in the total because no cancellation occurs)`,
      `installation fee monthly conversion: ${installationMonthly === "UNKNOWN" ? "UNKNOWN" : `${installationMonthly} JPY/month`}`,
    ],
    totalJpy,
    monthlyAverageJpy,
    breakdown,
    unknowns,
  };
}
