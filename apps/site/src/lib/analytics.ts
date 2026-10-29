/**
 * GA4 tag and affiliate-click events (docs/08). Pure helpers, free of `astro:*`
 * imports so vitest can test them; the page wiring is components/AnalyticsTag.astro.
 *
 * The tag is opt-in by build configuration: without a valid GA4_MEASUREMENT_ID
 * nothing is injected, and the privacy page says so (fail closed).
 */

export const CTA_EVENT_NAME = "affiliate_cta_click";
/** Matches the `channel` the outbound-click KPIs use for clicks on this site (docs/08). */
export const CTA_CHANNEL = "site";

const MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;
const GO_LINK = /^\/go\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/?(?:[?#].*)?$/;
const ARTICLE_PATH = /^\/articles\/([^/]+)\/?$/;

/**
 * A GA4 measurement id (`G-XXXXXXXX`), or undefined. Strict on purpose: the id
 * is written into an inline script, so anything unexpected must disable the tag
 * rather than be escaped and trusted.
 */
export function measurementIdFrom(raw: string | undefined): string | undefined {
  const id = raw?.trim();
  return id !== undefined && MEASUREMENT_ID.test(id) ? id : undefined;
}

/**
 * Inline script that loads gtag.js and starts GA4. Google signals and ad
 * personalization stay off, and nothing is requested for visitors who send
 * Do Not Track or Global Privacy Control. `id` must come from measurementIdFrom.
 */
export function ga4Snippet(id: string): string {
  return [
    "(function(){",
    `var id=${JSON.stringify(id)};`,
    "var nav=window.navigator;",
    'if(nav.doNotTrack==="1"||nav.globalPrivacyControl===true)return;',
    "window.dataLayer=window.dataLayer||[];",
    "window.gtag=function(){window.dataLayer.push(arguments);};",
    'window.gtag("js",new Date());',
    'window.gtag("config",id,{allow_google_signals:false,allow_ad_personalization_signals:false});',
    'var s=document.createElement("script");',
    "s.async=true;",
    's.src="https://www.googletagmanager.com/gtag/js?id="+encodeURIComponent(id);',
    "document.head.appendChild(s);",
    "})();",
  ].join("");
}

/** The id of the page a click happened on: the article slug, else a readable path. */
export function pageIdOf(pathname: string): string {
  const article = ARTICLE_PATH.exec(pathname);
  if (article?.[1]) return article[1];
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "home" : trimmed;
}

export interface CtaClickEvent {
  name: typeof CTA_EVENT_NAME;
  params: { page_id: string; offer_id: string; cta_id: string; channel: string };
}

/**
 * The GA4 event for a click on an affiliate redirect link (`/go/<offerId>`),
 * or undefined for any other link. Only the offer id, the page and the link's
 * position are reported: never the destination URL or a query string.
 * `ordinal` is the 1-based position of the link among the page's `/go/` links.
 */
export function ctaClickEvent(input: { href: string; pathname: string; ordinal: number }): CtaClickEvent | undefined {
  const match = GO_LINK.exec(input.href);
  const offerId = match?.[1];
  if (offerId === undefined || offerId === "." || offerId === "..") return undefined;
  return {
    name: CTA_EVENT_NAME,
    params: {
      page_id: pageIdOf(input.pathname),
      offer_id: offerId,
      cta_id: `cta-${input.ordinal}`,
      channel: CTA_CHANNEL,
    },
  };
}
