// @ts-check
/**
 * Presentation-only transforms for pipeline-generated article markdown.
 *
 * The QA gate hashes the markdown body, so none of this changes what is
 * published in the repository; it only changes how the rendered HTML reads
 * on a phone: one <h1>, scrollable tables, a clear call-to-action, and so on.
 * Every transform is a no-op when the expected structure is absent, so a
 * hand-written page renders unchanged.
 */
import { SKIP, visit } from "unist-util-visit";

/** @typedef {any} HastNode  hast nodes are plain objects; the typings are not a dependency. */

const NUMERIC_CELL = /^[-−+]?[\d,]+(?:\.\d+)?\s*(?:円|%|％|GB|MB|ヶ月|か月|ヵ月|L|日|回)?$/;
const GENERATED_PR_NOTE = /^[（(]\s*PR\s*\/\s*rel=sponsored\s*[）)]$/;
const TABLE_LABEL = "表（横にスクロールできます）";

/** @param {HastNode} node @returns {string} */
function textOf(node) {
  if (node.type === "text") return String(node.value);
  return (node.children ?? []).map(textOf).join("");
}

/** @param {HastNode} node @param {...string} names */
function addClass(node, ...names) {
  node.properties ??= {};
  const current = node.properties.className;
  const list = Array.isArray(current) ? current : typeof current === "string" ? current.split(/\s+/) : [];
  node.properties.className = [...new Set([...list, ...names])];
}

/** @param {HastNode} node */
function isElement(node) {
  return node?.type === "element";
}

/** @param {HastNode} node */
function relOf(node) {
  const rel = node.properties?.rel;
  return Array.isArray(rel) ? rel.join(" ") : String(rel ?? "");
}

/** @param {HastNode} node */
function isSponsoredLink(node) {
  return (
    isElement(node) &&
    node.tagName === "a" &&
    (/\bsponsored\b/.test(relOf(node)) || String(node.properties?.href ?? "").startsWith("/go/"))
  );
}

/**
 * Adds rel="sponsored noopener noreferrer" + target="_blank" to affiliate
 * redirect links (/go/...), and rel="noopener" to other external links
 * (docs/06: affiliate links must be sponsored).
 */
export function qualifyOutboundLinks() {
  return (/** @type {HastNode} */ tree) => {
    visit(tree, "element", (/** @type {HastNode} */ node) => {
      if (node.tagName !== "a") return;
      const href = String(node.properties?.href ?? "");
      if (!/^https?:\/\//.test(href) && !href.startsWith("/go/")) return;
      node.properties ??= {};
      if (href.startsWith("/go/") || /\/go\//.test(href)) {
        node.properties.rel = "sponsored noopener noreferrer";
        node.properties.target = "_blank";
      } else {
        node.properties.rel = "noopener";
      }
    });
  };
}

/**
 * The page template already renders the title (<h1>) and the PR disclosure
 * from frontmatter. Generated bodies repeat both on their first lines, which
 * would give the page two <h1>s and a doubled disclosure.
 */
export function dedupeLeadingMeta() {
  return (/** @type {HastNode} */ tree, /** @type {any} */ file) => {
    const frontmatter = file?.data?.astro?.frontmatter ?? {};
    const disclosure = typeof frontmatter.disclosure === "string" ? frontmatter.disclosure.trim() : "";
    const firstElement = () => tree.children.find(isElement);

    let first = firstElement();
    if (disclosure && first?.tagName === "p" && textOf(first).trim() === disclosure) {
      tree.children = tree.children.filter((/** @type {HastNode} */ n) => n !== first);
      first = firstElement();
    }
    if (first?.tagName === "h1") {
      tree.children = tree.children.filter((/** @type {HastNode} */ n) => n !== first);
    }
  };
}

/**
 * A soft line break between two Japanese characters renders as a visible
 * space in HTML ("試算します。 公式料金…"). Generated and hard-wrapped
 * markdown does this constantly, so drop breaks that sit between non-ASCII
 * characters; breaks next to ASCII words stay as the single space they mean.
 */
export function joinCjkLineBreaks() {
  return (/** @type {HastNode} */ tree) => {
    visit(tree, "text", (/** @type {HastNode} */ node, /** @type {number | undefined} */ _index, /** @type {HastNode | undefined} */ parent) => {
      if (parent?.tagName === "pre" || parent?.tagName === "code") return;
      node.value = String(node.value).replace(/(\P{ASCII})\n(?=\P{ASCII})/gu, "$1");
    });
  };
}

/** @param {HastNode} row */
function cellsOf(row) {
  return row.children.filter((/** @type {HastNode} */ n) => isElement(n) && (n.tagName === "td" || n.tagName === "th"));
}

/** @param {HastNode} table @returns {HastNode[]} */
function rowsOf(table) {
  /** @type {HastNode[]} */
  const rows = [];
  visit(table, "element", (/** @type {HastNode} */ node) => {
    if (node.tagName === "tr") rows.push(node);
  });
  return rows;
}

/** @param {HastNode} table */
function classifyColumns(table) {
  const rows = rowsOf(table);
  const bodyRows = rows.filter((row) => cellsOf(row).every((cell) => cell.tagName === "td"));
  const columnCount = Math.max(0, ...rows.map((row) => cellsOf(row).length));

  for (let column = 0; column < columnCount; column += 1) {
    const texts = bodyRows.map((row) => textOf(cellsOf(row)[column] ?? { type: "text", value: "" }).trim());
    const numeric =
      texts.some((text) => NUMERIC_CELL.test(text)) &&
      texts.every((text) => text === "UNKNOWN" || NUMERIC_CELL.test(text));

    for (const row of rows) {
      const cell = cellsOf(row)[column];
      if (!cell) continue;
      if (numeric) addClass(cell, "col-num");
      if (cell.tagName === "td" && textOf(cell).trim() === "UNKNOWN") addClass(cell, "cell-unknown");
    }
  }
}

/**
 * Wraps every table in a focusable, horizontally scrollable region (the
 * accessible pattern for overflowing tables) and tags numeric / UNKNOWN cells
 * so CSS can right-align digits and flag unverified values.
 */
export function enhanceTables() {
  return (/** @type {HastNode} */ tree) => {
    visit(tree, "element", (/** @type {HastNode} */ node, /** @type {number | undefined} */ index, /** @type {HastNode | undefined} */ parent) => {
      if (node.tagName !== "table" || parent === undefined || index === undefined) return;
      if (parent.properties?.className?.includes?.("table-scroll")) return SKIP;
      classifyColumns(node);
      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-scroll"], role: "region", tabIndex: 0, ariaLabel: TABLE_LABEL },
        children: [node],
      };
      return [SKIP, index + 1];
    });
  };
}

