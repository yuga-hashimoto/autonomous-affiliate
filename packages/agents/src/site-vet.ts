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

const TERMS_LINK = /利用規約|ご利用規約|利用条件|サイトポリシー|サイトのご利用|ご利用にあたって|Terms/i;
/** "提携" alone is too loose (partner hospitals, partner shops): only wording that is about advertising partners. */
const PARTNER_LINK = /アフィリエイト|パートナー募集|パートナープログラム|広告掲載|提携者|アフィリエイター/;
const PRICE_LINK = /料金|価格|プラン|ラインナップ|商品|サーバー|機種|ご利用料金/;
const NOT_PRICE_LINK = /規約|プライバシー|個人情報|会社|採用|お問い合わせ|ログイン|アフィリエイト|パートナー|特定商取引|サイトマップ/;
const MAX_PRICE_PAGES = 3;
const MAX_RULE_PAGES = 2;
const FETCH_TIMEOUT_MS = 15_000;

/** Reasons that say "not now" rather than "not this site": a caller may look again soon. */
export const TRANSIENT_REASONS: ReadonlySet<string> = new Set(["site_unreachable", "no_lister", "listing_failed", "page_unreadable"]);

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

const comparable = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

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

/** Pages behind the links whose text matches, in the order of the page, at most `limit` that can be read. */
async function readLinked(
  fetcher: Fetcher,
  links: readonly PageLink[],
  pattern: RegExp,
  host: string,
  limit: number,
): Promise<{ pages: Read[]; robots: boolean }> {
  const pages: Read[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (pages.length >= limit) break;
    if (!pattern.test(link.text) || seen.has(link.url)) continue;
    seen.add(link.url);
    const outcome = await readPage(fetcher, link.url, host);
    if ("robots" in outcome) return { pages, robots: true };
    if ("read" in outcome) pages.push(outcome.read);
  }
  return { pages, robots: false };
}

function priceCandidates(links: readonly PageLink[], used: ReadonlySet<string>): string[] {
  const scored = links
    .filter((link) => !used.has(link.url) && !NOT_PRICE_LINK.test(link.text) && PRICE_LINK.test(link.text))
    .map((link, index) => ({ url: link.url, index, score: (/料金|価格/.test(link.text) ? 2 : 0) + (/プラン|ラインナップ|サーバー|機種/.test(link.text) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return [...new Set(scored.map((entry) => entry.url))].slice(0, MAX_PRICE_PAGES);
}

export async function vetAdvertiserSite(candidate: VetCandidate, deps: VetDeps): Promise<VetResult> {
  const { host } = candidate;
  const brandName = siteNameOf(candidate.name);

  let top: Read | undefined;
  for (const origin of [`https://${host}/`, `https://www.${host}/`]) {
    const outcome = await readPage(deps.fetcher, origin, host);
    if ("robots" in outcome) return { ok: false, reasons: ["robots_disallow"] };
    if ("read" in outcome) {
      top = outcome.read;
      break;
    }
  }
  if (!top) return { ok: false, reasons: ["site_unreachable"] };
  if (!comparable(top.text).includes(comparable(brandName))) return { ok: false, reasons: ["name_not_on_site"] };

  const links = sameSiteLinks(linksOfHtml(top.html, top.url), host);
  const terms = await readLinked(deps.fetcher, links, TERMS_LINK, host, MAX_RULE_PAGES);
  if (terms.robots) return { ok: false, reasons: ["robots_disallow"] };
  if (terms.pages.length === 0) return { ok: false, reasons: ["terms_not_found"] };
  const partner = await readLinked(deps.fetcher, links, PARTNER_LINK, host, MAX_RULE_PAGES);
  if (partner.robots) return { ok: false, reasons: ["robots_disallow"] };

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
  for (const url of pricePages) {
    const source: DiscoverySource = {
      verticalId: "water_delivery",
      brandSlug: candidate.brandSlug,
      brandName,
      listUrls: [url],
      sourceUrls: [url],
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
        listUrls: [url],
        sourceUrls: [url],
        services: found.plans.length,
      };
    }
    sawPage ||= (found.summary.skipped.no_services ?? 0) > 0;
    failedListing ||= (found.summary.skipped.listing_failed ?? 0) > 0;
  }
  if (failedListing && !sawPage) return { ok: false, reasons: ["listing_failed"] };
  return { ok: false, reasons: [sawPage ? "no_services" : "no_price_page"] };
}

export type RereadResult = { ok: true; termsSha256: string } | { ok: false; reasons: string[] };

/**
 * The advertiser's rules page again, after it changed: still readable and still leaving room for the
 * comparison. `terms_unreadable` is a "not now"; the other reasons are about what the page says.
 */
export async function rereadTerms(fetcher: Fetcher, termsUrl: string, host: string): Promise<RereadResult> {
  const outcome = await readPage(fetcher, termsUrl, host);
  if (!("read" in outcome)) return { ok: false, reasons: ["terms_unreadable"] };
  const reasons = new Set<string>(restrictionReasons(outcome.read.text));
  if (automationBan(outcome.read.text)) reasons.add("terms_ban_automation");
  if (reasons.size > 0) return { ok: false, reasons: [...reasons] };
  return { ok: true, termsSha256: termsFingerprint(outcome.read.text) };
}
