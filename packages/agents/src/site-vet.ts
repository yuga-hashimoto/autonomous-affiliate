import type { Repository } from "@aff/db";
import type { PolicyConfig } from "@aff/domain";
import { FetchError, checkRobots, htmlToVisibleText, linksOfHtml, type Fetcher, type PageLink } from "@aff/integrations";
import { termsFingerprint } from "./a8-offers.js";
import { discoverPlans, type DiscoverySource, type PlanLister } from "./plan-discovery.js";
import { DRAFT_RULES_VERSION, type DraftResult } from "./plan-draft.js";
import type { ArticlePlan } from "./pipeline.js";
import { automationBan, restrictionReasons } from "./rule-text.js";
import { registrableHost } from "./site-host.js";

/**
 * Looks at an advertiser's own site before anything is built on it (docs/21): the site must be
 * readable and say who it is, its robots.txt and terms must not keep a program out, the rules it
 * has for partners must leave room for a price comparison, and one of its price pages must really
 * list servers. All of it is code over the pages that were read; the pages are untrusted, an unclear
 * answer is a "no", and no link to another site is ever followed.
 */

const TERMS_LINK = /利用規約|ご利用規約|利用条件|サイトポリシー|サイトのご利用|サイトご利用|ご利用にあたって|このサイトについて|サイトについて|ご利用上の注意|利用上の注意|免責事項|Terms/i;
/** "提携" alone is too loose (partner hospitals, partner shops): only wording that is about advertising partners. */
const PARTNER_LINK = /アフィリエイト|パートナー募集|パートナープログラム|広告掲載|提携者|アフィリエイター/;
const PRICE_LINK = /料金|価格|プラン|ラインナップ|商品|サーバー|機種|ご利用料金/;
const NOT_PRICE_LINK = /規約|プライバシー|個人情報|会社|採用|お問い合わせ|ログイン|アフィリエイト|パートナー|特定商取引|サイトマップ/;
const MAX_PRICE_PAGES = 3;
/** The pages a plan takes its amounts from: the one that lists the servers and the other pages of the site that show prices. */
const MAX_SOURCE_PAGES = 4;
const MAX_RULE_PAGES = 2;
const FETCH_TIMEOUT_MS = 15_000;

/** Reasons that say "not now" rather than "not this site": a caller may look again soon. */
export const TRANSIENT_REASONS: ReadonlySet<string> = new Set(["site_unreachable", "no_lister", "listing_failed", "page_unreadable", "vet_timeout"]);

/** `unreachable_<page>_<why>` is a note that comes with `site_unreachable` (which page, and what it answered): it is as transient as the reason it explains. */
export const isTransientReason = (reason: string): boolean => TRANSIENT_REASONS.has(reason) || reason.startsWith("unreachable_");

export interface VetCandidate {
  /** The advertiser's name as the console shows it. */
  name: string;
  /**
   * The text of the program's page in the console. Not shown or stored: it is only compared with the
   * names the site gives itself, when the console's name is not on the site (the console may name the
   * operating company, the site the service).
   */
  programText?: string | undefined;
  /** The site's own name (see `registrableHost`). */
  host: string;
  brandSlug: string;
}

export interface VetDeps {
  fetcher: Fetcher;
  repo: Repository;
  policy: PolicyConfig;
  clock: () => Date;
  /** Reads the price pages; without it a site cannot be checked. */
  lister?: PlanLister | undefined;
  /** Tries to draft a plan from the pages it rests on (docs/18); without it the site is registered without that trial. */
  draft?: ((plan: ArticlePlan, policy: PolicyConfig) => Promise<DraftResult>) | undefined;
}

export type VetResult =
  | {
      ok: true;
      /** The company as its own pages name it. */
      brandName: string;
      termsUrl: string;
      termsSha256: string;
      listUrls: string[];
      sourceUrls: string[];
      services: number;
    }
  | { ok: false; reasons: string[] };

