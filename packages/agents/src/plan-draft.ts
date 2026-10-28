import type { Fact, SourceRecord } from "@aff/domain";
import { sourceIdsOfPages } from "./plan-evidence.js";
import type { ArticlePlan, CalculatorEntry, PlanDraft } from "./pipeline.js";

/**
 * A plan is the article's brief plus the yen amounts its comparison is computed
 * from. `completeDraftedPlan` fills those amounts from the facts extracted from
 * the official pages (docs/18), so a plan can be kept as a brief and follow the
 * page when the page changes.
 *
 * Every rule is deterministic. A fact is used only when its own text names the
 * kind of amount (送料, 電気代, ...) and states exactly one figure for it; when the
 * facts are missing, ambiguous or disagree, the plan is not made and the reasons
 * are returned. The facts are untrusted text (an LLM read a third-party page), so
 * a model never decides which number counts, and the QA number check
 * (`checkPlanEvidence`) still runs on the result.
 */
export type DraftResult = { ok: true; plan: ArticlePlan } | { ok: false; issues: string[] };

type Tier = readonly Fact[];

const norm = (text: string): string => text.normalize("NFKC");

function yenAmounts(text: string): number[] {
  return [...norm(text).matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*円/g)].map((match) => Number(match[1]!.replace(/,/g, "")));
}

const FREE = /無料|ゼロ円/;
const ESTIMATE = /目安|約|概算|想定/;
const LITERS = /(\d+(?:\.\d+)?)\s*L/gi;

/** What a fee fact is about. A fact about two kinds is not used for either: the figure could belong to both. */
const FEE_LABELS = {
  shipping: (text: string) => /送料|配送料|配達料/.test(text),
  electricity: (text: string) => /電気代|電気料金/.test(text),
  // Installation is a different cost; the setup fee is the registration / office fee.
  initial: (text: string) => (/(?:初回|登録|事務)[^。、]{0,8}手数料|初期費用/.test(text)) && !/設置/.test(text),
  cancellation: (text: string) => /解約|解除|違約/.test(text),
} as const;
type FeeKey = keyof typeof FEE_LABELS;

function feeKeysOf(text: string): FeeKey[] {
  const t = norm(text);
  return (Object.keys(FEE_LABELS) as FeeKey[]).filter((key) => FEE_LABELS[key](t));
}

/** The tiers a field is read from: facts that name the service first, then the service's other page facts. */
function tiersOf(draft: PlanDraft, facts: readonly Fact[], pageSourceIds: ReadonlySet<string>): Tier[] {
  const named = facts.filter((fact) => draft.evidenceTerms.some((term) => term.length > 0 && fact.text.includes(term)));
  const namedIds = new Set(named.map((fact) => fact.id));
  const page = facts.filter((fact) => !namedIds.has(fact.id) && fact.sourceIds.some((id) => pageSourceIds.has(id)));
  return [named, page];
}

type Read<T> = { kind: "value"; value: T } | { kind: "none" } | { kind: "conflict"; detail: string };

function distinctOf<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** One figure for a fee fact: the amount it states, 0 when it says it is free, otherwise it is ambiguous. */
function figureOf(text: string): number | "ambiguous" | "silent" {
  const amounts = yenAmounts(text);
  const free = FREE.test(norm(text));
  if (amounts.length === 1 && amounts[0] === 0) return 0;
  if (amounts.length === 1 && !free) return amounts[0]!;
  if (amounts.length === 0 && free) return 0;
  if (amounts.length === 0) return "silent";
  return "ambiguous";
}

