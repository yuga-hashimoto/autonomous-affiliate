import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { searchEntryOf, sortByNewest } from "../lib/articles";

/**
 * Static search index for the archive page: title, description and thumbnail
 * path only, so it stays small (a few hundred bytes per article) even with
 * thousands of posts.
 */
export const GET: APIRoute = async () => {
  const entries = sortByNewest(await getCollection("articles")).map(searchEntryOf);
  return new Response(JSON.stringify(entries), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
