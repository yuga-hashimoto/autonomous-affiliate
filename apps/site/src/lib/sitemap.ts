/**
 * sitemap.xml and robots.txt content. Pure helpers, free of `astro:*` imports
 * so vitest can test them; the endpoints are pages/sitemap.xml.ts and
 * pages/robots.txt.ts.
 *
 * Only pages meant to be found are listed: the pages in the footer navigation
 * and every article. The affiliate redirects (/go/), the search index and the
 * 404 page are not pages to index, so they never enter the list.
 */
import { isoDate, sortByNewest, type ArticleLike } from "./articles";
import { FOOTER_ITEMS } from "./site-nav";

export interface SitemapUrl {
  loc: string;
  /** `YYYY-MM-DD`; absent when the date is not known rather than guessed. */
  lastmod?: string;
}

/** The QA date of an article as a sitemap date, or undefined when it cannot be read. */
function lastmodOf(pubDate: string): string | undefined {
  const day = isoDate(pubDate);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) ? day : undefined;
}

/**
 * Footer pages first, then articles newest first. The home page and the archive
 * take the newest article's date, since that is when they last changed; the
 * other pages carry no date.
 */
export function sitemapUrls(site: URL, articles: readonly ArticleLike[]): SitemapUrl[] {
  const newestFirst = sortByNewest(articles);
  const newest = newestFirst[0] ? lastmodOf(newestFirst[0].data.pubDate) : undefined;
  const listing = new Set(["/", "/articles/"]);

  const pages = FOOTER_ITEMS.map(({ href }): SitemapUrl => {
    const loc = new URL(href, site).href;
    return listing.has(href) && newest !== undefined ? { loc, lastmod: newest } : { loc };
  });
  const posts = newestFirst.map((article): SitemapUrl => {
    const loc = new URL(`/articles/${article.id}/`, site).href;
    const lastmod = lastmodOf(article.data.pubDate);
    return lastmod === undefined ? { loc } : { loc, lastmod };
  });

  const seen = new Set<string>();
  return [...pages, ...posts].filter(({ loc }) => (seen.has(loc) ? false : (seen.add(loc), true)));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function sitemapXml(urls: readonly SitemapUrl[]): string {
  const rows = urls.map(({ loc, lastmod }) => {
    const date = lastmod === undefined ? "" : `<lastmod>${escapeXml(lastmod)}</lastmod>`;
    return `<url><loc>${escapeXml(loc)}</loc>${date}</url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...rows,
    "</urlset>",
    "",
  ].join("\n");
}

/** Everything is open to crawlers except the affiliate redirects (docs/06). */
export function robotsTxt(site: URL): string {
  return ["User-agent: *", "Allow: /", "Disallow: /go/", "", `Sitemap: ${new URL("/sitemap.xml", site).href}`, ""].join("\n");
}
