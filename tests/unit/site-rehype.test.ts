import { describe, expect, it } from "vitest";
import {
  dedupeLeadingMeta,
  enhanceTables,
  joinCjkLineBreaks,
  markCallToAction,
  markSourceList,
  qualifyOutboundLinks,
  type HastNode,
} from "../../apps/site/plugins/rehype-article.mjs";

const DISCLOSURE = "本記事にはプロモーション（PR）を含みます。";

function text(value: string): HastNode {
  return { type: "text", value };
}
function el(tagName: string, properties: Record<string, unknown>, ...children: HastNode[]): HastNode {
  return { type: "element", tagName, properties, children };
}
function root(...children: HastNode[]): HastNode {
  return { type: "root", children };
}
function tags(node: HastNode): string[] {
  return (node.children ?? []).filter((c) => c.type === "element").map((c) => c.tagName ?? "");
}
function classes(node: HastNode | undefined): string[] {
  const value = node?.properties?.className;
  return Array.isArray(value) ? (value as string[]) : [];
}
function find(node: HastNode, tagName: string): HastNode[] {
  const own = node.tagName === tagName ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap((c) => find(c, tagName))];
}

describe("dedupeLeadingMeta", () => {
  const file = { data: { astro: { frontmatter: { disclosure: DISCLOSURE } } } };

  it("drops the repeated disclosure paragraph and leading h1 that the page template already renders", () => {
    const tree = root(
      el("p", {}, text(DISCLOSURE)),
      text("\n"),
      el("h1", {}, text("タイトル")),
      el("p", {}, text("本文")),
    );
    dedupeLeadingMeta()(tree, file);
    expect(tags(tree)).toEqual(["p"]);
    expect(find(tree, "p")[0]?.children?.[0]?.value).toBe("本文");
  });

  it("removes a leading h1 even when the body has no disclosure line", () => {
    const tree = root(el("h1", {}, text("タイトル")), el("h2", {}, text("見出し")));
    dedupeLeadingMeta()(tree, file);
    expect(tags(tree)).toEqual(["h2"]);
  });

  it("keeps a first paragraph that is not the disclosure, and later h1s", () => {
    const tree = root(el("p", {}, text("導入")), el("h1", {}, text("後続のh1")));
    dedupeLeadingMeta()(tree, file);
    expect(tags(tree)).toEqual(["p", "h1"]);
  });

  it("never removes text when frontmatter has no disclosure", () => {
    const tree = root(el("p", {}, text(DISCLOSURE)), el("h1", {}, text("タイトル")));
    dedupeLeadingMeta()(tree, { data: {} });
    expect(tags(tree)).toEqual(["p", "h1"]);
  });
});

describe("joinCjkLineBreaks", () => {
  it("removes a soft line break between Japanese characters but keeps one next to ASCII", () => {
    const joined = el("p", {}, text("比較・試算します。\n公式料金を確認します。"));
    const ascii = el("p", {}, text("全国\nSIM Aと\nSIM B"));
    joinCjkLineBreaks()(root(joined, ascii));
    expect(joined.children?.[0]?.value).toBe("比較・試算します。公式料金を確認します。");
    expect(ascii.children?.[0]?.value).toBe("全国\nSIM Aと\nSIM B");
  });

  it("leaves code blocks untouched", () => {
    const code = el("code", {}, text("あ\nい"));
    joinCjkLineBreaks()(root(el("pre", {}, code)));
    expect(code.children?.[0]?.value).toBe("あ\nい");
  });
});

describe("qualifyOutboundLinks", () => {
  it("marks /go/ links sponsored and other external links noopener only", () => {
    const go = el("a", { href: "/go/offer-1" }, text("申込"));
    const ext = el("a", { href: "https://example.com/price" }, text("公式"));
    const internal = el("a", { href: "/about/" }, text("about"));
    qualifyOutboundLinks()(root(go, ext, internal));
    expect(go.properties).toMatchObject({ rel: "sponsored noopener noreferrer", target: "_blank" });
    expect(ext.properties).toMatchObject({ rel: "noopener" });
    expect(internal.properties?.rel).toBeUndefined();
  });
});

