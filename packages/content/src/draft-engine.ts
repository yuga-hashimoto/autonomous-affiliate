import type { AffiliateOffer } from "@aff/domain";
import { AD_DISCLOSURE, findProhibitedPhrases, DraftRejectedError } from "./draft-types.js";
import type { Draft, DraftInput } from "./draft-types.js";

function yen(amount: number | "UNKNOWN"): string {
  return amount === "UNKNOWN" ? "UNKNOWN" : `${amount.toLocaleString("ja-JP")}円`;
}

/**
 * A fenced `chart` block the site turns into a figure (apps/site/plugins/charts.mjs).
 * The data comes straight from the calculators, so the figure can only show what
 * the text already says. Backticks are escaped so no text can close the fence.
 */
function chartBlock(spec: Record<string, unknown>): string[] {
  return ["```chart", JSON.stringify(spec).replace(/`/g, "\\u0060"), "```", ""];
}

/** "水代（24ヶ月 × 月4,190円）" → label "水代", detail "24ヶ月 × 月4,190円". */
function breakdownRow(row: { label: string; amountJpy: number | "UNKNOWN" }): Record<string, unknown> {
  const match = /^(.+?)（(.+)）$/.exec(row.label);
  return { label: match?.[1] ?? row.label, ...(match?.[2] ? { detail: match[2] } : {}), value: row.amountJpy };
}

function keyFigures(calc: DraftInput["calculations"][number]): Record<string, unknown> {
  return {
    type: "key-figures",
    items: [
      { label: `${calc.comparisonMonths}ヶ月の総額`, value: yen(calc.totalJpy) },
      { label: "月平均", value: yen(calc.monthlyAverageJpy) },
      ...(calc.minimumTermMonths !== undefined ? [{ label: "最低利用期間", value: `${calc.minimumTermMonths}ヶ月` }] : []),
    ],
  };
}

/**
 * B009: deterministic draft builder. Every claim carries explicit fact/source
 * references, prices always show formula + assumptions, and CTAs render only
 * for approved, active offers with site permission. Hands-on claims throw.
 */
export function buildDraft(input: DraftInput): Draft {
  const now = input.now ?? new Date();
  const locale = input.locale ?? "ja-JP";
  const claims: Draft["claims"] = [];
  const body: string[] = [];

  body.push(AD_DISCLOSURE);
  body.push("");
  body.push(`# ${input.title}`);
  body.push("");
  body.push(`この記事は**${input.audience}**を対象に、公式一次情報のみに基づいて比較・試算します。`);
  body.push(input.purpose);
  body.push("");
  body.push(`最終確認日: ${now.toISOString().slice(0, 10)}。金額は公式ページの確認時点のものです。`);
  body.push("");

  // --- Comparison table (uniform unit) ---
  body.push("## 総額比較（同一条件・同一通貨）");
  body.push("");
  const [firstCalc] = input.calculations;
  if (input.calculations.length === 1 && firstCalc) {
    body.push(...chartBlock(keyFigures(firstCalc)));
  } else if (firstCalc) {
    body.push(
      ...chartBlock({
        type: "bars",
        title: `${firstCalc.comparisonMonths}ヶ月の総額`,
        rows: input.calculations.map((calc) => ({ label: calc.title, value: calc.totalJpy })),
      }),
    );
  }
  body.push("| プラン | 総額 | 月平均 | 不明点 |");
  body.push("| --- | --- | --- | --- |");
  for (const calc of input.calculations) {
    const unknownLabels = [
      ...calc.unknowns,
      ...(calc.conditions ?? []).filter((condition) => !condition.known).map((condition) => condition.label),
    ];
    body.push(
      `| ${calc.title} | ${yen(calc.totalJpy)} | ${yen(calc.monthlyAverageJpy)} | ${unknownLabels.length > 0 ? unknownLabels.join(", ") : "なし"} |`,
    );
  }
  body.push("");
  body.push("> 試算式と前提は次のセクションに示します。UNKNOWNの項目を0円とは扱いません。");
  body.push("");
  for (const calc of input.calculations) {
    for (const warning of calc.warnings ?? []) {
      body.push(`> 注意（${calc.title}）: ${warning}`);
      body.push("");
    }
  }

  // --- Per-offer calculation with formula + assumptions ---
  body.push("## 試算の内訳（公式料金に基づく計算）");
  body.push("");
  for (const calc of input.calculations) {
    body.push(`### ${calc.title}`);
    body.push("");
    body.push(
      ...chartBlock({
        type: "bars",
        title: `${calc.comparisonMonths}ヶ月の費用の内訳`,
        rows: calc.breakdown.map(breakdownRow),
      }),
    );
    body.push(`- 計算式: \`${calc.formula}\``);
    body.push(`- 式バージョン: ${calc.formulaVersion}`);
    for (const assumption of calc.assumptions) {
      body.push(`- 前提: ${assumption}`);
    }
    for (const row of calc.breakdown) {
      body.push(`- ${row.label}: ${yen(row.amountJpy)}`);
    }
    body.push("");
    const explicitFactIds = input.factIdsByOfferId?.[calc.offerId];
    const priceFacts = explicitFactIds
      ? input.facts.filter((f) => explicitFactIds.includes(f.id))
      : input.facts.filter((f) => f.claimType === "price" && f.text.includes(calc.title));
    claims.push({
      claimId: `claim_${calc.offerId}_total`,
      text: `${calc.title}の総額は${yen(calc.totalJpy)}（${calc.formulaVersion}）`,
      factIds: priceFacts.map((f) => f.id),
      sourceIds:
        priceFacts.flatMap((f) => f.sourceIds).length > 0
          ? priceFacts.flatMap((f) => f.sourceIds)
          : input.sources.map((s) => s.id),
      claimType: "price",
    });
  }

  // --- Conditions kept out of the total (cancellation fee, minimum term) ---
  const withConditions = input.calculations.filter((calc) => (calc.conditions ?? []).length > 0);
  if (withConditions.length > 0) {
    body.push("## 契約条件（総額に含めない項目）");
    body.push("");
    body.push("解約時の費用など、総額には入れていない条件です。UNKNOWNは公式ページで確認できていない項目で、0円や「なし」とは扱いません。");
    body.push("");
    for (const calc of withConditions) {
      body.push(`### ${calc.title}`);
      body.push("");
      if (calc.minimumTermMonths !== undefined) {
        body.push(
          ...chartBlock({
            type: "term-timeline",
            title: "比較期間と最低利用期間",
            comparisonMonths: calc.comparisonMonths,
            minimumTermMonths: calc.minimumTermMonths,
          }),
        );
      }
      for (const condition of calc.conditions ?? []) {
        body.push(`- ${condition.label}: ${condition.value}`);
      }
      body.push("");
    }
  }

  // --- Decision matrix ---
  if (input.matrix) {
    body.push("## 条件別の比較表");
    body.push("");
    body.push(`| プラン | ${input.matrix.criteria.map((c) => c.label).join(" | ")} |`);
    body.push(`| --- | ${input.matrix.criteria.map(() => "---").join(" | ")} |`);
    for (const offer of input.offers) {
      const values = input.matrix.criteria.map((c) => {
        const cell = input.matrix!.cells.find((cell) => cell.offerId === offer.id && cell.criterionId === c.id);
        const v = cell?.value ?? "UNKNOWN";
        return typeof v === "number" ? v.toLocaleString("ja-JP") : String(v);
      });
      body.push(`| ${offer.title} | ${values.join(" | ")} |`);
    }
    body.push("");
  }

  // --- CTA: approved offers only ---
  const approved = input.ctaOffers.filter(
    (o) => o.active && o.status === "APPROVED" && o.channelPermissions.includes("site"),
  );
  body.push("## 申し込みを検討する場合");
  body.push("");
  if (approved.length === 0) {
    body.push(
      "現在、掲載可能な紹介プログラムがありません。公式サイトで最新の条件をご確認ください（この記事は収益リンクを持たずに公開されます）。",
    );
  } else {
    for (const offer of approved) {
      body.push(offerCta(offer));
    }
  }
  body.push("");

  // --- Fairness: limitations ---
  body.push("## この比較の限界");
  body.push("");
  body.push("- 料金は公式情報の確認日時点のもので、変更されることがあります。");
  body.push("- 実機での利用検証は行っていません。記載は公式情報に基づく説明と試算です。");
  body.push("- UNKNOWNの項目は確認できていない情報であり、断定しません。");
  body.push("");

  // --- Sources ---
  body.push("## 出典");
  body.push("");
  for (const source of input.sources) {
    body.push(`- [公式](${source.canonicalUrl}) — 確認日時: ${source.fetchedAt}（sha256: ${source.hash.slice(0, 12)}…）`);
  }
  body.push("");

  const bodyMarkdown = body.join("\n");
  const violations = findProhibitedPhrases(bodyMarkdown);
  if (violations.length > 0) {
    throw new DraftRejectedError(violations);
  }

  return {
    slug: input.slug,
    locale,
    title: input.title,
    bodyMarkdown,
    claims,
    sourceIds: input.sources.map((s) => s.id),
    offerIds: approved.map((o) => o.id),
    disclosure: AD_DISCLOSURE,
    metadata: {
      formulaVersion: input.calculations[0]?.formulaVersion ?? "none",
      audience: input.audience,
      generatedAt: now.toISOString(),
      assumptions: input.calculations.flatMap((c) => c.assumptions),
      comparisonMonths: input.calculations[0]?.comparisonMonths ?? null,
    },
  };
}

function offerCta(offer: AffiliateOffer): string {
  // The tracking URL stays in secret storage: drafts reference the internal
  // /go/{offerId} path, which the site resolves at request time and 404s for
  // anything not registered as APPROVED (docs/05).
  return `- [${offer.title}の公式サイトを確認する](/go/${offer.id})（PR / rel=sponsored）`;
}
