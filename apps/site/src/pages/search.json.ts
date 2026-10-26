import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { isoDate, sortByNewest } from "../lib/articles";

/**
 * Static search index for the archive page: title + description only, so it
 * stays small (a few hundred bytes per article) even with thousands of posts.
 */
export const GET: APIRoute = async () => {
  const entries = sortByNewest(await getCollection("articles")).map((article) => ({
    id: article.id,
    title: article.data.title,
    description: article.data.description,
    date: isoDate(article.data.pubDate),
    pr: article.data.offerIds.length > 0,
  }));
  return new Response(JSON.stringify(entries), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
