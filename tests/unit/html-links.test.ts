import { describe, expect, it } from "vitest";
import { linksOfHtml } from "@aff/integrations";

const BASE = "https://www.example.com/shop/";

describe("linksOfHtml", () => {
  it("resolves links against the page and reads their text", () => {
    const html = `<a href="/terms/">ご利用規約</a><a href="price.html"> 料金 <span>表</span> </a>`;
    expect(linksOfHtml(html, BASE)).toEqual([
      { url: "https://www.example.com/terms/", text: "ご利用規約" },
      { url: "https://www.example.com/shop/price.html", text: "料金 表" },
    ]);
  });

  it("decodes entities in the address and drops the fragment", () => {
    const html = `<a href='/p?a=1&amp;b=2#top'>P</a>`;
    expect(linksOfHtml(html, BASE)).toEqual([{ url: "https://www.example.com/p?a=1&b=2", text: "P" }]);
  });

  it("keeps http and https only", () => {
    const html = `<a href="mailto:a@example.com">m</a><a href="javascript:void(0)">j</a><a href="tel:0120">t</a><a href="#x">x</a><a href="http://a.example.com/">h</a>`;
    expect(linksOfHtml(html, BASE).map((link) => link.url)).toEqual(["http://a.example.com/"]);
  });

  it("uses the alt text of an image that is the whole link", () => {
    const html = `<a href="/terms"><img src="t.png" alt="利用規約"></a>`;
    expect(linksOfHtml(html, BASE)).toEqual([{ url: "https://www.example.com/terms", text: "利用規約" }]);
  });

  it("lists a link once and stops at a limit", () => {
    const html = `<a href="/a">A</a><a href="/a">A</a>` + Array.from({ length: 700 }, (_, i) => `<a href="/p${i}">p</a>`).join("");
    const links = linksOfHtml(html, BASE);
    expect(links.filter((link) => link.url.endsWith("/a"))).toHaveLength(1);
    expect(links.length).toBeLessThanOrEqual(500);
  });

  it("ignores an anchor with no address", () => {
    expect(linksOfHtml(`<a name="x">x</a><a href="">e</a>`, BASE)).toEqual([]);
  });
});

describe("linksOfHtml on hostile input", () => {
  it("reads many unclosed anchors in time proportional to the page", () => {
    // The best of a few runs, so that a slow moment of a shared machine does not count.
    const timeOf = (anchors: number): number => {
      const html = "<a href=x>".repeat(anchors);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        linksOfHtml(html, BASE);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const small = timeOf(10_000);
    const large = timeOf(40_000);
    // Four times the page takes about four times as long; a scan that restarts from each anchor takes about sixteen.
    expect(large).toBeLessThan(small * 10 + 50);
  });

  it("takes the text of an anchor that is closed, and stops an unclosed one at the next anchor", () => {
    const html = `<a href="/a">A</a> <a href="/b">B <a href="/c">C</a>`;
    expect(linksOfHtml(html, BASE).map((link) => [link.url.slice(-2), link.text])).toEqual([["/a", "A"], ["/b", "B"], ["/c", "C"]]);
  });

  it("does not take a tag that merely starts with a", () => {
    expect(linksOfHtml(`<abbr href="/x">x</abbr><area href="/y">`, BASE)).toEqual([]);
  });
});
