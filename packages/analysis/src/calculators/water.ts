import {
  FORMULA_VERSION,
  type CalcCondition,
  type Known,
  type TotalCostCalculation,
  type WaterServerOfferInput,
} from "../types.js";
import { monthsLabel, yen, yenOrUnknown } from "./format.js";

const UNKNOWN_NOT_CONFIRMED = "UNKNOWN（公式ページで確認できていません）";

function yenText(amount: number): string {
  return `${amount.toLocaleString("ja-JP")}円`;
}

function electricityNote(input: WaterServerOfferInput): string | undefined {
  if (!input.electricityIsEstimate) return undefined;
  const basis = input.electricityBasisLiters;
  if (basis === undefined) {
    return "電気代は公式が示す目安を使用しています。算出条件は確認できておらず、実際の電気代は使い方で変わります。";
  }
  const differs = basis === input.monthlyLiters ? "" : `想定使用量（月${input.monthlyLiters}L）とは条件が異なり、`;
  return `電気代は公式が示す目安（月${basis}L使用時の算出）を使用しています。${differs}実際の電気代は使い方で変わります。`;
}

function waterConditions(input: WaterServerOfferInput): { conditions: CalcCondition[]; warnings: string[] } {
  const fee = input.cancellationFeeJpy;
  const term = input.minimumTermMonths;
  const feeText = fee === "UNKNOWN" ? UNKNOWN_NOT_CONFIRMED : yenText(fee);
  const conditions: CalcCondition[] = [
    { label: "契約解除料", value: feeText, known: fee !== "UNKNOWN" },
    term === undefined || term === "UNKNOWN"
      ? { label: "最低利用期間", value: UNKNOWN_NOT_CONFIRMED, known: false }
      : { label: "最低利用期間", value: `${term}ヶ月`, known: true },
  ];
  const warnings: string[] = [];
  if (term !== undefined && term !== "UNKNOWN" && input.months < term) {
    const amount = fee === "UNKNOWN" ? "UNKNOWN" : yenText(fee);
    warnings.push(
      `比較期間（${input.months}ヶ月）は最低利用期間（${term}ヶ月）より短くなっています。最低利用期間内に解約すると契約解除料が発生する場合があります（金額: ${amount}）。契約解除料は総額に含めていません。`,
    );
  }
  return { conditions, warnings };
}

/**
 * Water server running cost: (water + shipping + electricity) × months +
 * initial fee. Cancellation fee stays out of the total (condition only).
 */
export function calculateWaterServerCost(input: WaterServerOfferInput): TotalCostCalculation {
  const unknowns: string[] = [];
  const breakdown: TotalCostCalculation["breakdown"] = [];
  let total = 0;

  const components: { key: string; label: string; value: Known<number> }[] = [
    { key: "waterChargeJpy", label: "水代", value: input.waterChargeJpy },
    { key: "shippingFeeJpy", label: "配送料", value: input.shippingFeeJpy },
    { key: "electricityFeeJpy", label: "電気代", value: input.electricityFeeJpy },
  ];
  for (const c of components) {
    if (c.value === "UNKNOWN") {
      unknowns.push(c.key);
      breakdown.push({ label: `${c.label}（${monthsLabel(input.months)}）`, amountJpy: "UNKNOWN" });
    } else {
      const amount = c.value * input.months;
      total += amount;
      breakdown.push({
        label: `${c.label}（${monthsLabel(input.months)} × 月${yen(c.value)}）`,
        amountJpy: amount,
      });
    }
  }

  if (input.initialFeeJpy === "UNKNOWN") {
    unknowns.push("initialFeeJpy");
    breakdown.push({ label: "初期費用", amountJpy: "UNKNOWN" });
  } else {
    total += input.initialFeeJpy;
    breakdown.push({ label: "初期費用", amountJpy: input.initialFeeJpy });
  }

  const totalJpy: Known<number> = unknowns.length > 0 ? "UNKNOWN" : total;
  const monthlyAverageJpy: Known<number> = totalJpy === "UNKNOWN" ? "UNKNOWN" : Math.round(total / input.months);
  const { conditions, warnings } = waterConditions(input);
  const estimateNote = electricityNote(input);

  return {
    offerId: input.offerId,
    title: input.title,
    formulaVersion: FORMULA_VERSION,
    formula: "totalJpy = (waterChargeJpy + shippingFeeJpy + electricityFeeJpy) * months + initialFeeJpy",
    comparisonMonths: input.months,
    assumptions: [
      `比較期間は${monthsLabel(input.months)}`,
      `使用量: 月${input.monthlyLiters}L（${monthsLabel(input.months)}分）`,
      "期間中のプラン変更・休止・解約は想定しない",
      `契約解除料: ${yenOrUnknown(input.cancellationFeeJpy)}（条件の記載のみで総額には含めない）`,
      ...(estimateNote ? [estimateNote] : []),
    ],
    totalJpy,
    monthlyAverageJpy,
    breakdown,
    unknowns,
    conditions,
    ...(typeof input.minimumTermMonths === "number" ? { minimumTermMonths: input.minimumTermMonths } : {}),
    warnings,
  };
}
