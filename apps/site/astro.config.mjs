// @ts-check
import { defineConfig } from "astro/config";
import { articleRehypePlugins } from "./plugins/rehype-article.mjs";

export default defineConfig({
  site: process.env.SITE_BASE_URL ?? "https://example.com",
  markdown: {
    // Sponsored-link qualification (docs/06) plus presentation-only transforms.
    rehypePlugins: articleRehypePlugins,
  },
});
