import { describe, expect, it } from "vitest";
import {
  ARTICLES_PER_PAGE,
  formatDate,
  heroImageOf,
  isoDate,
  pageWindow,
  paginate,
  readingMinutes,
  relatedArticles,
  sortByNewest,
  type ArticleLike,
} from "./articles";

function article(id: string, pubDate: string, offerIds: string[] = []): ArticleLike {
  return { id, data: { title: id, description: `${id} desc`, pubDate, offerIds } };
}

describe("sortByNewest", () => {
  it("orders by pubDate descending without mutating the input", () => {
    const input = [
      article("a", "2026-10-01T00:00:00.000Z"),
      article("b", "2026-10-03T00:00:00.000Z"),
      article("c", "2026-10-02T00:00:00.000Z"),
    ];
    expect(sortByNewest(input).map((a) => a.id)).toEqual(["b", "c", "a"]);
    expect(input.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("is stable for equal dates and pushes unparseable dates last", () => {
    const input = [
      article("x", "not-a-date"),
      article("a", "2026-10-01T00:00:00.000Z"),
      article("b", "2026-10-01T00:00:00.000Z"),
    ];
    expect(sortByNewest(input).map((a) => a.id)).toEqual(["a", "b", "x"]);
  });
});

describe("date helpers", () => {
  it("formats ISO timestamps as Japanese dates without zero padding", () => {
    expect(formatDate("2026-10-06T12:37:10.817Z")).toBe("2026年10月6日");
    expect(isoDate("2026-10-06T12:37:10.817Z")).toBe("2026-10-06");
  });

  it("falls back to the raw prefix for malformed input", () => {
    expect(formatDate("soon")).toBe("soon");
    expect(isoDate("soon")).toBe("soon");
  });
});

describe("readingMinutes", () => {
  it("never reports less than one minute", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes("短い本文")).toBe(1);
  });

  it("scales with visible characters and ignores markdown syntax and whitespace", () => {
    const body = `${"あ".repeat(1200)}\n\n| a | b |\n| --- | --- |\n`;
    expect(readingMinutes(body)).toBe(3);
  });

  it("does not count the data inside chart blocks", () => {
    const chart = `\`\`\`chart\n{"type":"bars","title":"${"内訳".repeat(800)}","rows":[]}\n\`\`\``;
    expect(readingMinutes(`${"あ".repeat(400)}\n\n${chart}\n`)).toBe(readingMinutes("あ".repeat(400)));
  });
});

describe("relatedArticles", () => {
  const current = article("cur", "2026-10-10T00:00:00.000Z", ["offer-1"]);
  const all = [
    current,
    article("same-old", "2026-10-01T00:00:00.000Z", ["offer-1"]),
    article("same-new", "2026-10-09T00:00:00.000Z", ["offer-1", "offer-2"]),
    article("other-new", "2026-10-08T00:00:00.000Z", ["offer-9"]),
    article("other-old", "2026-09-01T00:00:00.000Z"),
  ];

  it("prefers articles sharing an offer, then fills with the newest others, never the current one", () => {
    const ids = relatedArticles(current, all, 3).map((a) => a.id);
    expect(ids).toEqual(["same-new", "same-old", "other-new"]);
    expect(ids).not.toContain("cur");
  });

  it("returns fewer items when the site has few articles", () => {
    expect(relatedArticles(current, [current], 3)).toEqual([]);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 30 }, (_, i) => i + 1);

  it("slices a page and reports totals", () => {
    const page2 = paginate(items, 2, 12);
    expect(page2.items).toEqual(items.slice(12, 24));
    expect(page2.totalPages).toBe(3);
    expect(page2.totalCount).toBe(30);
  });

  it("always has at least one page, even when empty", () => {
    expect(paginate([], 1, ARTICLES_PER_PAGE)).toMatchObject({ items: [], totalPages: 1, totalCount: 0 });
  });
});

describe("pageWindow", () => {
  it("shows every page for short ranges", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("collapses long gaps into an ellipsis but keeps first, last and neighbours", () => {
    expect(pageWindow(1, 10)).toEqual([1, 2, "…", 10]);
    expect(pageWindow(5, 10)).toEqual([1, "…", 4, 5, 6, "…", 10]);
    expect(pageWindow(10, 10)).toEqual([1, "…", 9, 10]);
  });

  it("prints a lone missing page instead of an ellipsis", () => {
    expect(pageWindow(4, 10)).toEqual([1, 2, 3, 4, 5, "…", 10]);
  });
});

describe("heroImageOf", () => {
  const valid = {
    heroImage: "/images/articles/premium-water-famfit2-24month/hero.webp",
    heroImageAlt: "ウォーターサーバーのイメージ（AI生成）",
    heroImageWidth: 1280,
    heroImageHeight: 720,
  };

  it("returns the image only when every field is present and valid", () => {
    expect(heroImageOf(valid)).toEqual({
      src: valid.heroImage,
      alt: valid.heroImageAlt,
      width: 1280,
      height: 720,
    });
    expect(heroImageOf({})).toBeUndefined();
    expect(heroImageOf({ ...valid, heroImageAlt: undefined })).toBeUndefined();
    expect(heroImageOf({ ...valid, heroImageAlt: "  " })).toBeUndefined();
    expect(heroImageOf({ ...valid, heroImageWidth: undefined })).toBeUndefined();
    expect(heroImageOf({ ...valid, heroImageHeight: 0 })).toBeUndefined();
    expect(heroImageOf({ ...valid, heroImageWidth: 12.5 })).toBeUndefined();
  });

  it.each([
    "https://evil.example.com/hero.webp",
    "//evil.example.com/hero.webp",
    "/images/articles/../../secret/hero.webp",
    "/images/articles/a/hero.svg",
    "/images/articles/a/other.webp",
    "/images/other/a/hero.webp",
    "javascript:alert(1)",
  ])("never links an image from %s", (heroImage) => {
    expect(heroImageOf({ ...valid, heroImage })).toBeUndefined();
  });
});
