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

export interface TotalCostCalculation {
  offerId: string;
  title: string;
  formulaVersion: string;
  formula: string;
  assumptions: string[];
  totalJpy: Known<number>;
  monthlyAverageJpy: Known<number>;
  breakdown: { label: string; amountJpy: Known<number> }[];
  unknowns: string[];
}
