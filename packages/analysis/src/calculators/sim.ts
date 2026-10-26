import { FORMULA_VERSION, type Known, type SimOfferInput, type TotalCostCalculation } from "../types.js";
import { monthsLabel, yen } from "./format.js";

function allKnown(...values: Known<unknown>[]): boolean {
  return values.every((v) => v !== "UNKNOWN");
}

/**
 * SIM total cost: initial fee + Σ monthly (discount periods applied).
 * Pure integer arithmetic so QA can recompute it exactly.
 */
export function calculateSimTotalCost(input: SimOfferInput): TotalCostCalculation {
  const unknowns: string[] = [];
  if (input.monthlyJpy === "UNKNOWN") unknowns.push("monthlyJpy");
  if (input.initialFeeJpy === "UNKNOWN") unknowns.push("initialFeeJpy");
  if (input.dataGb === "UNKNOWN") unknowns.push("dataGb");

  const breakdown: TotalCostCalculation["breakdown"] = [];
  let total = 0;

  if (input.initialFeeJpy === "UNKNOWN") {
    breakdown.push({ label: "初期費用", amountJpy: "UNKNOWN" });
  } else {
    total += input.initialFeeJpy;
    breakdown.push({ label: "初期費用", amountJpy: input.initialFeeJpy });
  }

  let monthlyTotal = 0;
  if (input.monthlyJpy === "UNKNOWN") {
    breakdown.push({ label: `月額料金（${monthsLabel(input.months)}）`, amountJpy: "UNKNOWN" });
  } else {
    monthlyTotal = input.monthlyJpy * input.months;
    total += monthlyTotal;
    breakdown.push({
      label: `月額料金（${monthsLabel(input.months)} × 月${yen(input.monthlyJpy)}）`,
      amountJpy: monthlyTotal,
    });
  }

  if (input.discountPeriods) {
    for (const period of input.discountPeriods) {
      const months = period.toMonth - period.fromMonth + 1;
      const range = `${period.fromMonth}〜${period.toMonth}ヶ月目`;
      if (period.monthlyJpy === "UNKNOWN" || input.monthlyJpy === "UNKNOWN") {
        unknowns.push(`discount ${period.fromMonth}-${period.toMonth}`);
        breakdown.push({ label: `割引（${range}）`, amountJpy: "UNKNOWN" });
        continue;
      }
      const discount = (input.monthlyJpy - period.monthlyJpy) * months;
      total -= discount;
      breakdown.push({
        label: `割引（${range} × 月${yen(discount / months)}）`,
        amountJpy: -discount,
      });
    }
  }

  if (input.universalServiceFeeJpy !== undefined) {
    if (input.universalServiceFeeJpy === "UNKNOWN") {
      unknowns.push("universalServiceFeeJpy");
      breakdown.push({ label: "ユニバーサルサービス料", amountJpy: "UNKNOWN" });
    } else {
      const fee = Math.round(input.universalServiceFeeJpy * input.months);
      total += fee;
      breakdown.push({ label: `ユニバーサルサービス料（${monthsLabel(input.months)}）`, amountJpy: fee });
    }
  }

  const totalJpy: Known<number> = unknowns.some((u) => u !== "dataGb") ? "UNKNOWN" : total;
  const monthlyAverageJpy: Known<number> = totalJpy === "UNKNOWN" ? "UNKNOWN" : Math.round(total / input.months);

  return {
    offerId: input.offerId,
    title: input.title,
    formulaVersion: FORMULA_VERSION,
    formula:
      "totalJpy = initialFeeJpy + monthlyJpy * months - Σ(discount JPY × discount months) + universalServiceFeeJpy * months",
    comparisonMonths: input.months,
    assumptions: [
      `比較期間は${monthsLabel(input.months)}`,
      allKnown(input.dataGb) ? `プランのデータ容量: 月${String(input.dataGb)}GB` : "プランのデータ容量: UNKNOWN",
      "期間中の解約・プラン変更は想定しない",
    ],
    totalJpy,
    monthlyAverageJpy,
    breakdown,
    unknowns,
  };
}

/** Independent recomputation used by QA and tests to verify the calculator. */
export function verifySimTotalCost(
  input: SimOfferInput,
  calculation: TotalCostCalculation,
): { ok: boolean; expected: Known<number> } {
  if (input.monthlyJpy === "UNKNOWN" || input.initialFeeJpy === "UNKNOWN") {
    return { ok: calculation.totalJpy === "UNKNOWN", expected: "UNKNOWN" };
  }
  let expected = input.initialFeeJpy + input.monthlyJpy * input.months;
  if (input.discountPeriods) {
    for (const p of input.discountPeriods) {
      if (p.monthlyJpy === "UNKNOWN") return { ok: calculation.totalJpy === "UNKNOWN", expected: "UNKNOWN" };
      expected -= (input.monthlyJpy - p.monthlyJpy) * (p.toMonth - p.fromMonth + 1);
    }
  }
  if (input.universalServiceFeeJpy !== undefined) {
    if (input.universalServiceFeeJpy === "UNKNOWN") return { ok: calculation.totalJpy === "UNKNOWN", expected: "UNKNOWN" };
    expected += Math.round(input.universalServiceFeeJpy * input.months);
  }
  return { ok: calculation.totalJpy === expected, expected };
}