function readFee(key: FeeKey, tiers: readonly Tier[]): Read<{ amount: number; facts: Fact[] }> {
  for (const tier of tiers) {
    const facts = tier.filter((fact) => {
      const keys = feeKeysOf(fact.text);
      return keys.length === 1 && keys[0] === key;
    });
    const figures = facts.map((fact) => ({ fact, figure: figureOf(fact.text) })).filter((entry) => entry.figure !== "silent");
    if (figures.length === 0) continue;
    if (figures.some((entry) => entry.figure === "ambiguous")) {
      return { kind: "conflict", detail: "図が一つに決まらない記載があります（地域別の例外など）" };
    }
    const amounts = distinctOf(figures.map((entry) => entry.figure as number));
    if (amounts.length > 1) return { kind: "conflict", detail: `${amounts.map((a) => `${a}円`).join("・")}の記載があります` };
    return { kind: "value", value: { amount: amounts[0]!, facts: figures.map((entry) => entry.fact) } };
  }
  return { kind: "none" };
}

interface WaterCandidate {
  monthlyJpy: number;
  derived?: { amountJpy: number; times: number };
}

const sameLiters = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/** The monthly charge a fact states for `monthlyLiters`: a set price (12.5L×2本) or a bottle price scaled up. */
function waterCandidate(text: string, monthlyLiters: number): WaterCandidate | undefined {
  const t = norm(text);
  if (feeKeysOf(t).length > 0) return undefined;
  const amounts = yenAmounts(t);
  if (amounts.length !== 1) return undefined;
  const amount = amounts[0]!;
  const set = t.match(/(\d+(?:\.\d+)?)\s*L\s*[×x*]\s*(\d+)\s*本/i);
  if (set) {
    return sameLiters(Number(set[1]) * Number(set[2]), monthlyLiters) ? { monthlyJpy: amount } : undefined;
  }
  const bottle = t.match(/(\d+(?:\.\d+)?)\s*L/i);
  if (bottle && /1\s*本|1\s*パック|1\s*ボトル|あたり|単価/.test(t)) {
    const times = monthlyLiters / Number(bottle[1]);
    if (Number.isInteger(times) && times >= 1) {
      return { monthlyJpy: amount * times, derived: { amountJpy: amount, times } };
    }
  }
  return undefined;
}

function readWater(tiers: readonly Tier[], monthlyLiters: number): Read<WaterCandidate> {
  for (const tier of tiers) {
    const candidates = tier.flatMap((fact) => {
      const candidate = waterCandidate(fact.text, monthlyLiters);
      return candidate ? [candidate] : [];
    });
    if (candidates.length === 0) continue;
    const monthly = distinctOf(candidates.map((c) => c.monthlyJpy));
    if (monthly.length > 1) return { kind: "conflict", detail: `月${monthlyLiters}Lの金額が複数あります（${monthly.map((m) => `${m}円`).join("・")}）` };
    return { kind: "value", value: candidates[0]! };
  }
  return { kind: "none" };
}

function readTermMonths(tiers: readonly Tier[]): Read<number> {
  for (const tier of tiers) {
    const months = tier.flatMap((fact) => {
      const t = norm(fact.text);
      if (feeKeysOf(t).length > 0 || !/最低利用期間|最低契約期間|契約期間/.test(t)) return [];
      const match = t.match(/(\d+)\s*(年|ヶ月|か月|カ月)/);
      return match ? [Number(match[1]) * (match[2] === "年" ? 12 : 1)] : [];
    });
    if (months.length === 0) continue;
    const distinct = distinctOf(months);
    if (distinct.length > 1) return { kind: "conflict", detail: `${distinct.map((m) => `${m}ヶ月`).join("・")}の記載があります` };
    return { kind: "value", value: distinct[0]! };
  }
  return { kind: "none" };
}

const FIELD_NAME: Record<FeeKey | "water" | "term", string> = {
  shipping: "送料",
  electricity: "電気代",
  initial: "初回費用",
  cancellation: "解約金",
  water: "水代",
  term: "最低利用期間",
};

type DraftEntry = { ok: true; entry: CalculatorEntry } | { ok: false; issues: string[] };

/**
 * Builds the water calculator entry. Required: the monthly charge for the stated
 * volume, shipping, electricity and the initial fee (an unknown one makes the
 * total UNKNOWN, which QA refuses). Optional: the cancellation fee (UNKNOWN is
 * shown to readers) and the minimum term (left out when no fact states it).
 */
