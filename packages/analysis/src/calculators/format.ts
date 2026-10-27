import type { Known } from "../types.js";

/** Reader-facing yen amount with thousands separators, e.g. 2,980円. */
export function yen(amount: number): string {
  return `${amount.toLocaleString("ja-JP")}円`;
}

/** Like `yen`, but keeps the literal UNKNOWN instead of guessing. */
export function yenOrUnknown(amount: Known<number>): string {
  return amount === "UNKNOWN" ? "UNKNOWN" : yen(amount);
}

/** Reader-facing month count, e.g. 24ヶ月. */
export function monthsLabel(count: number): string {
  return `${count}ヶ月`;
}

const UNKNOWN_INPUT_LABELS: Readonly<Record<string, string>> = {
  monthlyJpy: "月額料金",
  initialFeeJpy: "初期費用",
  dataGb: "データ容量",
  universalServiceFeeJpy: "ユニバーサルサービス料",
  installationFeeJpy: "工事費",
  waterChargeJpy: "水代",
  shippingFeeJpy: "配送料",
  electricityFeeJpy: "電気代",
  assessedJpy: "査定額",
  outboundShippingJpy: "発送時の送料",
  returnShippingJpy: "返送料",
  packingKitJpy: "梱包キット",
};

/**
 * Reader-facing name for an entry of a calculation's `unknowns` (which holds
 * input keys for machines). A key without a label reads as a generic phrase,
 * never as the identifier; the calculator tests fail when a reported key lacks one.
 */
export function unknownLabel(key: string): string {
  const label = UNKNOWN_INPUT_LABELS[key];
  if (label !== undefined) return label;
  const discount = /^discount (\d+)-(\d+)$/.exec(key);
  if (discount) return `割引（${discount[1]}〜${discount[2]}ヶ月目）`;
  return "その他の未確認項目";
}
