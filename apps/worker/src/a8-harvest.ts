import type { Page } from "playwright";
import { openProgramPage } from "./a8-inspect.js";
import { settlePage } from "./a8-programs.js";

/**
 * Reads the ad link (広告リンク) a joined program issues for one site, from the console's
 * ad-link page. Nothing is generated or sent: the page already shows the ad codes, and the only
 * thing pressed is the page's own "show" button when the wrong site is selected.
 *
 * The link is the account's: it is returned to the caller and never printed, logged or put in an
 * error. Page content is untrusted, so only a URL of the exact A8 tracking shape is kept.
 */

const LINK_SITE_SELECT = "form[name=asLinkForm] select[name=websiteId]";
const LINK_FORM_BUTTON = "form[name=asLinkForm] button[type=submit]";
const NAVIGATION_TIMEOUT_MS = 30_000;
const CODES_TIMEOUT_MS = 10_000;
const MAX_CODES = 60;

/** `https://px.a8.net/svt/ejp?...`, only where a link can start (not inside another URL's query). */
const TRACKING_LINK = /(?:^|[\s"'>(])https:\/\/px\.a8\.net\/svt\/ejp\?([^\s"'<>)]*)/g;
const MATERIAL_CODE = /^[A-Za-z0-9+%._-]{8,200}$/;
/** The 1x1 counter image every ad code carries; any other image makes the code a banner. */
const COUNTER_IMAGE = /<img\b[^>]*\bsrc=["']https:\/\/www\d*\.a8\.net\/0\.gif[^"']*["'][^>]*>/gi;

/** The tracking URL in an ad code, reduced to its host, path and material code. */
export function extractTrackingUrl(adCode: string): string | undefined {
  for (const match of adCode.matchAll(TRACKING_LINK)) {
    const query = (match[1] ?? "").replace(/&amp;/gi, "&");
    for (const pair of query.split("&")) {
      const [key, ...rest] = pair.split("=");
      const value = rest.join("=");
      if (key === "a8mat" && MATERIAL_CODE.test(value)) return `https://px.a8.net/svt/ejp?a8mat=${value}`;
    }
  }
  return undefined;
}

/** Whether the code shows an image of the advertiser's (a banner) rather than only a text link. */
export function isBannerCode(adCode: string): boolean {
  return /<img\b/i.test(adCode.replace(COUNTER_IMAGE, ""));
}

/**
 * The link to use: a text ad's before any banner's, because the article shows the advertiser's
 * images never (their terms forbid saving them). A program with only banners still gives a link.
 */
export function pickTrackingUrl(adCodes: readonly string[]): string | undefined {
  const usable = adCodes.filter((code) => extractTrackingUrl(code) !== undefined);
  const code = usable.find((candidate) => !isBannerCode(candidate)) ?? usable[0];
  return code === undefined ? undefined : extractTrackingUrl(code);
}

export interface LinkSiteOption {
  value: string;
  text: string;
  selected: boolean;
}

export interface LinkPageRead {
  sites: LinkSiteOption[];
  adCodes: string[];
}

export type HarvestFailure = "site_missing" | "site_ambiguous" | "site_not_selected" | "no_link_found";
export type HarvestOutcome = { ok: true; url: string } | { ok: false; reason: HarvestFailure };

/**
 * A link only when the page shows it for the target site: the material code in it belongs to
 * the site selected on the page, and the account's first site is the default, which is the
 * mistake this guards against.
 */
export function decideHarvest(read: LinkPageRead, siteName: string): HarvestOutcome {
  const wanted = siteName.trim();
  const named = wanted ? read.sites.filter((site) => site.text.includes(wanted)) : [];
  if (named.length === 0) return { ok: false, reason: "site_missing" };
  if (named.length > 1) return { ok: false, reason: "site_ambiguous" };
  if (read.sites.find((site) => site.selected)?.value !== named[0]!.value) return { ok: false, reason: "site_not_selected" };
  const url = pickTrackingUrl(read.adCodes);
  return url ? { ok: true, url } : { ok: false, reason: "no_link_found" };
}

/** Runs in the page. A string, because this project's TypeScript config has no DOM types. */
export const READ_LINK_PAGE = `(() => {
  const root = document.querySelector("main") || document.body;
  const select = root.querySelector("select[name=websiteId]");
  return {
    sites: select
      ? Array.from(select.options).map((option) => ({
          value: option.value,
          text: (option.textContent || "").trim(),
          selected: option.selected,
        }))
      : [],
    adCodes: Array.from(root.querySelectorAll("textarea")).slice(0, ${MAX_CODES}).map((area) => area.value || ""),
  };
})()`;

const ANY_CODE_SHOWN = `Array.from(document.querySelectorAll("textarea")).some((area) => (area.value || "").trim().length > 0)`;

async function readWhenDrawn(page: Page): Promise<LinkPageRead> {
  await settlePage(page);
  await page.waitForFunction(ANY_CODE_SHOWN, undefined, { timeout: CODES_TIMEOUT_MS }).catch(() => undefined);
  return (await page.evaluate(READ_LINK_PAGE)) as LinkPageRead;
}

/**
 * Opens a joined program's ad-link page (a path taken from the partnered list) and returns the
 * link for the target site. When another site is selected, the target is chosen and the page's
 * own "show" button pressed once; that is a GET form that changes nothing in the account.
 */
export async function harvestTrackingUrl(page: Page, createLinkPath: string, siteName: string): Promise<HarvestOutcome> {
  await openProgramPage(page, createLinkPath);
  const first = await readWhenDrawn(page);
  const decided = decideHarvest(first, siteName);
  if (decided.ok || decided.reason !== "site_not_selected") return decided;

  const target = first.sites.find((site) => site.text.includes(siteName.trim()));
  if (!target || (await page.locator(LINK_FORM_BUTTON).count()) !== 1) return decided;
  await page.selectOption(LINK_SITE_SELECT, target.value);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined),
    page.click(LINK_FORM_BUTTON),
  ]);
  return decideHarvest(await readWhenDrawn(page), siteName);
}