/**
 * Turns the generated "<li><a href=/go/..>label</a>（PR / rel=sponsored）</li>"
 * lines into a call-to-action card: a button-styled link, an explicit PR
 * badge and a plain-language note instead of the raw `rel=sponsored` text.
 */
export function markCallToAction() {
  return (/** @type {HastNode} */ tree) => {
    visit(tree, "element", (/** @type {HastNode} */ node, /** @type {number | undefined} */ _index, /** @type {HastNode | undefined} */ parent) => {
      if (node.tagName !== "li") return;
      const link = node.children.find(isSponsoredLink);
      if (!link) return;

      addClass(node, "cta-item");
      addClass(link, "cta-link");
      if (parent && isElement(parent) && parent.tagName === "ul") addClass(parent, "cta-list");

      node.children = node.children.flatMap((/** @type {HastNode} */ child) => {
        if (child.type !== "text" || !GENERATED_PR_NOTE.test(String(child.value).trim())) return [child];
        return [
          { type: "element", tagName: "span", properties: { className: ["pr-badge"] }, children: [{ type: "text", value: "PR" }] },
          {
            type: "element",
            tagName: "span",
            properties: { className: ["cta-note"] },
            children: [{ type: "text", value: "広告（提携リンク）です。新しいタブで開きます。" }],
          },
        ];
      });
    });
  };
}

/** Marks the bullet list under the "出典" heading so it can be set in a quieter style. */
export function markSourceList() {
  return (/** @type {HastNode} */ tree) => {
    visit(tree, "element", (/** @type {HastNode} */ node, /** @type {number | undefined} */ index, /** @type {HastNode | undefined} */ parent) => {
      if (node.tagName !== "h2" || textOf(node).trim() !== "出典" || !parent || index === undefined) return;
      const next = parent.children.slice(index + 1).find(isElement);
      if (next?.tagName === "ul") addClass(next, "source-list");
    });
  };
}

/** Plugin list in the order Astro should apply it (sponsored rel must exist before CTA marking). */
export const articleRehypePlugins = [
  dedupeLeadingMeta,
  joinCjkLineBreaks,
  qualifyOutboundLinks,
  markCallToAction,
  enhanceTables,
  markSourceList,
];