interface Read {
  url: string;
  html: string;
  text: string;
}

/** `unavailable` says why in a word that carries no address: `http403`, `notHtml`, `offsite`, `timeout`, `network`, `toolarge`. */
type ReadOutcome = { read: Read } | { robots: true } | { unavailable: string };

/** The name without a trailing note in brackets: `ブランドA（ウォーターサーバー）` -> `ブランドA`. */
export function siteNameOf(name: string): string {
  return name.replace(/[（(【[][^）)】\]]*[）)】\]]/g, "").trim() || name.trim();
}

/** Words that say what the company sells, not who it is: a page that has only these is not the company's. */
const GENERIC_WORDS = ["ミネラルウォーター", "ウォーターサーバー", "宅配ウォーター", "ウォーター", "サーバー", "宅配水", "天然水", "公式", "サイト", "新規", "設置", "宅配", "水"];

/**
 * The form in which two spellings of a name are compared: letters of one width and case, katakana
 * as hiragana (a brand written in either is the same brand), and no spaces, dots or long-vowel marks.
 */
const comparable = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) - 0x60))
    .replace(/[\s\u30fc・･\-‐‑–—―_.]+/g, "");

/** The name without the words for what is sold, split where a name is put together: what is left is who the company is. */
function distinctiveParts(whole: string): string[] {
  return whole
    .normalize("NFKC")
    .split(/[\s・/|｜\-－―「」『』]+/)
    .map((part) => GENERIC_WORDS.reduce((rest, word) => rest.split(word).join(" "), part).split(/\s+/))
    .flat()
    .filter((part) => part.length >= 3);
}

/**
 * The form of the advertiser's name that the site's own words show: the name as the console gives it
 * (without notes), else its longest distinctive part (the console may add what the company sells).
 * Nothing when the site shows none of it, which is a "no": the link in the console may be the wrong site.
 */
export function nameOnSite(name: string, siteText: string): string | undefined {
  const text = comparable(siteText);
  const whole = siteNameOf(name);
  if (text.includes(comparable(whole))) return whole;
  return distinctiveParts(whole)
    .sort((a, b) => b.length - a.length)
    .find((part) => text.includes(comparable(part)));
}

const ATTRIBUTE_TEXT = /\b(?:content|alt|title)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/** A page is read this far for what it says about itself; the scans below are plain searches, so a hostile page costs time in proportion to its size. */
const MAX_IDENTITY_HTML = 1_500_000;
const MAX_IDENTITY_TAGS = 2_000;
const MAX_IDENTITY_CHARS = 40_000;

/** The `<name ...>` tags of a page, as written, found by searching forward so that a page full of unclosed tags costs one pass. */
function openTags(html: string, lower: string, name: string): string[] {
  const found: string[] = [];
  let from = 0;
  while (found.length < MAX_IDENTITY_TAGS) {
    const open = lower.indexOf(`<${name}`, from);
    if (open === -1) break;
    const end = lower.indexOf(">", open);
    if (end === -1) break;
    found.push(html.slice(open, end + 1));
    from = end + 1;
  }
  return found;
}

/** The text of the `<script type="application/ld+json">` blocks (structured data about the company). */
function structuredData(html: string, lower: string): string[] {
  const found: string[] = [];
  let from = 0;
  while (found.length < MAX_IDENTITY_TAGS) {
    const marker = lower.indexOf("application/ld+json", from);
    if (marker === -1) break;
    const start = lower.indexOf(">", marker);
    if (start === -1) break;
    const end = lower.indexOf("</script", start);
    if (end === -1) break;
    found.push(html.slice(start + 1, end));
    from = end;
  }
  return found;
}

/**
 * What the page says about itself apart from the text a visitor reads: the meta tags (site name,
 * description), the alternative text of images (a logo is often only an image) and the structured
 * data. The page's own words, read like its text; nothing here is followed or run.
 */
