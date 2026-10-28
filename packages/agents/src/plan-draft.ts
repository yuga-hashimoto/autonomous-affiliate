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
export type DraftResult = { ok: true; plan: ArticlePlan; facts?: Fact[] } | { ok: false; issues: string[] };

type Tier = readonly Fact[];

const norm = (text: string): string => text.normalize("NFKC");

const NUMBER = "(\\d{1,3}(?:,\\d{3})+|\\d+)";
const toNumber = (text: string): number => Number(text.replace(/,/g, ""));

/**
 * The yen amounts a fact states. Pages often give a tax-excluded and a tax-included
 * price side by side ("3,880円/月（税込4,190円）"); when exactly one amount is marked
 * 税込 that is the figure, as the comparison is on tax-included prices.
 */
function yenAmounts(text: string): number[] {
  const t = norm(text);
  const all = [...t.matchAll(new RegExp(`${NUMBER}\\s*円`, "g"))].map((match) => toNumber(match[1]!));
  const included = [
    ...t.matchAll(new RegExp(`税込\\s*[:：]?\\s*${NUMBER}\\s*円`, "g")),
    ...t.matchAll(new RegExp(`${NUMBER}\\s*円\\s*[（(]\\s*税込\\s*[）)]`, "g")),
  ].map((match) => toNumber(match[1]!));
  const distinctIncluded = [...new Set(included)];
  return distinctIncluded.length === 1 ? distinctIncluded : all;
}

const FREE = /無料|ゼロ円/;
const ESTIMATE = /目安|約|概算|想定/;
/** Monthly use an electricity figure is based on: "36L/月" or "月36L". */
function usageLiters(text: string): number[] {
  const t = norm(text);
  return [
    ...[...t.matchAll(/(\d+(?:\.\d+)?)\s*L\s*\/\s*月/gi)].map((m) => Number(m[1])),
    ...[...t.matchAll(/月\s*(\d+(?:\.\d+)?)\s*L/gi)].map((m) => Number(m[1])),
  ];
}

/**
 * Where a fee is named. A passage may carry several fees and a plan's price next to them,
 * so a fee's figure is read only from the words right after its own name (`clausesOf`).
 */
const FEE_PATTERNS = {
  // A regional surcharge ("追加送料") is an addition to the shipping fee, not the fee.
  shipping: { label: /(?<!追加)(?:送料|配送料|配達料)/g },
  electricity: { label: /電気代|電気料金/g },
  // The setup fee is named by its prefix: pause, delivery and payment fees also say 事務手数料.
  // Installation is a different cost.
  initial: { label: /(?:初回|登録|初期|契約)[^。、:：]{0,8}(?:手数料|費用)/g, skip: /設置/ },
  // The contract termination fee, not any sentence that says 解約 (a pause ends in 強制解約).
  cancellation: { label: /契約解除料|解約金|解約料|違約金|解除料/g },
} as const satisfies Record<string, { label: RegExp; skip?: RegExp }>;
type FeeKey = keyof typeof FEE_PATTERNS;
const FEE_KEYS = Object.keys(FEE_PATTERNS) as FeeKey[];

function labelHits(text: string, key: FeeKey): RegExpExecArray[] {
  const { label } = FEE_PATTERNS[key];
  const skip = "skip" in FEE_PATTERNS[key] ? (FEE_PATTERNS[key] as { skip: RegExp }).skip : undefined;
  return [...text.matchAll(new RegExp(label.source, "g"))].filter((hit) => !skip || !skip.test(hit[0]));
}

function feeKeysOf(text: string): FeeKey[] {
  const t = norm(text);
  return FEE_KEYS.filter((key) => labelHits(t, key).length > 0);
}

const MAX_CLAUSE_CHARS = 80;

/**
 * The words after each mention of the fee, up to the end of the sentence, a "※" note,
 * a surcharge, the next fee's name or 80 characters.
 */
function clausesOf(text: string, key: FeeKey): string[] {
  const t = norm(text);
  const starts = FEE_KEYS.flatMap((other) => labelHits(t, other).map((hit) => hit.index));
  return labelHits(t, key).map((hit) => {
    const from = hit.index;
    const after = from + hit[0].length;
    const stop = t.slice(after).search(/。|\s※|追加送料/);
    const ends = [t.length, from + MAX_CLAUSE_CHARS, ...starts.filter((start) => start > from), ...(stop >= 0 ? [after + stop] : [])];
    return t.slice(from, Math.min(...ends));
  });
}

/** An eco-mode figure in brackets is another way of using the product, not the figure. */
const withoutEcoMode = (text: string): string => text.replace(/[（(][^）)]*エコ[^）)]*[）)]/g, " ");

/** The tiers a field is read from: facts that name the service first, then the service's other page facts. */
function tiersOf(draft: PlanDraft, facts: readonly Fact[], pageSourceIds: ReadonlySet<string>): Tier[] {
  const named = facts.filter((fact) => draft.evidenceTerms.some((term) => term.length > 0 && fact.text.includes(term)));
  const namedIds = new Set(named.map((fact) => fact.id));
  const page = facts.filter((fact) => !namedIds.has(fact.id) && fact.sourceIds.some((id) => pageSourceIds.has(id)));
  return [named, page];
}

