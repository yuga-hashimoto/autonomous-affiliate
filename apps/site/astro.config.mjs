// @ts-check
import { defineConfig } from "astro/config";
import { visit } from "unist-util-visit";

/**
 * Adds rel="sponsored noopener noreferrer" + target="_blank" to affiliate
 * redirect links (/go/...), and rel="noopener" + target="_blank" to other
 * external links (docs/06: affiliate links must be sponsored).
 */
function qualifyOutboundLinks() {
  return (tree) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "a") return;
      const href = String(node.properties?.href ?? "");
      if (!/^https?:\/\//.test(href) && !href.startsWith("/go/")) return;
      node.properties ??= {};
      if (href.startsWith("/go/") || /\/go\//.test(href)) {
        node.properties.rel = "sponsored noopener noreferrer";
        node.properties.target = "_blank";
      } else if (/^https?:\/\//.test(href)) {
        node.properties.rel = "noopener";
      }
    });
  };
}

export default defineConfig({
  site: process.env.SITE_BASE_URL ?? "https://example.com",
  markdown: {
    rehypePlugins: [qualifyOutboundLinks],
  },
});
