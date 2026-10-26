import { describe, expect, it } from "vitest";
import { htmlToVisibleText, selectRelevantWindows } from "@aff/integrations";

describe("htmlToVisibleText", () => {
  it("drops scripts, styles, comments and the head but keeps the title", () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>料金 | サンプル社</title>
      <style>.x{color:red}</style><script>var price = 9999;</script></head>
      <body><!-- hidden 8888円 --><noscript>enable js 7777円</noscript><p>月額 1,100円（税込）</p></body></html>`;
    const text = htmlToVisibleText(html);
    expect(text).toContain("料金 | サンプル社");
    expect(text).toContain("月額 1,100円（税込）");
    expect(text).not.toMatch(/9999|8888|7777|color:red|<|>/);
  });

  it("keeps table cells of one row on one line and separates rows and blocks", () => {
    const html = `<table><tr><th>機種</th><th>月額</th></tr><tr><td>アクア8</td><td>1,100円</td></tr></table><p>配達料 0円</p><ul><li>設置無料</li><li>解約金あり</li></ul>`;
    const lines = htmlToVisibleText(html).split("\n");
    expect(lines).toContain("機種 | 月額");
    expect(lines).toContain("アクア8 | 1,100円");
    expect(lines).toContain("配達料 0円");
    expect(lines).toContain("設置無料");
    expect(lines).toContain("解約金あり");
  });

  it("decodes common named and numeric entities and collapses whitespace", () => {
    const html = "<p>A&amp;B&nbsp;&nbsp;1,000&yen; &#165;2,000 &#x3042;</p>\n\n\n<p>  next   line </p>";
    expect(htmlToVisibleText(html)).toBe("A&B 1,000¥ ¥2,000 あ\nnext line");
  });

  it("passes JSON and plain text through untouched apart from trimming", () => {
    expect(htmlToVisibleText('  {"price": 1000}\n', "application/json")).toBe('{"price": 1000}');
    expect(htmlToVisibleText(" plain <b>text</b> ", "text/plain; charset=utf-8")).toBe("plain <b>text</b>");
  });
});

describe("selectRelevantWindows", () => {
  const noise = Array.from({ length: 400 }, (_, i) => `メニュー項目${i}`).join("\n");

  it("returns the whole text when it already fits one window", () => {
    expect(selectRelevantWindows("月額 1,100円", { windowChars: 100, maxWindows: 3 })).toEqual(["月額 1,100円"]);
    expect(selectRelevantWindows("   ", { windowChars: 100, maxWindows: 3 })).toEqual([]);
  });

  it("picks the window that holds price and contract terms, not the navigation noise", () => {
    const price = "料金一覧\nレギュラー12L 2年割 1,620円（税込）\n送料 0円\n途中解除料 12,980円（税込）\n最低契約期間 2年";
    const text = `${noise}\n${price}\n${noise}`;
    const windows = selectRelevantWindows(text, { windowChars: 400, maxWindows: 1 });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toContain("1,620円");
    expect(windows[0]).toContain("12,980円");
  });

  it("recognises prices written with a leading yen sign (¥ / ￥) and no 円", () => {
    const table = "全機種 | 1年未満 | ¥9,900\n全機種 | 2年未満 | ￥12,980";
    const text = `${noise}\n${table}\n${noise}`;
    const windows = selectRelevantWindows(text, { windowChars: 400, maxWindows: 1 });
    expect(windows[0]).toContain("¥9,900");
    expect(windows[0]).toContain("￥12,980");
  });

  it("returns at most maxWindows windows, each within the size limit, in document order", () => {
    const a = "第一章 料金 1,000円 税込 月額";
    const b = "第二章 料金 2,000円 税込 月額 解約 手数料";
    const text = `${a}\n${noise}\n${b}\n${noise}`;
    const windows = selectRelevantWindows(text, { windowChars: 300, maxWindows: 2 });
    expect(windows.length).toBeLessThanOrEqual(2);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(300);
    const joined = windows.join("\n");
    expect(joined.indexOf("第一章")).toBeLessThan(joined.indexOf("第二章"));
  });

  it("splits a single very long line instead of exceeding the window", () => {
    const longLine = "料金1,000円。".repeat(150);
    const windows = selectRelevantWindows(longLine, { windowChars: 400, maxWindows: 5 });
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(400);
  });

  it("does not spend windows on text without price or contract terms", () => {
    const longLine = `${"あ".repeat(900)}料金1,000円`;
    const windows = selectRelevantWindows(longLine, { windowChars: 400, maxWindows: 5 });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toContain("料金1,000円");
  });

  it("falls back to the first window when nothing looks like a price", () => {
    const text = `${noise}`;
    const windows = selectRelevantWindows(text, { windowChars: 300, maxWindows: 3 });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.startsWith("メニュー項目0")).toBe(true);
  });
});
