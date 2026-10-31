/**
 * Rules about what a page of rules (an advertiser's terms, a program's conditions) forbids. Code over
 * text that was read; the text is untrusted data and an unclear page is a "no" for the caller.
 */

const SENTENCE_END = /。/;
const PROHIBITION =
  /(禁止|禁じ|不可|NG|ＮＧ|ご遠慮|お断り|できません|できかねます|認めて(い)?ません|認められません|認めません|許可しません|不許可|不承認|してはなりません|してはいけません|しないでください|ないでください|お控え|控えて)/;
/** What a comparison article does; a rule against any of it makes the program unusable for one. */
const RESTRICTED_TOPICS: readonly (readonly [string, RegExp])[] = [
  ["comparison", /比較/],
  ["ranking", /ランキング|最安/],
  ["price", /価格|料金|金額|費用/],
];
/** A rule about buying search ads is not a rule about the page. */
const SEARCH_AD_RULE = /リスティング|PPC|検索連動|入札|出稿|キーワード/;
const OVER = /プログラム終了|掲載終了|提携終了|募集終了|停止中/;
const AUTOMATION =
  /スクレイピング|スクレイプ|クローリング|クローラ|クロール|スパイダー|ロボット|ボット|bot\b|自動(的)?(に|で)?(収集|取得|アクセス|ダウンロード|複製)|プログラム(を|等|などを)?(用い|使用|利用)|ツール(を|等|などを)?(用い|使用|利用)|機械的|データマイニング/i;

/** A list item is a short line without a full stop; a prohibition heading owns the items under it. */
const LIST_ITEM_MAX = 60;
const LIST_MAX_ITEMS = 12;

/**
 * The units a rule can be stated in: each sentence, and for a line that states a prohibition the
 * short lines under it (an item list: "the following are forbidden:" then one item per line), so a
 * rule written as a list is read together with its heading.
 */
function units(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trim());
  const found: string[] = [];
  lines.forEach((line, index) => {
    for (const sentence of line.split(SENTENCE_END)) if (sentence) found.push(sentence);
    if (!PROHIBITION.test(line)) return;
    const items: string[] = [];
    for (let next = index + 1; next < lines.length && items.length < LIST_MAX_ITEMS; next += 1) {
      const item = lines[next] ?? "";
      if (!item || item.length > LIST_ITEM_MAX || item.includes("。")) break;
      items.push(item);
    }
    if (items.length > 0) found.push([line, ...items].join("、"));
  });
  return found;
}

/** The clauses of a unit that are not about buying search ads (a rule about those is not about the page). */
function pageClauses(unit: string): string {
  return unit
    .split("、")
    .filter((clause) => !SEARCH_AD_RULE.test(clause))
    .join("、");
}

/** Why a page of rules leaves no room for an article that compares prices (empty when it does). */
export function restrictionReasons(text: string): string[] {
  const reasons = new Set<string>();
  if (OVER.test(text)) reasons.add("program_over");
  for (const unit of units(text)) {
    const clauses = pageClauses(unit);
    if (!PROHIBITION.test(clauses)) continue;
    for (const [topic, pattern] of RESTRICTED_TOPICS) if (pattern.test(clauses)) reasons.add(`restricted_${topic}`);
  }
  return [...reasons];
}

/** Whether a site's terms forbid collecting its pages by program. */
export function automationBan(text: string): boolean {
  return units(text).some((unit) => PROHIBITION.test(unit) && AUTOMATION.test(unit));
}

/** What a page of rules is about, as counts and topic names (never the text): to see whether the rules above can find anything. */
export function ruleSignals(text: string): { prohibitions: number; topics: string[] } {
  return {
    prohibitions: text.split(SENTENCE_END).filter((sentence) => PROHIBITION.test(sentence)).length,
    topics: RESTRICTED_TOPICS.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic),
  };
}