export function draftWaterEntry(draft: PlanDraft, facts: readonly Fact[], pageSourceIds: ReadonlySet<string>): DraftEntry {
  const tiers = tiersOf(draft, facts, pageSourceIds);
  const issues: string[] = [];
  const missing = (name: string): void => void issues.push(`${name}: 公式Factに金額が見つかりません`);
  const conflicting = (name: string, detail: string): void => void issues.push(`${name}: 金額が一意に決まりません（${detail}）`);

  const water = readWater(tiers, draft.monthlyLiters);
  if (water.kind === "none") issues.push(`${FIELD_NAME.water}: 月${draft.monthlyLiters}Lあたりの金額を示す公式Factが見つかりません`);
  if (water.kind === "conflict") issues.push(`${FIELD_NAME.water}: ${water.detail}`);

  const fees = Object.fromEntries(
    (["shipping", "electricity", "initial", "cancellation"] as const).map((key) => [key, readFee(key, tiers)]),
  ) as Record<FeeKey, Read<{ amount: number; facts: Fact[] }>>;
  for (const key of ["shipping", "electricity", "initial"] as const) {
    const read = fees[key];
    if (read.kind === "none") missing(FIELD_NAME[key]);
    if (read.kind === "conflict") conflicting(FIELD_NAME[key], read.detail);
  }
  if (fees.cancellation.kind === "conflict") conflicting(FIELD_NAME.cancellation, fees.cancellation.detail);

  const term = readTermMonths(tiers);
  if (term.kind === "conflict") conflicting(FIELD_NAME.term, term.detail);

  if (issues.length > 0 || water.kind !== "value" || fees.shipping.kind !== "value" || fees.electricity.kind !== "value" || fees.initial.kind !== "value") {
    return { ok: false, issues };
  }

  const electricityFacts = fees.electricity.value.facts;
  const bases = distinctOf(electricityFacts.flatMap((fact) => [...norm(fact.text).matchAll(LITERS)].map((m) => Number(m[1]))));
  const input: Record<string, unknown> = {
    offerId: draft.offerId,
    title: draft.title,
    waterChargeJpy: water.value.monthlyJpy,
    shippingFeeJpy: fees.shipping.value.amount,
    electricityFeeJpy: fees.electricity.value.amount,
    months: draft.months,
    initialFeeJpy: fees.initial.value.amount,
    cancellationFeeJpy: fees.cancellation.kind === "value" ? fees.cancellation.value.amount : "UNKNOWN",
    monthlyLiters: draft.monthlyLiters,
    ...(term.kind === "value" ? { minimumTermMonths: term.value } : {}),
    ...(electricityFacts.some((fact) => ESTIMATE.test(norm(fact.text))) ? { electricityIsEstimate: true } : {}),
    ...(bases.length === 1 ? { electricityBasisLiters: bases[0] } : {}),
  };
  return {
    ok: true,
    entry: {
      calculator: "water",
      input,
      factEvidenceTerms: draft.evidenceTerms,
      ...(water.value.derived ? { derivedAmounts: { waterChargeJpy: [water.value.derived] } } : {}),
    },
  };
}

/**
 * A plan with a `draft` and no calculators gets its calculator entry from the
 * facts; any other plan is returned as it is. `facts` are the usable (fresh)
 * facts of this cycle; the plan's own pages are found through `sources`.
 */
export function completeDraftedPlan(plan: ArticlePlan, facts: readonly Fact[], sources: readonly SourceRecord[]): DraftResult {
  if (!plan.draft || plan.calculators.length > 0) return { ok: true, plan };
  const drafted = draftWaterEntry(plan.draft, facts, sourceIdsOfPages(plan.sourceUrls, sources));
  return drafted.ok ? { ok: true, plan: { ...plan, calculators: [drafted.entry] } } : drafted;
}
