import {
  FORMULA_VERSION,
  type BuybackCalculation,
  type BuybackOfferInput,
  type Known,
} from "../types.js";

/**
 * Buyback net proceeds. The assessment is only an estimate until the final
 * valuation; shipping/packing costs are subtracted, never presented as profit.
 */
export function calculateBuybackNet(input: BuybackOfferInput): BuybackCalculation {
  const unknowns: string[] = [];
  const breakdown: BuybackCalculation["breakdown"] = [];

  let net = 0;
  if (input.assessedJpy === "UNKNOWN") {
    unknowns.push("assessedJpy");
    breakdown.push({ label: "査定額（見込み）", amountJpy: "UNKNOWN" });
  } else {
    net += input.assessedJpy;
    breakdown.push({ label: "査定額（見込み）", amountJpy: input.assessedJpy });
  }

  const costs: { key: string; label: string; value: Known<number> }[] = [
    { key: "outboundShippingJpy", label: "発送時の送料", value: input.outboundShippingJpy },
    { key: "returnShippingJpy", label: "返送料（買取を断る場合）", value: input.returnShippingJpy },
    { key: "packingKitJpy", label: "梱包キット", value: input.packingKitJpy },
  ];
  for (const c of costs) {
    if (c.value === "UNKNOWN") {
      unknowns.push(c.key);
      breakdown.push({ label: c.label, amountJpy: "UNKNOWN" });
    } else if (c.value > 0) {
      net -= c.value;
      breakdown.push({ label: c.label, amountJpy: -c.value });
    } else {
      breakdown.push({ label: c.label, amountJpy: 0 });
    }
  }

  const netJpy: Known<number> = unknowns.length > 0 ? "UNKNOWN" : net;

  return {
    offerId: input.offerId,
    title: input.title,
    formulaVersion: FORMULA_VERSION,
    formula: "netJpy = assessedJpy - outboundShippingJpy - returnShippingJpy - packingKitJpy",
    assumptions: [
      "査定額は見込みであり、確定価格は最終査定で決まります",
      "返送料は買取を断った場合にのみ発生します",
    ],
    netJpy,
    breakdown,
    unknowns,
  };
}
