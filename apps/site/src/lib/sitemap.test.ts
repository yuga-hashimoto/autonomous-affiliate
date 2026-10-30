import { describe, expect, it } from "vitest";
import type { ArticleLike } from "./articles";
import { robotsTxt, sitemapUrls, sitemapXml } from "./sitemap";

const SITE = new URL("https://sougakuhikaku.com");

function article(id: string, pubDate: string): ArticleLike {
  return { id, data: { title: id, description: "d", pubDate, offerIds: [] } };
}

describe("sitemapUrls", () => {
  it("lists the site's own pages as absolute canonical URLs", () => {
    const locs = sitemapUrls(SITE, []).map((u) => u.loc);
    expect(locs).toEqual([
      "https://sougakuhikaku.com/",
      "https://sougakuhikaku.com/articles/",
      "https://sougakuhikaku.com/methodology/",
      "https://sougakuhikaku.com/editorial-policy/",
      "https://sougakuhikaku.com/about/",
      "https://sougakuhikaku.com/privacy/",
    ]);
  });

  it("lists every article at its canonical /articles/<id>/ URL, newest first, with the QA date as lastmod", () => {
    const urls = sitemapUrls(SITE, [
      article("old", "2026-10-01T00:00:00.000Z"),
      article("new", "2026-10-24T09:30:00.000Z"),
    ]);
    const articles = urls.filter((u) => u.loc.includes("/articles/") && u.loc !== "https://sougakuhikaku.com/articles/");
    expect(articles).toEqual([
      { loc: "https://sougakuhikaku.com/articles/new/", lastmod: "2026-10-24" },
      { loc: "https://sougakuhikaku.com/articles/old/", lastmod: "2026-10-01" },
    ]);
  });

  it("dates the home page and the archive by the newest article, and leaves other pages undated", () => {
    const urls = sitemapUrls(SITE, [article("a", "2026-10-24T00:00:00.000Z"), article("b", "2026-10-01T00:00:00.000Z")]);
    const lastmodOf = (loc: string) => urls.find((u) => u.loc === loc)?.lastmod;
    expect(lastmodOf("https://sougakuhikaku.com/")).toBe("2026-10-24");
    expect(lastmodOf("https://sougakuhikaku.com/articles/")).toBe("2026-10-24");
    expect(lastmodOf("https://sougakuhikaku.com/about/")).toBeUndefined();
    expect(sitemapUrls(SITE, []).every((u) => u.lastmod === undefined)).toBe(true);
  });

  it("keeps an article whose date cannot be read, without inventing a lastmod", () => {
    const urls = sitemapUrls(SITE, [article("odd", "not a date")]);
    expect(urls.find((u) => u.loc.endsWith("/articles/odd/"))).toEqual({ loc: "https://sougakuhikaku.com/articles/odd/" });
    expect(urls.find((u) => u.loc === "https://sougakuhikaku.com/")?.lastmod).toBeUndefined();
  });

  it("never lists redirect, search-index or error pages", () => {
    const locs = sitemapUrls(SITE, [article("a", "2026-10-24T00:00:00.000Z")]).map((u) => u.loc);
    for (const loc of locs) {
      expect(loc).not.toContain("/go/");
      expect(loc).not.toContain("search.json");
      expect(loc).not.toContain("404");
    }
  });

  it("has no duplicate URLs", () => {
    const locs = sitemapUrls(SITE, [article("a", "2026-10-24T00:00:00.000Z"), article("a", "2026-10-25T00:00:00.000Z")]).map(
      (u) => u.loc,
    );
    expect(new Set(locs).size).toBe(locs.length);
  });
});

describe("sitemapXml", () => {
  it("writes a sitemap-protocol urlset with one <url> per entry", () => {
    const xml = sitemapXml([
      { loc: "https://sougakuhikaku.com/", lastmod: "2026-10-24" },
      { loc: "https://sougakuhikaku.com/about/" },
    ]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
    expect(xml.match(/<url>/g)).toHaveLength(2);
    expect(xml).toContain("<url><loc>https://sougakuhikaku.com/</loc><lastmod>2026-10-24</lastmod></url>");
    expect(xml).toContain("<url><loc>https://sougakuhikaku.com/about/</loc></url>");
  });

  it("escapes characters that would break the XML", () => {
    const xml = sitemapXml([{ loc: `https://sougakuhikaku.com/a?x=1&y=<2>"'` }]);
    expect(xml).toContain("<loc>https://sougakuhikaku.com/a?x=1&amp;y=&lt;2&gt;&quot;&apos;</loc>");
    expect(xml).not.toContain("y=<2>");
  });
});

describe("robotsTxt", () => {
  it("keeps the redirect path closed and points crawlers at the sitemap on this site", () => {
    const text = robotsTxt(SITE);
    expect(text).toContain("User-agent: *\nAllow: /\nDisallow: /go/");
    expect(text).toContain("Sitemap: https://sougakuhikaku.com/sitemap.xml");
    expect(text.endsWith("\n")).toBe(true);
  });
});
