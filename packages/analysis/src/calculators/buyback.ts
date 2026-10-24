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
    breakdown.push({ label: "assessment amount (estimate)", amountJpy: "UNKNOWN" });
  } else {
    net += input.assessedJpy;
    breakdown.push({ label: "assessment amount (estimate)", amountJpy: input.assessedJpy });
  }

  const costs: { key: string; label: string; value: Known<number> }[] = [
    { key: "outboundShippingJpy", label: "outbound shipping", value: input.outboundShippingJpy },
    { key: "returnShippingJpy", label: "return shipping (on decline)", value: input.returnShippingJpy },
    { key: "packingKitJpy", label: "packing kit", value: input.packingKitJpy },
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
      "the assessment amount is only an estimate; the confirmed price is determined by the final valuation",
      "return shipping applies only when the buyback offer is declined",
    ],
    netJpy,
    breakdown,
    unknowns,
  };
}
