import type { Fact } from "@aff/domain";
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

interface YenField {
  path: string;
  value: number;
}

function collectYenFields(value: unknown, path: string, out: YenField[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectYenFields(item, path === "" ? String(index) : `${path}.${index}`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectYenFields(item, path === "" ? key : `${path}.${key}`, out);
    }
  } else if (typeof value === "number" && Number.isFinite(value) && (path.split(".").pop() ?? "").endsWith("Jpy")) {
    out.push({ path, value });
  }
}

/** Numbers written in a text, thousands separators removed: "1,620円" → 1620. */
function numberTokens(text: string): number[] {
  const normalized = text.normalize("NFKC").replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  return [...normalized.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

/**
 * Facts a plan entry may rely on: those naming the service (any claim type,
 * because fees sit in cancellation and contract facts, not only price facts).
 */
export function factsLinkedToEntry(entry: CalculatorEntry, facts: readonly Fact[]): Fact[] {
  const terms = entry.factEvidenceTerms ?? [String(entry.input.title)];
  return facts.filter((fact) => terms.some((term) => term.length > 0 && fact.text.includes(term)));
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
export function checkPlanEvidence(plan: Pick<ArticlePlan, "calculators">, facts: readonly Fact[]): string[] {
  const issues: string[] = [];
  for (const entry of plan.calculators) {
    const offerId = String(entry.input.offerId);
    const linked = factsLinkedToEntry(entry, facts);
    const tokens = new Set(linked.flatMap((fact) => numberTokens(fact.text)));
    const mentionsFree = linked.some((fact) => fact.text.includes("無料"));
    const evidenced = (amount: number): boolean => (amount === 0 ? tokens.has(0) || mentionsFree : tokens.has(amount));
    const scope = linked.length === 0 ? "（このサービスに紐づく公式Factが0件）" : "";

    const fields: YenField[] = [];
    collectYenFields(entry.input, "", fields);
    for (const { path, value } of fields) {
      const components = entry.derivedAmounts?.[path];
      if (components === undefined) {
        if (!evidenced(value)) issues.push(`${offerId}: ${path}=${value}円が公式Factに見つかりません${scope}`);
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
