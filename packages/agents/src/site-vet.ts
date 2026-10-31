import type { Repository } from "@aff/db";
import type { PolicyConfig } from "@aff/domain";
import { checkRobots, htmlToVisibleText, linksOfHtml, type Fetcher, type PageLink } from "@aff/integrations";
import { termsFingerprint } from "./a8-offers.js";
import { discoverPlans, type DiscoverySource, type PlanLister } from "./plan-discovery.js";
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
const MAX_RULE_PAGES = 2;
const FETCH_TIMEOUT_MS = 15_000;

/** Reasons that say "not now" rather than "not this site": a caller may look again soon. */
export const TRANSIENT_REASONS: ReadonlySet<string> = new Set(["site_unreachable", "no_lister", "listing_failed", "page_unreadable", "vet_timeout"]);

export interface VetCandidate {
  /** The advertiser's name as the console shows it. */
  name: string;
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

type ReadOutcome = { read: Read } | { robots: true } | { unavailable: true };

/** The name without a trailing note in brackets: `ブランドA（ウォーターサーバー）` -> `ブランドA`. */
export function siteNameOf(name: string): string {
  return name.replace(/[（(【[][^）)】\]]*[）)】\]]/g, "").trim() || name.trim();
}

/** Words that say what the company sells, not who it is: a page that has only these is not the company's. */
const GENERIC_WORDS = ["ミネラルウォーター", "ウォーターサーバー", "宅配ウォーター", "ウォーター", "サーバー", "宅配水", "天然水", "公式", "サイト", "新規", "設置", "宅配", "水"];

const comparable = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

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

/**
 * Facts about a miss that carry no name: how much text the page had, which kind of letters the name
 * uses, and how many distinctive parts it had (none: the console named what is sold, not who sells it).
 */
function nameMissNote(name: string, text: string): string {
  const whole = siteNameOf(name);
  const size = text.length < 1000 ? "lt1k" : text.length < 3000 ? "lt3k" : "ge3k";
  const letters = /[\u30a0-\u30ff]/.test(whole) ? "kana" : /[\u4e00-\u9fff]/.test(whole) ? "kanji" : /[a-z]/i.test(whole) ? "latin" : "other";
  return `name_miss_${size}_${letters}_p${Math.min(distinctiveParts(whole).length, 9)}`;
}

const MIN_TOP_TEXT = 200;

async function readPage(fetcher: Fetcher, url: string, host: string): Promise<ReadOutcome> {
  if (registrableHost(new URL(url).hostname) !== host) return { unavailable: true };
  try {
    if ((await checkRobots(fetcher, url)).disallowsAll) return { robots: true };
    const page = await fetcher.fetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    if (page.status < 200 || page.status >= 300 || !/html/i.test(page.contentType)) return { unavailable: true };
    if (registrableHost(new URL(page.finalUrl).hostname) !== host) return { unavailable: true };
    return { read: { url: page.finalUrl, html: page.body, text: htmlToVisibleText(page.body, page.contentType) } };
  } catch {
    return { unavailable: true };
  }
}

function sameSiteLinks(links: readonly PageLink[], host: string): PageLink[] {
  return links.filter((link) => registrableHost(new URL(link.url).hostname) === host);
}

interface Linked {
  pages: Read[];
  robots: boolean;
  /** Links that matched but whose page could not be read now. */
  unreadable: number;
}

/** Pages behind the links whose text matches, in the order of the page, at most `limit` that can be read. */
async function readLinked(fetcher: Fetcher, links: readonly PageLink[], pattern: RegExp, host: string, limit: number): Promise<Linked> {
  const pages: Read[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  for (const link of links) {
    if (pages.length >= limit) break;
    if (!pattern.test(link.text) || seen.has(link.url)) continue;
    seen.add(link.url);
    const outcome = await readPage(fetcher, link.url, host);
    if ("robots" in outcome) return { pages, robots: true, unreadable };
    if ("read" in outcome) pages.push(outcome.read);
    else unreadable += 1;
  }
  return { pages, robots: false, unreadable };
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
  for (const origin of [`https://${host}/`, `https://www.${host}/`]) {
    const outcome = await readPage(deps.fetcher, origin, host);
    if ("robots" in outcome) return { ok: false, reasons: ["robots_disallow"] };
    if ("read" in outcome) {
      top = outcome.read;
      break;
    }
  }
  // A front page with almost no text is probably drawn by script: not this check's to judge.
  if (!top || top.text.length < MIN_TOP_TEXT) return { ok: false, reasons: ["site_unreachable"] };
  const brandName = nameOnSite(candidate.name, `${top.text}\n${identityText(top.html)}`);
  if (!brandName) return { ok: false, reasons: ["name_not_on_site", nameMissNote(candidate.name, top.text)] };

  const links = sameSiteLinks(linksOfHtml(top.html, top.url), host);
  const terms = await readLinked(deps.fetcher, links, TERMS_LINK, host, MAX_RULE_PAGES);
  if (terms.robots) return { ok: false, reasons: ["robots_disallow"] };
  if (terms.pages.length === 0) return { ok: false, reasons: [terms.unreadable > 0 ? "site_unreachable" : "terms_not_found"] };
  const partner = await readLinked(deps.fetcher, links, PARTNER_LINK, host, MAX_RULE_PAGES);
  if (partner.robots) return { ok: false, reasons: ["robots_disallow"] };
  // A rules page for partners that is there but cannot be read now is not "no rules for partners".
  if (partner.pages.length === 0 && partner.unreadable > 0) return { ok: false, reasons: ["site_unreachable"] };

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
  for (const url of [...new Set(pricePages)]) {
    // The same guards as every other page: robots.txt, the host the page really came from, and prices on it.
    const outcome = await readPage(deps.fetcher, url, host);
    if ("robots" in outcome) continue;
    if (!("read" in outcome)) {
      unreadable += 1;
      continue;
    }
    if (!YEN_AMOUNT.test(outcome.read.text)) continue;
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
      return {
        ok: true,
        brandName,
        termsUrl: rules.url,
        termsSha256: termsFingerprint(rules.text),
        listUrls: source.listUrls,
        sourceUrls: source.sourceUrls ?? source.listUrls,
        services: found.plans.length,
      };
    }
    sawPage ||= (found.summary.skipped.no_services ?? 0) > 0;
    failedListing ||= (found.summary.skipped.listing_failed ?? 0) > 0;
  }
  if (failedListing && !sawPage) return { ok: false, reasons: ["listing_failed"] };
  if (!sawPage && unreadable > 0) return { ok: false, reasons: ["site_unreachable"] };
  return { ok: false, reasons: [sawPage ? "no_services" : "no_price_page"] };
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