export function identityText(page: string): string {
  const html = page.slice(0, MAX_IDENTITY_HTML);
  const lower = html.toLowerCase();
  const parts: string[] = [];
  for (const tag of [...openTags(html, lower, "meta"), ...openTags(html, lower, "img")]) {
    for (const attribute of tag.matchAll(ATTRIBUTE_TEXT)) parts.push(attribute[1] ?? attribute[2] ?? "");
  }
  parts.push(...structuredData(html, lower));
  return parts.join("\n").slice(0, MAX_IDENTITY_CHARS);
}

/** The page's own title, as written. */
function titleOf(html: string): string {
  const lower = html.slice(0, MAX_IDENTITY_HTML).toLowerCase();
  const open = lower.indexOf("<title");
  const start = open === -1 ? -1 : lower.indexOf(">", open);
  const end = start === -1 ? -1 : lower.indexOf("</title", start);
  return end === -1 ? "" : html.slice(start + 1, end).trim();
}

/** Words a title or a heading uses to say what a page is or offers, not who the company is. */
const PAGE_WORDS = [
  "トップページ", "ホームページ", "公式サイト", "公式", "通販", "オンライン", "ショップ", "ストア", "料金", "価格", "比較", "口コミ", "評判",
  "おすすめ", "ランキング", "お申し込み", "お申込み", "キャンペーン", "無料", "特集", "最新", "情報", "サービス", "とは",
];
const TITLE_SPLIT = /\s*[|｜–—―]\s*|\s+-\s+|\s*[：:]\s*/;
const SELF_NAME_META = /^(?:og:site_name|application-name|apple-mobile-web-app-title)$/i;
const META_KEY = /\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const META_CONTENT = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const ORGANIZATION_TYPE = /^(?:Organization|Corporation|WebSite|LocalBusiness|Brand|Store|OnlineStore)$/;
const MAX_SELF_NAMES = 12;
const MAX_SELF_NAME_CHARS = 30;
const MAX_STRUCTURED_NODES = 400;

/** The `name` of the organizations that structured data (`ld+json`) describes; what is not JSON, or not about a company, gives nothing. */
function structuredNames(blocks: readonly string[]): string[] {
  const found: string[] = [];
  let budget = MAX_STRUCTURED_NODES;
  const visit = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > 5 || found.length >= MAX_SELF_NAMES) return;
    budget -= 1;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const types = [record["@type"]].flat().filter((type): type is string => typeof type === "string");
    if (types.some((type) => ORGANIZATION_TYPE.test(type))) {
      for (const key of ["name", "alternateName"]) {
        const value = record[key];
        if (typeof value === "string") found.push(value);
      }
    }
    for (const value of Object.values(record)) if (typeof value === "object") visit(value, depth + 1);
  };
  for (const block of blocks) {
    try {
      visit(JSON.parse(block), 0);
    } catch {
      // Not JSON: the page says nothing here.
    }
  }
  return found;
}

/**
 * The names a page gives itself, most reliable first: the site name in the meta tags, the name of the
 * organization in the structured data, then the parts of the title. Nothing here is followed or run.
 */
export function selfNames(page: string): string[] {
  const html = page.slice(0, MAX_IDENTITY_HTML);
  const lower = html.toLowerCase();
  const raw: string[] = [];
  for (const tag of openTags(html, lower, "meta")) {
    if (tag.length > 2_000) continue;
    const key = META_KEY.exec(tag);
    const content = META_CONTENT.exec(tag);
    if (key && content && SELF_NAME_META.test((key[1] ?? key[2] ?? "").trim())) raw.push(content[1] ?? content[2] ?? "");
  }
  raw.push(...structuredNames(structuredData(html, lower)));
  raw.push(...titleOf(html).split(TITLE_SPLIT));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of raw) {
    const name = entry.normalize("NFKC").replace(/\s+/g, " ").trim();
    const key = comparable(name);
    if (name === "" || name.length > 100 || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= MAX_SELF_NAMES) break;
  }
  return names;
}

