import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { sitemapUrls, sitemapXml } from "../lib/sitemap";

/** Same fallback as BaseLayout, so canonical URLs and sitemap URLs always agree. */
const FALLBACK_SITE = new URL("https://example.com");

export const GET: APIRoute = async ({ site }) => {
  const articles = await getCollection("articles");
  return new Response(sitemapXml(sitemapUrls(site ?? FALLBACK_SITE, articles)), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
