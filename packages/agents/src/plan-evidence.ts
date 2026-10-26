import type { Fact, SourceRecord } from "@aff/domain";
import { canonicalizeUrl } from "@aff/integrations";
import type { ArticlePlan, CalculatorEntry } from "./pipeline.js";

/**
 * A yen amount in a plan that is not copied from the page but built from
 * amounts that are: `value = Σ amountJpy × (times ?? 1)`. `times` is an
 * assumption of the comparison (bottles per month, months), not page evidence.
 */
export interface DerivedAmount {
  amountJpy: number;
  times?: number;
}

interface EvidencedField {
  path: string;
  value: number;
}

/** Non-yen inputs that are statements of the page (not assumptions of the comparison). */
const TERM_KEY = "minimumTermMonths";
const BASIS_KEY = "electricityBasisLiters";
const PAGE_STATED_KEYS: ReadonlySet<string> = new Set([TERM_KEY, BASIS_KEY]);

/**
 * These two are backed only by facts that talk about the same thing, so a
 * number of another item ("36L" of an electricity estimate) cannot pass as a
 * contract term of 36 months.
 */
const TERM_FACT = /期間|年|ヶ月|か月|カ月/;
const ELECTRICITY_FACT = /電気|消費電力|kWh/i;

function lastKey(path: string): string {
  return path.split(".").pop() ?? "";
}

function collectEvidencedFields(value: unknown, path: string, out: EvidencedField[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEvidencedFields(item, path === "" ? String(index) : `${path}.${index}`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectEvidencedFields(item, path === "" ? key : `${path}.${key}`, out);
    }
  } else if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (lastKey(path).endsWith("Jpy") || PAGE_STATED_KEYS.has(lastKey(path)))
  ) {
    out.push({ path, value });
  }
}

function unitOf(path: string): string {
  const key = lastKey(path);
  if (key === TERM_KEY) return "ヶ月";
  if (key === BASIS_KEY) return "L";
  return "円";
}

/** Numbers written in a text, thousands separators removed: "1,620円" → 1620. */
function numberTokens(text: string): number[] {
  const normalized = text.normalize("NFKC").replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  return [...normalized.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

/**
 * Facts a plan entry may rely on, of any claim type (fees sit in cancellation
 * and contract facts, not only price facts):
 * - facts that name the service, and
 * - facts extracted from the official pages of that service. A fee that applies
 *   to the whole service ("初回登録事務手数料：3,300円") rarely names a product,
 *   so linking by name alone made the check depend on how the model worded it.
 */
export function factsLinkedToEntry(
  entry: CalculatorEntry,
  facts: readonly Fact[],
  pageSourceIds: ReadonlySet<string> = new Set(),
): Fact[] {
  const terms = entry.factEvidenceTerms ?? [String(entry.input.title)];
  return facts.filter(
    (fact) =>
      terms.some((term) => term.length > 0 && fact.text.includes(term)) ||
      fact.sourceIds.some((id) => pageSourceIds.has(id)),
  );
}

function sourceIdsOfPages(urls: readonly string[], sources: readonly SourceRecord[]): Set<string> {
  const wanted = new Set(urls.map(canonicalizeUrl));
  return new Set(sources.filter((source) => wanted.has(canonicalizeUrl(source.canonicalUrl))).map((source) => source.id));
}

/**
 * Deterministic cross-check of a plan against what was extracted from the
 * official pages: every yen amount in `input` (any key ending in "Jpy", at any
 * depth) must appear as a number in a fact that names the service, a derived
 * amount must add up from components that do, and a zero needs a standalone 0
 * or the word 無料. Returns one readable issue per amount that is not backed.
 *
 * Limits, on purpose: it does not tie an amount to a particular fee (a number
 * may appear for another item), so it catches typos and invented figures, not
 * every mix-up.
 */
export function checkPlanEvidence(
  plan: Pick<ArticlePlan, "calculators"> & Partial<Pick<ArticlePlan, "sourceUrls">>,
  facts: readonly Fact[],
  sources: readonly SourceRecord[] = [],
): string[] {
  const issues: string[] = [];
  for (const entry of plan.calculators) {
    const offerId = String(entry.input.offerId);
    // A single-service plan's pages are that service's pages; with several services
    // each entry must name its own pages (evidenceSourceUrls) rather than be guessed.
    const pageUrls = entry.evidenceSourceUrls ?? (plan.calculators.length === 1 ? (plan.sourceUrls ?? []) : []);
    const linked = factsLinkedToEntry(entry, facts, sourceIdsOfPages(pageUrls, sources));
    const tokens = new Set(linked.flatMap((fact) => numberTokens(fact.text)));
    const mentionsFree = linked.some((fact) => fact.text.includes("無料"));
    const evidenced = (amount: number): boolean => (amount === 0 ? tokens.has(0) || mentionsFree : tokens.has(amount));
    const tokensOfFactsMatching = (pattern: RegExp): Set<number> =>
      new Set(linked.filter((fact) => pattern.test(fact.text)).flatMap((fact) => numberTokens(fact.text)));
    const termTokens = tokensOfFactsMatching(TERM_FACT);
    const electricityTokens = tokensOfFactsMatching(ELECTRICITY_FACT);
    // A term is stated in months or in whole years ("5年" backs 60 months).
    const termEvidenced = (months: number): boolean =>
      termTokens.has(months) || (months % 12 === 0 && termTokens.has(months / 12));
    const pageStatedEvidenced = (key: string, value: number): boolean =>
      key === TERM_KEY ? termEvidenced(value) : electricityTokens.has(value);
    const scope = linked.length === 0 ? "（このサービスに紐づく公式Factが0件）" : "";

    const fields: EvidencedField[] = [];
    collectEvidencedFields(entry.input, "", fields);
    for (const { path, value } of fields) {
      const components = entry.derivedAmounts?.[path];
      if (components === undefined) {
        const key = lastKey(path);
        const backed = PAGE_STATED_KEYS.has(key) ? pageStatedEvidenced(key, value) : evidenced(value);
        if (!backed) issues.push(`${offerId}: ${path}=${value}${unitOf(path)}が公式Factに見つかりません${scope}`);
        continue;
      }
      for (const component of components) {
        if (!evidenced(component.amountJpy)) {
          issues.push(`${offerId}: ${path}の導出に使う${component.amountJpy}円が公式Factに見つかりません${scope}`);
        }
      }
      const sum = components.reduce((total, component) => total + component.amountJpy * (component.times ?? 1), 0);
      if (sum !== value) issues.push(`${offerId}: ${path}=${value}円は導出式の合計${sum}円と一致しません`);
    }
  }
  return issues;
}