/** What is left of a name the site gives itself without the words for what a page is. */
const withoutPageWords = (name: string): string => PAGE_WORDS.reduce((text, word) => text.split(word).join(" "), name).replace(/\s+/g, " ").trim();

/**
 * The parts of such a name that say who the company is: not what is sold or what a page is, at least
 * three letters, one of them kanji, katakana or Latin, and not beginning with a hiragana particle.
 */
function brandParts(name: string): string[] {
  return distinctiveParts(withoutPageWords(name)).filter(
    (part) => comparable(part).length >= 3 && /[\u30a0-\u30ff\u4e00-\u9fffA-Za-z]/.test(part) && !/^[\u3040-\u309f]/.test(part),
  );
}

/**
 * The company's name when the site and the console's page agree on it: a name the site gives itself
 * that the text of the program's page in the console also has. The console may name the operating
 * company and the site the service, but neither source alone is taken for the other's word.
 */
function nameBothSidesGive(names: readonly string[], programText: string): string | undefined {
  const program = comparable(programText);
  for (const name of names) {
    const hit = brandParts(name)
      .sort((a, b) => b.length - a.length)
      .find((part) => program.includes(comparable(part)));
    if (!hit) continue;
    const cleaned = withoutPageWords(name);
    return cleaned.length >= hit.length && cleaned.length <= MAX_SELF_NAME_CHARS ? cleaned : hit;
  }
  return undefined;
}

const SELLS_WATER = /ウォーターサーバー|宅配水|天然水|ミネラルウォーター|宅配ウォーター/;

/** How much of the name's letter pairs the page has, in four steps. */
function overlapStep(name: string, pageText: string): number {
  const wanted = comparable(name);
  const have = comparable(pageText);
  const pairs = new Set(Array.from({ length: Math.max(wanted.length - 1, 0) }, (_, index) => wanted.slice(index, index + 2)));
  if (pairs.size === 0) return 0;
  const found = [...pairs].filter((pair) => have.includes(pair)).length / pairs.size;
  return found < 0.2 ? 0 : found < 0.5 ? 1 : found < 0.8 ? 2 : 3;
}

/**
 * Facts about a miss that carry no name, to learn from the log why a name was not found: how much
 * text the page had (`lt1k`/`lt3k`/`ge3k`), the kind of letters the name uses, how many distinctive
 * parts it had (none: the console named what is sold, not who sells it), whether the page is about
 * water at all (`v`), how much of the name's letter pairs it has (`o0`..`o3`) and whether its title is
 * in Latin letters (`tlatin`), Japanese (`tjp`) or missing (`tnone`), and how many names the site gives
 * itself that could stand for the company (`s0`..`s3`).
 */
function nameMissNote(name: string, top: { text: string; html: string }, names: readonly string[]): string {
  const whole = siteNameOf(name);
  const size = top.text.length < 1000 ? "lt1k" : top.text.length < 3000 ? "lt3k" : "ge3k";
  const letters = /[\u30a0-\u30ff]/.test(whole) ? "kana" : /[\u4e00-\u9fff]/.test(whole) ? "kanji" : /[a-z]/i.test(whole) ? "latin" : "other";
  const title = titleOf(top.html);
  const titleKind = title === "" ? "none" : /[a-z]{3}/i.test(title) && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(title) ? "latin" : "jp";
  const overlap = overlapStep(whole, `${top.text}\n${identityText(top.html)}`);
  return `name_miss_${size}_${letters}_p${Math.min(distinctiveParts(whole).length, 9)}_v${SELLS_WATER.test(top.text) ? 1 : 0}_o${overlap}_t${titleKind}_s${Math.min(names.filter((own) => brandParts(own).length > 0).length, 3)}`;
}

