// @ts-check
import { defineConfig } from "astro/config";
import { remarkCharts } from "./plugins/charts.mjs";
import { articleRehypePlugins } from "./plugins/rehype-article.mjs";

export default defineConfig({
  site: process.env.SITE_BASE_URL ?? "https://example.com",
  markdown: {
    // ```chart blocks written by the draft engine become figures.
    remarkPlugins: [remarkCharts],
    // Sponsored-link qualification (docs/06) plus presentation-only transforms.
    rehypePlugins: articleRehypePlugins,
  },
});
