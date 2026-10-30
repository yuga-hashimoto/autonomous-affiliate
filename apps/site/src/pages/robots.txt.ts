import type { APIRoute } from "astro";
import { robotsTxt } from "../lib/sitemap";

/** Same fallback as BaseLayout, so canonical URLs and the sitemap line always agree. */
const FALLBACK_SITE = new URL("https://example.com");

export const GET: APIRoute = ({ site }) =>
  new Response(robotsTxt(site ?? FALLBACK_SITE), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