const MIN_TOP_TEXT = 200;

/** What went wrong with a fetch, in a word that carries no address. */
function whyUnavailable(error: unknown): string {
  if (!(error instanceof FetchError)) return "error";
  if (error.status === null) return /abort|timeout|timed out/i.test(error.message) ? "timeout" : "network";
  return /exceeds/.test(error.message) ? "toolarge" : `http${error.status}`;
}

async function readPage(fetcher: Fetcher, url: string, host: string): Promise<ReadOutcome> {
  if (registrableHost(new URL(url).hostname) !== host) return { unavailable: "offsite" };
  try {
    if ((await checkRobots(fetcher, url)).disallowsAll) return { robots: true };
    const page = await fetcher.fetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    if (page.status < 200 || page.status >= 300) return { unavailable: `http${page.status}` };
    if (!/html/i.test(page.contentType)) return { unavailable: "notHtml" };
    if (registrableHost(new URL(page.finalUrl).hostname) !== host) return { unavailable: "offsite" };
    return { read: { url: page.finalUrl, html: page.body, text: htmlToVisibleText(page.body, page.contentType) } };
  } catch (error) {
    return { unavailable: whyUnavailable(error) };
  }
}

/** "Not now", and which page (`top`, `terms`, `partner`, `price`) and why, so that the log can tell a blocked site from a slow one. */
const unreachable = (page: string, why?: string): VetResult => ({
  ok: false,
  reasons: ["site_unreachable", why ? `unreachable_${page}_${why}` : `unreachable_${page}`],
});

function sameSiteLinks(links: readonly PageLink[], host: string): PageLink[] {
  return links.filter((link) => registrableHost(new URL(link.url).hostname) === host);
}

interface Linked {
  pages: Read[];
  robots: boolean;
  /** Links that matched but whose page could not be read now. */
  unreadable: number;
  /** Why the first of them could not be read. */
  why?: string;
}

