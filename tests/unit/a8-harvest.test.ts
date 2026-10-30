import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import {
  READ_LINK_PAGE,
  decideHarvest,
  extractTrackingUrl,
  isBannerCode,
  pickTrackingUrl,
  type LinkPageRead,
} from "../../apps/worker/src/a8-harvest.js";

const MAT = "3ABCDE+1FGHIJ+2KLMNO+PQRST";
const TEXT_AD = `<a href="https://px.a8.net/svt/ejp?a8mat=${MAT}" rel="nofollow">公式サイト</a><img border="0" width="1" height="1" src="https://www16.a8.net/0.gif?a8mat=${MAT}" alt="">`;
const BANNER_AD = `<a href="https://px.a8.net/svt/ejp?a8mat=3BANNER+AAAAA+BBBBB+CCCCC" rel="nofollow"><img border="0" width="300" height="250" alt="" src="https://www24.a8.net/svt/bgt?aid=1&wid=2&eno=01&mid=s00000000000001&mc=1"></a><img border="0" width="1" height="1" src="https://www10.a8.net/0.gif?a8mat=3BANNER+AAAAA+BBBBB+CCCCC" alt="">`;

describe("extractTrackingUrl", () => {
  it("takes the A8 tracking URL out of an ad code and keeps nothing else", () => {
    expect(extractTrackingUrl(TEXT_AD)).toBe(`https://px.a8.net/svt/ejp?a8mat=${MAT}`);
  });

  it("works on a bare URL, as the SNS tab shows it", () => {
    expect(extractTrackingUrl(`https://px.a8.net/svt/ejp?a8mat=${MAT}`)).toBe(`https://px.a8.net/svt/ejp?a8mat=${MAT}`);
  });

  it("drops other parameters and reads an HTML-escaped query", () => {
    expect(extractTrackingUrl(`<a href="https://px.a8.net/svt/ejp?a8mat=${MAT}&amp;a8ejpredirect=https%3A%2F%2Fexample.test%2F">x</a>`)).toBe(
      `https://px.a8.net/svt/ejp?a8mat=${MAT}`,
    );
  });

  it("returns the first link when there are several", () => {
    expect(extractTrackingUrl(`${TEXT_AD} ${BANNER_AD}`)).toBe(`https://px.a8.net/svt/ejp?a8mat=${MAT}`);
  });

  it.each([
    ["another host", `<a href="https://px.a8.net.example.test/svt/ejp?a8mat=${MAT}">x</a>`],
    ["a plain-http link", `<a href="http://px.a8.net/svt/ejp?a8mat=${MAT}">x</a>`],
    ["another path", `<a href="https://px.a8.net/svt/other?a8mat=${MAT}">x</a>`],
    ["a link with credentials", `<a href="https://user@px.a8.net/svt/ejp?a8mat=${MAT}">x</a>`],
    ["a tracking URL carried inside someone else's link", `<a href="https://example.test/?u=https://px.a8.net/svt/ejp?a8mat=${MAT}">x</a>`],
    ["a missing a8mat", `<a href="https://px.a8.net/svt/ejp?foo=bar">x</a>`],
    ["an a8mat with markup characters", `<a href="https://px.a8.net/svt/ejp?a8mat=<script>">x</a>`],
    ["an a8mat that is too short to be real", `<a href="https://px.a8.net/svt/ejp?a8mat=abc">x</a>`],
    ["no link at all", "<p>広告コードがありません</p>"],
    ["an empty code", ""],
  ])("refuses %s", (_label, code) => {
    expect(extractTrackingUrl(code)).toBeUndefined();
  });
});

describe("isBannerCode / pickTrackingUrl", () => {
  it("tells a banner (a visible image) from a text ad (only the 1x1 counter image)", () => {
    expect(isBannerCode(TEXT_AD)).toBe(false);
    expect(isBannerCode(BANNER_AD)).toBe(true);
    expect(isBannerCode(`https://px.a8.net/svt/ejp?a8mat=${MAT}`)).toBe(false);
  });

  it("prefers a text ad even when a banner comes first, because the article never shows the advertiser's images", () => {
    expect(pickTrackingUrl([BANNER_AD, TEXT_AD])).toBe(`https://px.a8.net/svt/ejp?a8mat=${MAT}`);
  });

  it("falls back to a banner's link when the program has only banners", () => {
    expect(pickTrackingUrl([BANNER_AD])).toBe("https://px.a8.net/svt/ejp?a8mat=3BANNER+AAAAA+BBBBB+CCCCC");
  });

  it("skips codes without a usable link and is undefined when none has one", () => {
    expect(pickTrackingUrl(["", "<p>x</p>", TEXT_AD])).toBe(`https://px.a8.net/svt/ejp?a8mat=${MAT}`);
    expect(pickTrackingUrl(["", "<p>x</p>"])).toBeUndefined();
    expect(pickTrackingUrl([])).toBeUndefined();
  });
});

