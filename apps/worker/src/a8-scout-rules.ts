import { classifyProgramStatus, programIdOf, verticalOf, type RawProgramRow } from "./a8-programs.js";
import { rowMatchesKeyword } from "./a8-sync.js";
import { isNotPartneredDetail } from "./a8-apply.js";
import { pickDetailPath } from "./a8-inspect.js";

/**
 * The rules for picking a new advertiser out of what the A8 console shows (docs/21). Everything
 * here is code over text that was read: the page's words are untrusted data and decide nothing
 * but through these rules, and an answer that is not clear is a "no".
 */

/** What to search for in the console, by vertical. Only a vertical the content path can write about is listed (docs/18). */
export const SCOUT_SEARCHES: Readonly<Record<string, readonly string[]>> = {
  water_delivery: ["ウォーターサーバー", "宅配水"],
};

/** The keyword that finds a program on the console is the advertiser's name, so it has to fit the brand schema. */
const NAME_MAX = 40;
const NAME_MIN = 2;

export interface ScoutCandidate {
  programId: string;
  /** The advertiser's name as the card shows it. */
  name: string;
  /** The account has joined already (the card opens the partnered page). */
  joined: boolean;
  /** The detail page to read. */
  detailPath: string;
}

/** A card is of the vertical when its name says so, or when the card shows the word the search was for. */
function inVertical(row: RawProgramRow, name: string, verticalId: string): boolean {
  return verticalOf(name) === verticalId || (SCOUT_SEARCHES[verticalId] ?? []).some((word) => row.text.includes(word));
}

/** Programs of the vertical that no configured brand covers, each once. */
export function candidatesFromRows(
  rows: readonly RawProgramRow[],
  verticalId: string,
  configuredKeywords: readonly string[],
): ScoutCandidate[] {
  const seen = new Set<string>();
  const found: ScoutCandidate[] = [];
  for (const row of rows) {
    const name = row.name?.trim() ?? "";
    if (name.length < NAME_MIN || name.length > NAME_MAX) continue;
    if (seen.has(row.programId) || !inVertical(row, name, verticalId)) continue;
    if (configuredKeywords.some((keyword) => rowMatchesKeyword(row, keyword))) continue;
    const status = classifyProgramStatus(row.text, row.hrefs);
    if (status === "ended" || status === "rejected") continue;
    const detailPath = pickDetailPath(row);
    if (!detailPath || programIdOf(detailPath) !== row.programId) continue;
    seen.add(row.programId);
    found.push({ programId: row.programId, name, joined: !isNotPartneredDetail(detailPath), detailPath });
  }
  return found;
}

// ---- the program's own rules ----

const SENTENCE_END = /[。\n]/;
const PROHIBITION = /(禁止|不可|NG|ＮＧ|ご遠慮|お断り|できません|認めて(い)?ません|不許可|不承認)/;
/** What a comparison article does; a rule against any of it makes the program unusable for one. */
const RESTRICTED_TOPICS: readonly (readonly [string, RegExp])[] = [
  ["comparison", /比較/],
  ["ranking", /ランキング|最安/],
  ["price", /価格|料金|金額|費用/],
];
/** A rule about buying search ads is not a rule about the page. */
const SEARCH_AD_RULE = /リスティング|PPC|検索連動|入札|出稿|キーワード/;
const OVER = /プログラム終了|掲載終了|提携終了|募集終了|停止中/;

export interface ProgramGate {
  ok: boolean;
  reasons: string[];
}

/** Whether the program's rules, as the console shows them, leave room for an article that compares prices. */
export function programGate(detailText: string): ProgramGate {
  const reasons = new Set<string>();
  if (OVER.test(detailText)) reasons.add("program_over");
  for (const sentence of detailText.split(SENTENCE_END)) {
    if (!PROHIBITION.test(sentence) || SEARCH_AD_RULE.test(sentence)) continue;
    for (const [topic, pattern] of RESTRICTED_TOPICS) if (pattern.test(sentence)) reasons.add(`restricted_${topic}`);
  }
  return { ok: reasons.size === 0, reasons: [...reasons] };
}

// ---- the advertiser's site ----

const TWO_PART_SUFFIXES = new Set(["co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ed.jp", "gr.jp", "ad.jp", "lg.jp", "com.au", "co.uk"]);
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The site's own name: the host without `www.` and subdomains. Nothing for an IP address or a single-label name. */
export function registrableHost(host: string): string | undefined {
  const labels = host.trim().toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return undefined;
  if (labels.every((label) => /^\d+$/.test(label))) return undefined;
  const lastTwo = labels.slice(-2).join(".");
  const take = TWO_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

const SLUG_MAX = 32;

/** A short ascii slug from the site's name (`cosmo-water.com` -> `cosmo-water`). */
export function slugForHost(registrable: string): string | undefined {
  const labels = registrable.split(".");
  const take = TWO_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  const name = labels.slice(0, labels.length - take).at(-1);
  if (!name || name.startsWith("xn--") || name.length > SLUG_MAX) return undefined;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : undefined;
}

/** Addresses on a page that are not the advertiser's: the ASP itself and the usual social and media sites. */
const NOT_THE_ADVERTISER = [
  "a8.net",
  "a8.jp",
  "google.com",
  "google.co.jp",
  "youtube.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "line.me",
  "apple.com",
  "w3.org",
  "fancs.com",
];
const SITE_LINK_WORDING = /公式|サイト|ホームページ|HP|URL|広告主/i;
const ADDRESS_IN_TEXT = /https?:\/\/([A-Za-z0-9.-]+)/g;

export interface SiteHost {
  host?: string;
  via: "labeled_link" | "only_outside_link" | "address_in_text" | "ambiguous" | "none";
}

function outsideHost(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const registrable = registrableHost(url.hostname);
  if (!registrable) return undefined;
  return NOT_THE_ADVERTISER.some((blocked) => registrable === blocked) ? undefined : registrable;
}

const only = (hosts: Set<string>): { host: string } | "ambiguous" | undefined => {
  if (hosts.size === 1) return { host: [...hosts][0]! };
  return hosts.size > 1 ? "ambiguous" : undefined;
};

/**
 * The advertiser's own site from a program's detail page: a link that says it is the site, then the
 * only link that leaves the console, then an address written in the text. Two different sites at the
 * same step are no answer.
 */
export function siteHostFromDetail(page: { links: readonly { href: string; text: string }[]; text: string }): SiteHost {
  const outside = page.links.flatMap((link) => {
    const host = outsideHost(link.href);
    return host ? [{ host, text: link.text }] : [];
  });
  const steps: readonly [SiteHost["via"], Set<string>][] = [
    ["labeled_link", new Set(outside.filter((link) => SITE_LINK_WORDING.test(link.text)).map((link) => link.host))],
    ["only_outside_link", new Set(outside.map((link) => link.host))],
    [
      "address_in_text",
      new Set(
        [...page.text.matchAll(ADDRESS_IN_TEXT)].flatMap((match) => {
          const host = outsideHost(`https://${match[1] ?? ""}`);
          return host ? [host] : [];
        }),
      ),
    ],
  ];
  for (const [via, hosts] of steps) {
    const answer = only(hosts);
    if (answer === "ambiguous") return { via: "ambiguous" };
    if (answer) return { host: answer.host, via };
  }
  return { via: "none" };
}