/** Pages behind the links whose text matches, in the order of the page, at most `limit` that can be read. */
async function readLinked(fetcher: Fetcher, links: readonly PageLink[], pattern: RegExp, host: string, limit: number): Promise<Linked> {
  const pages: Read[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  let why: string | undefined;
  for (const link of links) {
    if (pages.length >= limit) break;
    if (!pattern.test(link.text) || seen.has(link.url)) continue;
    seen.add(link.url);
    const outcome = await readPage(fetcher, link.url, host);
    if ("robots" in outcome) return { pages, robots: true, unreadable };
    if ("read" in outcome) {
      pages.push(outcome.read);
    } else {
      unreadable += 1;
      why ??= outcome.unavailable;
    }
  }
  return { pages, robots: false, unreadable, ...(why ? { why } : {}) };
}

function priceCandidates(links: readonly PageLink[], used: ReadonlySet<string>): string[] {
  const scored = links
    .filter((link) => !used.has(link.url) && !NOT_PRICE_LINK.test(link.text) && PRICE_LINK.test(link.text))
    .map((link, index) => ({ url: link.url, index, score: (/料金|価格/.test(link.text) ? 2 : 0) + (/プラン|ラインナップ|サーバー|機種/.test(link.text) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return [...new Set(scored.map((entry) => entry.url))].slice(0, MAX_PRICE_PAGES);
}

/** A price page shows prices: at least one amount in yen. */
const YEN_AMOUNT = /\d[\d,]*\s*円/;

export async function vetAdvertiserSite(candidate: VetCandidate, deps: VetDeps): Promise<VetResult> {
  const { host } = candidate;

  let top: Read | undefined;
  const whys: string[] = [];
  for (const origin of [`https://${host}/`, `https://www.${host}/`]) {
    const outcome = await readPage(deps.fetcher, origin, host);
    if ("robots" in outcome) return { ok: false, reasons: ["robots_disallow"] };
    if ("read" in outcome) {
      top = outcome.read;
      break;
    }
    if (!whys.includes(outcome.unavailable)) whys.push(outcome.unavailable);
  }
  if (!top) return unreachable("top", whys.join("_"));
  // A front page with almost no text is probably drawn by script: not this check's to judge.
  if (top.text.length < MIN_TOP_TEXT) return unreachable("top", "thin");
  const names = selfNames(top.html);
  const brandName =
    nameOnSite(candidate.name, `${top.text}\n${identityText(top.html)}`) ?? (candidate.programText ? nameBothSidesGive(names, candidate.programText) : undefined);
  if (!brandName) return { ok: false, reasons: ["name_not_on_site", nameMissNote(candidate.name, top, names)] };

  const links = sameSiteLinks(linksOfHtml(top.html, top.url), host);
  const terms = await readLinked(deps.fetcher, links, TERMS_LINK, host, MAX_RULE_PAGES);
  if (terms.robots) return { ok: false, reasons: ["robots_disallow"] };
  if (terms.pages.length === 0) return terms.unreadable > 0 ? unreachable("terms", terms.why) : { ok: false, reasons: ["terms_not_found"] };
  const partner = await readLinked(deps.fetcher, links, PARTNER_LINK, host, MAX_RULE_PAGES);
  if (partner.robots) return { ok: false, reasons: ["robots_disallow"] };
  // A rules page for partners that is there but cannot be read now is not "no rules for partners".
  if (partner.pages.length === 0 && partner.unreadable > 0) return unreachable("partner", partner.why);

  const reasons = new Set<string>();
  if (terms.pages.some((page) => automationBan(page.text)) || partner.pages.some((page) => automationBan(page.text))) {
    reasons.add("terms_ban_automation");
  }
  for (const page of partner.pages) for (const reason of restrictionReasons(page.text)) reasons.add(reason);
  if (reasons.size > 0) return { ok: false, reasons: [...reasons] };

  const rules = partner.pages[0] ?? terms.pages[0]!;
  if (!deps.lister) return { ok: false, reasons: ["no_lister"] };
  const used = new Set([...terms.pages, ...partner.pages].map((page) => page.url));
  const pricePages = [...priceCandidates(links, used), top.url];
  const approvedPolicy: PolicyConfig = { ...deps.policy, security: { ...deps.policy.security, allowed_source_domains: [host] } };

  let sawPage = false;
  let failedListing = false;
  let unreadable = 0;
  let unreadableWhy: string | undefined;
  // What the first page that lists servers gave, kept while the other price pages are read for their prices only.
  let listing: { source: DiscoverySource; services: number; plans: ArticlePlan[] } | undefined;
  const pagesWithPrices: string[] = [];
  for (const url of [...new Set(pricePages)]) {
    // The same guards as every other page: robots.txt, the host the page really came from, and prices on it.
    const outcome = await readPage(deps.fetcher, url, host);
    if ("robots" in outcome) continue;
    if (!("read" in outcome)) {
      unreadable += 1;
      unreadableWhy ??= outcome.unavailable;
      continue;
    }
    if (!YEN_AMOUNT.test(outcome.read.text)) continue;
    pagesWithPrices.push(outcome.read.url);
    if (listing) continue;
    const source: DiscoverySource = {
      verticalId: "water_delivery",
      brandSlug: candidate.brandSlug,
      brandName,
      listUrls: [outcome.read.url],
      sourceUrls: [outcome.read.url],
      months: 24,
      monthlyLiters: 25,
    };
    const found = await discoverPlans([source], {
      repo: deps.repo,
      policy: approvedPolicy,
      clock: deps.clock,
      fetcher: deps.fetcher,
      lister: deps.lister,
    });
    if (found.plans.length > 0) {
      listing = { source, services: found.plans.length, plans: found.plans };
      continue;
    }
    sawPage ||= (found.summary.skipped.no_services ?? 0) > 0;
    failedListing ||= (found.summary.skipped.listing_failed ?? 0) > 0;
  }
  if (listing) {
    const sourceUrls = withMorePages(listing.source.listUrls, pagesWithPrices);
    if (deps.draft) {
      const refusal = await undraftable(listing.plans, sourceUrls, (plan) => deps.draft!(plan, approvedPolicy));
      if (refusal) return refusal;
    }
    return {
      ok: true,
      brandName,
      termsUrl: rules.url,
      termsSha256: termsFingerprint(rules.text),
      listUrls: listing.source.listUrls,
      sourceUrls,
      services: listing.services,
    };
  }
  if (failedListing && !sawPage) return { ok: false, reasons: ["listing_failed"] };
  if (!sawPage && unreadable > 0) return unreachable("price", unreadableWhy);
  return { ok: false, reasons: [sawPage ? "no_services" : "no_price_page"] };
}

/** The reading of amounts a site was judged undraftable by, kept with its reasons (see `DRAFT_RULES_VERSION`). */
export const DRAFT_RULES_MARK = `draft_rules_${DRAFT_RULES_VERSION}`;

/** How many of a site's services are tried before it is said that none can be drafted. */
const MAX_TRIAL_PLANS = 2;

/**
 * How an amount fell short, in a word that carries nothing the page said: `_nofact` when no fact had any yen
 * amount to read, `_conflict` when the facts gave it two answers, nothing when facts had amounts but none fit.
 */
function draftIssueShortfall(issue: string): string {
  if (!issue.includes("見つかりません")) return "_conflict";
  return issue.includes("該当するFactがありません") ? "_nofact" : "";
}

/** The amount a drafting issue is about, and how it fell short, in words that carry nothing the page said. */
function draftIssueCode(issue: string): string {
  if (issue.startsWith("水代")) return `draft_water${draftIssueShortfall(issue)}`;
  if (issue.startsWith("送料")) return `draft_shipping${draftIssueShortfall(issue)}`;
  if (issue.startsWith("電気代")) return `draft_electricity${draftIssueShortfall(issue)}`;
  if (issue.startsWith("初回費用")) return `draft_initial${draftIssueShortfall(issue)}`;
  if (issue.startsWith("サーバーレンタル料")) return `draft_rental${draftIssueShortfall(issue)}`;
  if (issue.startsWith("source_unavailable")) return "draft_source";
  return "draft_other";
}

/**
 * A site is of no use if none of its services can be drafted into a plan from the pages it would rest on: the
 * advertiser would hold a place and be applied to for articles that cannot be written. Undefined when one can;
 * the reasons carry which amounts were missing, never the words of the page. A model that fails is not a verdict.
 */
async function undraftable(
  plans: readonly ArticlePlan[],
  sourceUrls: readonly string[],
  draft: (plan: ArticlePlan) => Promise<DraftResult>,
): Promise<VetResult | undefined> {
  const missing = new Set<string>();
  for (const plan of plans.slice(0, MAX_TRIAL_PLANS)) {
    let result: DraftResult;
    try {
      result = await draft({ ...plan, sourceUrls: [...sourceUrls] });
    } catch {
      return { ok: false, reasons: ["listing_failed"] };
    }
    if (result.ok) return undefined;
    for (const issue of result.issues) missing.add(draftIssueCode(issue));
  }
  return { ok: false, reasons: ["plan_not_draftable", ...[...missing].sort(), DRAFT_RULES_MARK] };
}

/**
 * The same trial for an advertiser that is already registered, from the pages it has now: its services are listed
 * again and drafted from its source pages. A site where nothing could be listed today is not judged.
 */
export async function trialRegistered(
  brand: { brandSlug: string; brandName: string; host: string; listUrls: readonly string[]; sourceUrls: readonly string[] },
  deps: VetDeps,
): Promise<{ ok: true } | { ok: false; reasons: string[] }> {
  if (!deps.lister || !deps.draft) return { ok: false, reasons: ["no_lister"] };
  const approved: PolicyConfig = { ...deps.policy, security: { ...deps.policy.security, allowed_source_domains: [brand.host] } };
  const source: DiscoverySource = {
    verticalId: "water_delivery",
    brandSlug: brand.brandSlug,
    brandName: brand.brandName,
    listUrls: [...brand.listUrls],
    sourceUrls: [...brand.sourceUrls],
    months: 24,
    monthlyLiters: 25,
  };
  const found = await discoverPlans([source], { repo: deps.repo, policy: approved, clock: deps.clock, fetcher: deps.fetcher, lister: deps.lister });
  if (found.plans.length === 0) return { ok: false, reasons: ["listing_failed"] };
  const draft = deps.draft;
  const refusal = await undraftable(found.plans, brand.sourceUrls, (plan) => draft(plan, approved));
  if (!refusal) return { ok: true };
  return refusal.ok ? { ok: true } : { ok: false, reasons: refusal.reasons };
}

/** The pages the list came from first, then the other price pages, each once, at most `MAX_SOURCE_PAGES`. */
function withMorePages(first: readonly string[], others: readonly string[]): string[] {
  return [...new Set([...first, ...others])].slice(0, MAX_SOURCE_PAGES);
}

/**
 * The pages a registered advertiser's plans take their amounts from, looked at again: the pages it already has,
 * then any page of the site that now shows prices and passes the same guards (robots.txt, the site, prices on it).
 * Pages are only added, never taken away. Undefined when the front page cannot be read now: not today's to judge.
 */
export async function refreshSourcePages(fetcher: Fetcher, host: string, known: readonly string[], rulesPages: readonly string[]): Promise<string[] | undefined> {
  let top: Read | undefined;
  for (const origin of [`https://${host}/`, `https://www.${host}/`]) {
    const outcome = await readPage(fetcher, origin, host);
    if ("read" in outcome) {
      top = outcome.read;
      break;
    }
  }
  if (!top || top.text.length < MIN_TOP_TEXT) return undefined;
  const candidates = [...priceCandidates(sameSiteLinks(linksOfHtml(top.html, top.url), host), new Set(rulesPages)), top.url];
  const pagesWithPrices: string[] = [];
  for (const url of [...new Set(candidates)]) {
    if (known.includes(url)) continue;
    const outcome = await readPage(fetcher, url, host);
    if ("read" in outcome && YEN_AMOUNT.test(outcome.read.text)) pagesWithPrices.push(outcome.read.url);
  }
  return withMorePages(known, pagesWithPrices);
}

export type RereadResult = { ok: true; termsSha256: string } | { ok: false; reasons: string[] };

/** A rules page for partners says so at its top; the terms of use of a site have sentences about fees that are not about advertising. */
const PARTNER_PAGE = /アフィリエイト|アフィリエイター|パートナー|広告掲載/;

/**
 * The advertiser's rules page again, after it changed: still readable and still leaving room for the
 * comparison. `terms_unreadable` is a "not now"; the other reasons are about what the page says. The
 * page is held to the same rules as when it was first read: a partner page to the rules about what an
 * article may say, any page to the ban on collecting by program.
 */
export async function rereadTerms(fetcher: Fetcher, termsUrl: string, host: string): Promise<RereadResult> {
  const outcome = await readPage(fetcher, termsUrl, host);
  if (!("read" in outcome)) return { ok: false, reasons: ["terms_unreadable"] };
  const reasons = new Set<string>(PARTNER_PAGE.test(outcome.read.text.slice(0, 300)) ? restrictionReasons(outcome.read.text) : []);
  if (automationBan(outcome.read.text)) reasons.add("terms_ban_automation");
  if (reasons.size > 0) return { ok: false, reasons: [...reasons] };
  return { ok: true, termsSha256: termsFingerprint(outcome.read.text) };
}
