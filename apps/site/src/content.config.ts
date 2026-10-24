import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * Articles are produced by the pipeline (packages/agents) and written to the
 * versioned store at the repository root: content/articles/*.md.
 * Only QA-PASSed artifacts are committed here (docs/04 publication gate).
 */
const articles = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: process.env.ARTICLES_DIR ?? "../../content/articles",
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    /** ISO date of the QA decision that approved this revision. */
    pubDate: z.string(),
    /** Must be present on every article (docs/06). */
    disclosure: z.string().min(1),
    /** offer_id references; empty when the article is not monetized. */
    offerIds: z.array(z.string()).default([]),
    slug: z.string().optional(),
  }),
});

export const collections = { articles };
