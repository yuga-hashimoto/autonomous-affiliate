import {
  FORMULA_VERSION,
  type Known,
  type TotalCostCalculation,
  type WaterServerOfferInput,
} from "../types.js";

/**
 * Water server running cost: (water + shipping + electricity) × months +
 * initial fee. Cancellation fee stays out of the total (condition only).
 */
export function calculateWaterServerCost(input: WaterServerOfferInput): TotalCostCalculation {
  const unknowns: string[] = [];
  const breakdown: TotalCostCalculation["breakdown"] = [];
  let total = 0;

  const components: { key: string; label: string; value: Known<number> }[] = [
    { key: "waterChargeJpy", label: "water charge", value: input.waterChargeJpy },
    { key: "shippingFeeJpy", label: "shipping fee", value: input.shippingFeeJpy },
    { key: "electricityFeeJpy", label: "electricity fee", value: input.electricityFeeJpy },
  ];
  for (const c of components) {
    if (c.value === "UNKNOWN") {
      unknowns.push(c.key);
      breakdown.push({ label: `${c.label} (${input.months} months)`, amountJpy: "UNKNOWN" });
    } else {
      const amount = c.value * input.months;
      total += amount;
      breakdown.push({ label: `${c.label} (${input.months} months × ${c.value} JPY)`, amountJpy: amount });
    }
  }

  if (input.initialFeeJpy === "UNKNOWN") {
    unknowns.push("initialFeeJpy");
    breakdown.push({ label: "initial fee", amountJpy: "UNKNOWN" });
  } else {
    total += input.initialFeeJpy;
    breakdown.push({ label: "initial fee", amountJpy: input.initialFeeJpy });
  }

  const totalJpy: Known<number> = unknowns.length > 0 ? "UNKNOWN" : total;
  const monthlyAverageJpy: Known<number> = totalJpy === "UNKNOWN" ? "UNKNOWN" : Math.round(total / input.months);

  return {
    offerId: input.offerId,
    title: input.title,
    formulaVersion: FORMULA_VERSION,
    formula: "totalJpy = (waterChargeJpy + shippingFeeJpy + electricityFeeJpy) * months + initialFeeJpy",
    assumptions: [
      `comparison period is ${input.months} months`,
      `usage: ${input.monthlyLiters}L per month for ${input.months} months`,
      "no plan change, pause, or cancellation assumed",
      `contract cancellation fee: ${input.cancellationFeeJpy === "UNKNOWN" ? "UNKNOWN" : `${input.cancellationFeeJpy} JPY`} (condition only, not included in the total)`,
    ],
    totalJpy,
    monthlyAverageJpy,
    breakdown,
    unknowns,
  };
}
