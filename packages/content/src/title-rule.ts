import type { AffiliateOffer } from "@aff/domain";

/**
 * An advertiser's program terms can forbid a page title that begins with, or is mostly,
 * the advertiser's own name or service name. The words are kept on the offer as
 * `constraints.trademark_terms`, separated by "|", so the rule is checked by code and
 * not by anyone remembering it.
 */
const TERM_SEPARATOR = "|";
/** More than this share of the title being the name counts as "most of the title". */
const MAJORITY_SHARE = 0.5;

/** Width variants, case and spacing do not make a title different from the name. */
const squash = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");

export function trademarkTermsOf(offer: Pick<AffiliateOffer, "constraints">): string[] {
  const raw = offer.constraints.trademark_terms;
  if (typeof raw !== "string") return [];
  return raw
    .split(TERM_SEPARATOR)
    .map((term) => squash(term))
    .filter((term) => term.length > 0);
}

/** Why `title` breaks the rule for these (already squashed) terms, or `undefined` when it keeps it. */
export function titleRuleViolation(title: string, terms: readonly string[]): string | undefined {
  if (terms.length === 0) return undefined;
  const squashed = squash(title);
  // Brackets and marks in front of the title do not move the name away from its start.
  const start = squashed.replace(/^[^\p{L}\p{N}]+/u, "");
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  if (ordered.some((term) => start.startsWith(term))) return "タイトルの冒頭が広告主の名称です";

  let remaining = squashed;
  let matched = 0;
  for (const term of ordered) {
    const parts = remaining.split(term);
    matched += (parts.length - 1) * term.length;
    remaining = parts.join("\u0000");
  }
  return squashed.length > 0 && matched / squashed.length > MAJORITY_SHARE ? "タイトルの過半が広告主の名称です" : undefined;
}
