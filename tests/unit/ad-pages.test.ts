import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { A8Brand } from "@aff/agents";
import { adPagesFromHtml, collectAdPages } from "../../apps/worker/src/ad-pages.js";

const brand = (slug: string): A8Brand => ({
  brandSlug: slug,
  keyword: "ブランド",
  verticalId: "water_delivery",
  termsUrl: "https://brand.example.com/affiliate/",
  termsSha256: "a".repeat(64),
  trademarkTerms: [],
});

const page = (canonical: string | undefined, links: string[]): string =>
  `<!doctype html><html><head>${canonical ? `<link rel="canonical" href="${canonical}">` : ""}</head><body>
  ${links.map((offerId) => `<a href="/go/${offerId}" rel="sponsored noopener noreferrer">公式サイトを確認する</a>`).join("\n")}
  <a href="/articles/other/">内部リンク</a></body></html>`;

describe("adPagesFromHtml", () => {
  it("returns the page's canonical URL with the offers it links to", () => {
    expect(adPagesFromHtml(page("https://site.example.com/articles/a/", ["offer-brand-a-x", "offer-brand-a-y"]))).toEqual({
      url: "https://site.example.com/articles/a/",
      offerIds: ["offer-brand-a-x", "offer-brand-a-y"],
    });
  });

  it("has no ad page when nothing links to /go/", () => {
    expect(adPagesFromHtml(page("https://site.example.com/articles/a/", []))).toBeUndefined();
  });

  it("does not guess a URL for a page without a canonical, or with one that is not https", () => {
    expect(adPagesFromHtml(page(undefined, ["offer-brand-a-x"]))).toBeUndefined();
    expect(adPagesFromHtml(page("http://site.example.com/articles/a/", ["offer-brand-a-x"]))).toBeUndefined();
    expect(adPagesFromHtml(page("javascript:alert(1)", ["offer-brand-a-x"]))).toBeUndefined();
  });

  it("ignores /go/ links whose id is not a plain offer id", () => {
    expect(adPagesFromHtml(page("https://site.example.com/articles/a/", ["../x", "offer a"]))).toBeUndefined();
  });
});

describe("collectAdPages", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function dist(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ad-pages-"));
    dirs.push(dir);
    for (const [name, html] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), html, "utf8");
    }
    return dir;
  }

  it("groups the pages by the brand of the offers they link to, sorted and once each", async () => {
    const dir = await dist({
      "articles/b/index.html": page("https://site.example.com/articles/b/", ["offer-brand-a-x"]),
      "articles/a/index.html": page("https://site.example.com/articles/a/", ["offer-brand-a-y", "offer-brand-a-x"]),
      "articles/c/index.html": page("https://site.example.com/articles/c/", ["offer-brand-z-q"]),
      "articles/none/index.html": page("https://site.example.com/articles/none/", []),
      "index.html": page("https://site.example.com/", ["offer-brand-a-x"]),
    });
    const found = await collectAdPages(dir, [brand("brand-a"), brand("brand-z")]);
    expect(found).toEqual({
      "brand-a": ["https://site.example.com/articles/a/", "https://site.example.com/articles/b/"],
      "brand-z": ["https://site.example.com/articles/c/"],
    });
  });

  it("only looks at article pages, since the ad is placed in articles", async () => {
    const dir = await dist({ "index.html": page("https://site.example.com/", ["offer-brand-a-x"]) });
    expect(await collectAdPages(dir, [brand("brand-a")])).toEqual({});
  });

  it("returns nothing for a missing build or an offer of no known brand", async () => {
    expect(await collectAdPages(path.join(os.tmpdir(), "no-such-dist-dir"), [brand("brand-a")])).toEqual({});
    const dir = await dist({ "articles/a/index.html": page("https://site.example.com/articles/a/", ["offer-else-x"]) });
    expect(await collectAdPages(dir, [brand("brand-a")])).toEqual({});
  });
});
