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
