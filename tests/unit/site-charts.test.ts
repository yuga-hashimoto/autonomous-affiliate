import { describe, expect, it } from "vitest";
import { parseChartBlock, remarkCharts, renderChart, type HastNode } from "../../apps/site/plugins/charts.mjs";

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}
function classes(node: HastNode | undefined): string[] {
  const value = node?.properties?.className;
  return Array.isArray(value) ? (value as string[]) : [];
}
function find(node: HastNode, predicate: (n: HastNode) => boolean): HastNode[] {
  const own = node.type === "element" && predicate(node) ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap((child) => find(child, predicate))];
}
const byTag = (tag: string) => (n: HastNode) => n.tagName === tag;
const byClass = (name: string) => (n: HastNode) => classes(n).includes(name);

function render(spec: unknown): HastNode {
  return renderChart(parseChartBlock(JSON.stringify(spec)));
}

describe("key-figures", () => {
  const figure = render({
    type: "key-figures",
    items: [
      { label: "24ヶ月の総額", value: "119,916円" },
      { label: "最低利用期間", value: "UNKNOWN" },
    ],
  });

  it("renders a figure with a term/definition pair per item", () => {
    expect(figure.tagName).toBe("figure");
    expect(classes(figure)).toEqual(expect.arrayContaining(["chart", "chart-key-figures"]));
    expect(find(figure, byTag("dt")).map(textOf)).toEqual(["24ヶ月の総額", "最低利用期間"]);
    expect(find(figure, byTag("dd")).map(textOf)).toEqual(["119,916円", "UNKNOWN"]);
  });

  it("flags unknown values so they are never styled like a confirmed number", () => {
    const [known, unknown] = find(figure, byTag("dd"));
    expect(classes(known)).not.toContain("figure-unknown");
    expect(classes(unknown)).toContain("figure-unknown");
  });
});

describe("bars", () => {
  const figure = render({
    type: "bars",
    title: "24ヶ月の費用の内訳",
    rows: [
      { label: "水代", detail: "24ヶ月 × 月4,190円", value: 100560 },
      { label: "配送料", detail: "24ヶ月 × 月0円", value: 0 },
      { label: "電気代", value: 16056 },
      { label: "初期費用", value: "UNKNOWN" },
    ],
  });
  const rows = find(figure, byTag("li"));
  const fills = find(figure, byClass("chart-bar-fill"));

  it("titles the figure and lists one row per item with its amount as text", () => {
    expect(textOf(find(figure, byTag("figcaption"))[0]!)).toBe("24ヶ月の費用の内訳");
    expect(rows).toHaveLength(4);
    expect(find(figure, byClass("chart-value")).map(textOf)).toEqual(["100,560円", "0円", "16,056円", "UNKNOWN"]);
    expect(find(figure, byClass("chart-label")).map(textOf)).toEqual(["水代", "配送料", "電気代", "初期費用"]);
    expect(find(figure, byClass("chart-detail")).map(textOf)).toEqual(["24ヶ月 × 月4,190円", "24ヶ月 × 月0円"]);
  });

  it("scales bar widths to the largest amount, so zero is empty and the largest is full", () => {
    expect(fills.map((fill) => fill.properties?.style)).toEqual(["width:100.0%", "width:0.0%", "width:16.0%"]);
  });

  it("gives an unknown row no bar and marks it", () => {
    expect(classes(rows[3])).toContain("row-unknown");
    expect(find(rows[3]!, byClass("chart-bar-fill"))).toHaveLength(0);
  });

  it("hides the decorative bars from assistive technology (the amounts are in the text)", () => {
    for (const track of find(figure, byClass("chart-track"))) expect(track.properties?.ariaHidden).toBe("true");
  });

  it("does not divide by zero when no row has a positive amount", () => {
    const empty = render({ type: "bars", title: "t", rows: [{ label: "a", value: 0 }, { label: "b", value: "UNKNOWN" }] });
    expect(find(empty, byClass("chart-bar-fill")).map((fill) => fill.properties?.style)).toEqual(["width:0.0%"]);
  });
});

