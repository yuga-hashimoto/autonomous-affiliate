/**
 * B007: normalized, calculable inputs. Any value the official sources do not
 * provide is the literal string "UNKNOWN" — calculators must propagate it
 * instead of assuming 0 (docs/05: unknown amounts must not be confirmed as 0 yen).
 */
export type Known<T> = T | "UNKNOWN";

export const FORMULA_VERSION = "analysis-formulas-v1";

export interface SimOfferInput {
  offerId: string;
  title: string;
  monthlyJpy: Known<number>;
  dataGb: Known<number>;
  initialFeeJpy: Known<number>;
  /** e.g. 24 for a 2-year comparison. */
  months: number;
  /** Price cuts like "6 months at 1,080 yen": list of {fromMonth,toMonth,monthlyJpy}. */
  discountPeriods?: { fromMonth: number; toMonth: number; monthlyJpy: Known<number> }[];
  universalServiceFeeJpy?: Known<number>;
}

export interface FiberOfferInput {
  offerId: string;
  title: string;
  monthlyJpy: Known<number>;
  months: number;
  installationFeeJpy: Known<number>;
  /** Months over which the installation fee is split as a "monthly conversion" figure. */
  installationFeeMonths: number;
  contractTermMonths: Known<number>;
  cancellationFeeJpy: Known<number>;
  apartmentType: "mansion" | "kodate";
}

export interface WaterServerOfferInput {
  offerId: string;
  title: string;
  waterChargeJpy: Known<number>;
  shippingFeeJpy: Known<number>;
  electricityFeeJpy: Known<number>;
  months: number;
  initialFeeJpy: Known<number>;
  cancellationFeeJpy: Known<number>;
  monthlyLiters: number;
  /** Minimum contract term stated by the provider; absent is shown as UNKNOWN, never as "none". */
  minimumTermMonths?: Known<number>;
  /** The electricity amount is the provider's own estimate, not a metered or fixed fee. */
  electricityIsEstimate?: boolean;
  /** Monthly water volume the provider used to compute that estimate, when it says so. */
  electricityBasisLiters?: number;
}

export interface BuybackOfferInput {
  offerId: string;
  title: string;
  /** Assessed amount is only an estimate until the final valuation. */
  assessedJpy: Known<number>;
  outboundShippingJpy: Known<number>;
  returnShippingJpy: Known<number>;
  packingKitJpy: Known<number>;
}

export interface BuybackCalculation {
  offerId: string;
  title: string;
  formulaVersion: string;
  formula: string;
  assumptions: string[];
  netJpy: Known<number>;
  breakdown: { label: string; amountJpy: Known<number> }[];
  unknowns: string[];
}

/** A term a reader needs that is kept out of the total (cancellation fee, minimum term). */
export interface CalcCondition {
  label: string;
  value: string;
  /** false when the value is UNKNOWN: the official page was not found to state it. */
  known: boolean;
}

export interface TotalCostCalculation {
  offerId: string;
  title: string;
  formulaVersion: string;
  formula: string;
  /** Comparison window in months; read by QA instead of parsing `assumptions` prose. */
  comparisonMonths: number;
  assumptions: string[];
  totalJpy: Known<number>;
  monthlyAverageJpy: Known<number>;
  breakdown: { label: string; amountJpy: Known<number> }[];
  /** Inputs that make the total UNKNOWN. */
  unknowns: string[];
  /** Terms outside the total; unknown ones are surfaced next to the total. */
  conditions?: CalcCondition[];
  /** Minimum contract term in months when the official page states it; absent otherwise (charts read this, not `conditions`). */
  minimumTermMonths?: number;
  /** Cautions about reading the total (for example, period shorter than the minimum term). */
  warnings?: string[];
}