describe("enhanceTables", () => {
  function table(): HastNode {
    return el(
      "table",
      {},
      el("thead", {}, el("tr", {}, el("th", {}, text("プラン")), el("th", {}, text("総額")), el("th", {}, text("対応エリア")))),
      el(
        "tbody",
        {},
        el("tr", {}, el("td", {}, text("A")), el("td", {}, text("63,468円")), el("td", {}, text("全国"))),
        el("tr", {}, el("td", {}, text("B")), el("td", {}, text("UNKNOWN")), el("td", {}, text("UNKNOWN"))),
      ),
    );
  }

  it("wraps tables in a focusable scroll region exactly once", () => {
    const tree = root(table());
    enhanceTables()(tree);
    enhanceTables()(tree);
    const wrapper = tree.children?.[0];
    expect(wrapper?.tagName).toBe("div");
    expect(classes(wrapper)).toEqual(["table-scroll"]);
    expect(wrapper?.properties).toMatchObject({ role: "region", tabIndex: 0 });
    expect(find(tree, "table")).toHaveLength(1);
  });

  it("right-aligns numeric columns (header included) and flags UNKNOWN cells", () => {
    const tree = root(table());
    enhanceTables()(tree);
    const headers = find(tree, "th");
    const cells = find(tree, "td");
    expect(classes(headers[1])).toContain("col-num");
    expect(classes(headers[0])).not.toContain("col-num");
    expect(classes(cells[1])).toContain("col-num");
    expect(classes(cells[2])).not.toContain("col-num");
    expect(classes(cells[3])).not.toContain("cell-unknown");
    expect(classes(cells[4])).toContain("cell-unknown");
    expect(classes(cells[5])).toContain("cell-unknown");
  });
});

describe("markCallToAction", () => {
  function ctaList(): HastNode {
    return el(
      "ul",
      {},
      el(
        "li",
        {},
        el("a", { href: "/go/offer-sim-a", rel: "sponsored noopener noreferrer" }, text("SIM Aの公式サイトを確認する")),
        text("（PR / rel=sponsored）"),
      ),
    );
  }

  it("styles sponsored list items as CTA cards and replaces the raw rel text with a PR badge", () => {
    const tree = root(ctaList());
    markCallToAction()(tree);
    const ul = tree.children?.[0] as HastNode;
    const li = ul.children?.[0] as HastNode;
    expect(classes(ul)).toContain("cta-list");
    expect(classes(li)).toContain("cta-item");
    expect(classes(find(li, "a")[0])).toContain("cta-link");
    const spans = find(li, "span");
    expect(spans.map((s) => classes(s)[0])).toEqual(["pr-badge", "cta-note"]);
    expect(spans[0]?.children?.[0]?.value).toBe("PR");
    expect(JSON.stringify(li)).not.toContain("rel=sponsored");
  });

  it("leaves ordinary lists and unfamiliar notes alone", () => {
    const plain = el("ul", {}, el("li", {}, el("a", { href: "https://example.com", rel: "noopener" }, text("公式"))));
    const odd = el("ul", {}, el("li", {}, el("a", { href: "/go/x", rel: "sponsored" }, text("x")), text("（広告）")));
    const tree = root(plain, odd);
    markCallToAction()(tree);
    expect(classes(plain)).toEqual([]);
    expect(classes(find(odd, "li")[0])).toContain("cta-item");
    expect(JSON.stringify(odd)).toContain("（広告）");
    expect(find(odd, "span")).toHaveLength(0);
  });
});

describe("markSourceList", () => {
  it("tags only the list that directly follows the 出典 heading", () => {
    const before = el("ul", {}, el("li", {}, text("他")));
    const sources = el("ul", {}, el("li", {}, text("公式")));
    const tree = root(before, el("h2", {}, text("出典")), text("\n"), sources);
    markSourceList()(tree);
    expect(classes(sources)).toEqual(["source-list"]);
    expect(classes(before)).toEqual([]);
  });
});