/** Facts that hold every fragment, when the brief names them; otherwise the usual tiers. */
function selected(terms: readonly string[] | undefined, facts: readonly Fact[], tiers: readonly Tier[]): Tier[] {
  if (!terms || terms.length === 0) return [...tiers];
  return [facts.filter((fact) => terms.every((term) => fact.text.includes(term)))];
}

type Read<T> = { kind: "value"; value: T } | { kind: "none" } | { kind: "conflict"; detail: string };

function distinctOf<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

const shorten = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

/** The facts a failure is about, shortened, so it can be understood from the run log alone. */
const examplesOf = (facts: readonly Fact[]): string => `候補: ${facts.slice(0, 3).map((fact) => `「${shorten(fact.text)}」`).join("")}`;

function nearMisses(tiers: readonly Tier[]): string {
  const withYen = tiers.flat().filter((fact) => yenAmounts(fact.text).length > 0);
  return withYen.length === 0 ? "該当するFactがありません" : examplesOf(withYen);
}

/** One figure for a fee fact: the amount it states, 0 when it says it is free, otherwise it is ambiguous. */
function figureOf(text: string): number | "ambiguous" | "silent" {
  const amounts = yenAmounts(text);
  const free = FREE.test(norm(text));
  if (amounts.length === 1 && amounts[0] === 0) return 0;
  if (amounts.length === 1 && !free) return amounts[0]!;
  if (amounts.length === 0 && free) return 0;
  if (amounts.length > 1 && !free) {
    // "通常使用時約669円、エコモード使用時約583円": the normal-use figure, when exactly one is marked so.
    const normal = [...norm(text).matchAll(new RegExp(`通常[^0-9円]{0,8}?${NUMBER}\\s*円`, "g"))].map((m) => toNumber(m[1]!));
    if (new Set(normal).size === 1) return normal[0]!;
  }
  if (amounts.length === 0) return "silent";
  return "ambiguous";
}

function readFee(key: FeeKey, tiers: readonly Tier[]): Read<{ amount: number; facts: Fact[]; clauses: string[] }> {
  for (const tier of tiers) {
    const figures = tier
      .flatMap((fact) => clausesOf(fact.text, key).map((clause) => ({ fact, clause, figure: figureOf(withoutEcoMode(clause)) })))
      .filter((entry) => entry.figure !== "silent");
    if (figures.length === 0) continue;
    const ambiguous = figures.filter((entry) => entry.figure === "ambiguous");
    if (ambiguous.length > 0) {
      return { kind: "conflict", detail: `図が一つに決まらない記載があります（地域別の例外・複数の金額など）。${examplesOf(ambiguous.map((entry) => entry.fact))}` };
    }
    const amounts = distinctOf(figures.map((entry) => entry.figure as number));
    if (amounts.length > 1) {
      return { kind: "conflict", detail: `${amounts.map((a) => `${a}円`).join("・")}の記載があります。${examplesOf(figures.map((entry) => entry.fact))}` };
    }
    return { kind: "value", value: { amount: amounts[0]!, facts: figures.map((entry) => entry.fact), clauses: figures.map((entry) => entry.clause) } };
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
      // A row that lists several plans ("3年 5年") does not say which belongs to this one.
      const terms = [...new Set([...t.matchAll(/(\d+)\s*(年|ヶ月|か月|カ月)/g)].map((m) => Number(m[1]) * (m[2] === "年" ? 12 : 1)))];
      return terms.length === 1 ? terms : [];
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

  const water = readWater(selected(draft.priceTerms, facts, tiers), draft.monthlyLiters);
  if (water.kind === "none") {
    issues.push(
      `${FIELD_NAME.water}: 月${draft.monthlyLiters}Lあたりの金額を示す公式Factが見つかりません（${nearMisses(selected(draft.priceTerms, facts, tiers))}）`,
    );
  }
  if (water.kind === "conflict") issues.push(`${FIELD_NAME.water}: ${water.detail}`);

  const fees = Object.fromEntries(
    (["shipping", "electricity", "initial", "cancellation"] as const).map((key) => [key, readFee(key, tiers)]),
  ) as Record<FeeKey, Read<{ amount: number; facts: Fact[]; clauses: string[] }>>;
  for (const key of ["shipping", "electricity", "initial"] as const) {
    const read = fees[key];
    if (read.kind === "none") missing(FIELD_NAME[key]);
    if (read.kind === "conflict") conflicting(FIELD_NAME[key], read.detail);
  }
  if (fees.cancellation.kind === "conflict") conflicting(FIELD_NAME.cancellation, fees.cancellation.detail);

  const term = readTermMonths(selected(draft.planTerms, facts, tiers));
  if (term.kind === "conflict") conflicting(FIELD_NAME.term, term.detail);

  if (issues.length > 0 || water.kind !== "value" || fees.shipping.kind !== "value" || fees.electricity.kind !== "value" || fees.initial.kind !== "value") {
    return { ok: false, issues };
  }

  const bases = distinctOf(
    tiers.flat().flatMap((fact) => (labelHits(norm(fact.text), "electricity").length > 0 || /kwh|電気|消費電力/i.test(norm(fact.text)) ? usageLiters(fact.text) : [])),
  );
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
    ...(fees.electricity.value.clauses.some((clause) => ESTIMATE.test(clause)) ? { electricityIsEstimate: true } : {}),
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