const sites = (...entries: [string, string, boolean][]) => entries.map(([value, text, selected]) => ({ value, text, selected }));

describe("decideHarvest", () => {
  const read = (overrides: Partial<LinkPageRead> = {}): LinkPageRead => ({
    sites: sites(["1", "別のサイト", false], ["2", "総額比較", true]),
    adCodes: [TEXT_AD],
    ...overrides,
  });

  it("returns the link when the target site is the one selected", () => {
    expect(decideHarvest(read(), "総額比較")).toEqual({ ok: true, url: `https://px.a8.net/svt/ejp?a8mat=${MAT}` });
  });

  it("refuses links made for another site: the a8mat code belongs to the site chosen on the page", () => {
    expect(decideHarvest(read({ sites: sites(["1", "別のサイト", true], ["2", "総額比較", false]) }), "総額比較")).toEqual({
      ok: false,
      reason: "site_not_selected",
    });
  });

  it("refuses when the target site is not offered, or is ambiguous", () => {
    expect(decideHarvest(read({ sites: sites(["1", "別のサイト", true]) }), "総額比較")).toEqual({ ok: false, reason: "site_missing" });
    expect(decideHarvest(read({ sites: sites(["1", "総額比較A", true], ["2", "総額比較B", false]) }), "総額比較")).toEqual({
      ok: false,
      reason: "site_ambiguous",
    });
    expect(decideHarvest(read({ sites: [] }), "総額比較")).toEqual({ ok: false, reason: "site_missing" });
  });

  it("refuses an empty target name instead of matching every site", () => {
    expect(decideHarvest(read(), "  ")).toEqual({ ok: false, reason: "site_missing" });
  });

  it("reports a page without a usable link", () => {
    expect(decideHarvest(read({ adCodes: ["<p>x</p>"] }), "総額比較")).toEqual({ ok: false, reason: "no_link_found" });
  });
});

// Needs a local Chromium (`playwright install chromium`); without one these tests are skipped.
const browser = await chromium.launch({ headless: true }).catch(() => undefined);
afterAll(async () => {
  await browser?.close();
});

/** A page like the console's ad-link page: the site selector, then one box per material with its code in textareas. */
const LINK_PAGE = (adCodes: string[], selectedSite: string) => `<!doctype html><body><main>
<form name="asLinkForm" method="get" action="/program/create-link">
  <input type="hidden" name="programId" value="s00000000000001">
  <select name="websiteId">
    <option value="111" ${selectedSite === "111" ? "selected" : ""}>別のサイト</option>
    <option value="222" ${selectedSite === "222" ? "selected" : ""}>総額比較</option>
  </select>
  <button type="submit">広告リンクを表示</button>
</form>
<div id="boxes"></div></main>
<script>
const codes = ${JSON.stringify(adCodes)};
setTimeout(() => {
  document.getElementById("boxes").innerHTML = codes.map((c) => '<div class="box"><textarea></textarea></div>').join("");
  document.querySelectorAll("textarea").forEach((area, i) => { area.value = codes[i]; });
}, 400);
</script></body>`;

async function serve(html: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

describe.skipIf(!browser)("READ_LINK_PAGE", () => {
  it("reads the site selector and the ad codes once the boxes have been drawn", async () => {
    const site = await serve(LINK_PAGE([BANNER_AD, TEXT_AD], "222"));
    const page = await browser!.newPage();
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("textarea");
      const read = (await page.evaluate(READ_LINK_PAGE)) as LinkPageRead;
      expect(read.sites).toEqual([
        { value: "111", text: "別のサイト", selected: false },
        { value: "222", text: "総額比較", selected: true },
      ]);
      expect(read.adCodes).toHaveLength(2);
      expect(decideHarvest(read, "総額比較")).toEqual({ ok: true, url: `https://px.a8.net/svt/ejp?a8mat=${MAT}` });
    } finally {
      await page.close();
      site.close();
    }
  }, 60_000);

  it("shows that the wrong site is selected, so no link is taken from it", async () => {
    const site = await serve(LINK_PAGE([TEXT_AD], "111"));
    const page = await browser!.newPage();
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("textarea");
      const read = (await page.evaluate(READ_LINK_PAGE)) as LinkPageRead;
      expect(decideHarvest(read, "総額比較")).toEqual({ ok: false, reason: "site_not_selected" });
    } finally {
      await page.close();
      site.close();
    }
  }, 60_000);
});