describe("term-timeline", () => {
  it("draws the comparison period against the minimum term and explains the gap", () => {
    const figure = render({ type: "term-timeline", title: "比較期間と最低利用期間", comparisonMonths: 24, minimumTermMonths: 60 });
    expect(classes(figure)).toContain("chart-term");
    expect(find(figure, byClass("chart-bar-fill")).map((fill) => fill.properties?.style)).toEqual(["width:40.0%", "width:100.0%"]);
    expect(find(figure, byClass("chart-value")).map(textOf)).toEqual(["24ヶ月", "60ヶ月"]);
    const note = find(figure, byClass("chart-note"));
    expect(note).toHaveLength(1);
    expect(textOf(note[0]!)).toContain("契約解除料");
  });

  it("has no warning note when the comparison period covers the minimum term", () => {
    const figure = render({ type: "term-timeline", title: "t", comparisonMonths: 24, minimumTermMonths: 24 });
    expect(find(figure, byClass("chart-note"))).toHaveLength(0);
    expect(find(figure, byClass("chart-bar-fill")).map((fill) => fill.properties?.style)).toEqual(["width:100.0%", "width:100.0%"]);
  });
});

describe("text safety", () => {
  it("keeps markup in labels as text, never as elements", () => {
    const figure = render({ type: "bars", title: "<img src=x onerror=alert(1)>", rows: [{ label: "<script>x</script>", value: 1 }] });
    expect(find(figure, (n) => n.tagName === "script" || n.tagName === "img")).toHaveLength(0);
    expect(textOf(figure)).toContain("<script>x</script>");
  });
});

describe("parseChartBlock", () => {
  it.each([
    ["not json", "{"],
    ["an unknown type", JSON.stringify({ type: "pie" })],
    ["bars without rows", JSON.stringify({ type: "bars", title: "t", rows: [] })],
    ["a negative amount", JSON.stringify({ type: "bars", title: "t", rows: [{ label: "a", value: -1 }] })],
    ["an amount that is neither a number nor UNKNOWN", JSON.stringify({ type: "bars", title: "t", rows: [{ label: "a", value: "100" }] })],
    ["a non-finite amount", '{"type":"bars","title":"t","rows":[{"label":"a","value":1e999}]}'],
    ["key figures without items", JSON.stringify({ type: "key-figures", items: [] })],
    ["a timeline with fractional months", JSON.stringify({ type: "term-timeline", title: "t", comparisonMonths: 2.5, minimumTermMonths: 60 })],
    ["a timeline with zero months", JSON.stringify({ type: "term-timeline", title: "t", comparisonMonths: 0, minimumTermMonths: 60 })],
  ])("rejects %s with a message naming the chart", (_name, source) => {
    expect(() => parseChartBlock(source)).toThrow(/chart/i);
  });
});

describe("remarkCharts", () => {
  it("replaces ```chart code blocks with a figure and leaves other code untouched", () => {
    const spec = { type: "key-figures", items: [{ label: "総額", value: "1円" }] };
    const other = { type: "code", lang: "ts", value: "const x = 1;" };
    const tree = { type: "root", children: [{ type: "code", lang: "chart", value: JSON.stringify(spec) }, other] };
    remarkCharts()(tree as never);
    const replaced = tree.children[0] as unknown as { data: { hName: string; hProperties: { className: string[] }; hChildren: HastNode[] } };
    expect(replaced.data.hName).toBe("figure");
    expect(replaced.data.hProperties.className).toContain("chart");
    expect(replaced.data.hChildren.length).toBeGreaterThan(0);
    expect(tree.children[1]).toBe(other);
  });

  it("fails the build, naming the chart, when a block is malformed", () => {
    const tree = { type: "root", children: [{ type: "code", lang: "chart", value: "{" }] };
    expect(() => remarkCharts()(tree as never)).toThrow(/chart/i);
  });
});
