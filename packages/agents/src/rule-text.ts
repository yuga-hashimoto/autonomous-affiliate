/**
 * Rules about what a page of rules (an advertiser's terms, a program's conditions) forbids. Code over
 * text that was read; the text is untrusted data and an unclear page is a "no" for the caller.
 */

const SENTENCE_END = /[。\n]/;
const PROHIBITION = /(禁止|禁じ|不可|NG|ＮＧ|ご遠慮|お断り|できません|認めて(い)?ません|不許可|不承認|してはなりません|してはいけません)/;
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
  /スクレイピング|クローリング|クローラ|ロボット|ボット|自動(的)?(に)?(収集|取得|アクセス|ダウンロード)|プログラム(を|等|などを)?(用い|使用)|機械的|データマイニング/;

/** Why a page of rules leaves no room for an article that compares prices (empty when it does). */
export function restrictionReasons(text: string): string[] {
  const reasons = new Set<string>();
  if (OVER.test(text)) reasons.add("program_over");
  for (const sentence of text.split(SENTENCE_END)) {
    if (!PROHIBITION.test(sentence) || SEARCH_AD_RULE.test(sentence)) continue;
    for (const [topic, pattern] of RESTRICTED_TOPICS) if (pattern.test(sentence)) reasons.add(`restricted_${topic}`);
  }
  return [...reasons];
}

/** Whether a site's terms forbid collecting its pages by program. */
export function automationBan(text: string): boolean {
  return text.split(SENTENCE_END).some((sentence) => PROHIBITION.test(sentence) && AUTOMATION.test(sentence));
}

/** What a page of rules is about, as counts and topic names (never the text): to see whether the rules above can find anything. */
export function ruleSignals(text: string): { prohibitions: number; topics: string[] } {
  return {
    prohibitions: text.split(SENTENCE_END).filter((sentence) => PROHIBITION.test(sentence)).length,
    topics: RESTRICTED_TOPICS.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic),
  };
}
