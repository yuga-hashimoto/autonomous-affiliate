import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const ARTICLES_DIR = path.join(ROOT, ".tmp/site-articles");
const DIST_DIR = path.join(ROOT, "apps/site/dist");

const ARTICLE = `---
title: "E2E記事: 20GB系プランの24ヶ月総額比較"
description: "公式料金に基づく24ヶ月総額の比較（E2E fixture）。"
pubDate: "2026-10-24T00:00:00.000Z"
disclosure: "本記事にはプロモーション（PR）を含みます。"
offerIds: ["offer-sim-a"]
---

本記事にはプロモーション（PR）を含みます。

# E2E記事: 20GB系プランの24ヶ月総額比較

公式一次情報のみに基づく比較です。実機検証は行っていません。

## 総額比較

| プラン | 総額 | 月平均 |
| --- | --- | --- |
| SIM A 20GB | 63,468円 | 2,645円 |
| SIM B 20GB | 52,320円 | 2,180円 |

## 申し込み

- [SIM A 20GBの公式サイトを確認する](/go/offer-sim-a)（PR / rel=sponsored）

## 出典

- [公式](https://sim-a.example.com/price) — 確認日時: 2026-10-24
`;

/** Enough extra articles to push the archive onto a second page (12 per page). */
const FILLER_COUNT = 13;

function fillerArticle(index: number): string {
  const day = String(index + 1).padStart(2, "0");
  return `---
title: "フィラー記事${index + 1}"
description: "ページ送りの確認用（E2E fixture ${index + 1}）。"
pubDate: "2026-09-${day}T00:00:00.000Z"
disclosure: "本記事にはプロモーション（PR）を含みます。"
offerIds: []
---

本記事にはプロモーション（PR）を含みます。

# フィラー記事${index + 1}

本文です。
`;
}

async function build() {
  await execFileAsync("pnpm", ["--filter", "site", "exec", "astro", "build"], {
    cwd: ROOT,
    env: { ...process.env, ARTICLES_DIR },
  });
}

describe("B011 Astro site (article template, disclosures, sponsored links, build)", () => {
  beforeAll(async () => {
    await rm(ARTICLES_DIR, { recursive: true, force: true });
    await mkdir(ARTICLES_DIR, { recursive: true });
    await writeFile(path.join(ARTICLES_DIR, "e2e-sim.md"), ARTICLE, "utf8");
    for (let i = 0; i < FILLER_COUNT; i += 1) {
      await writeFile(path.join(ARTICLES_DIR, `filler-${i + 1}.md`), fillerArticle(i), "utf8");
    }
    await build();
  }, 180000);

  afterAll(async () => {
    await rm(ARTICLES_DIR, { recursive: true, force: true });
    // Drop the content-layer cache so later builds see the real articles dir.
    await rm(path.join(ROOT, "apps/site/node_modules/.astro"), { recursive: true, force: true });
  });

  it("builds the article page with SEO metadata, disclosure and sponsored links", async () => {
    const html = await readFile(path.join(DIST_DIR, "articles", "e2e-sim", "index.html"), "utf8");
    // mobile viewport
    expect(html).toContain('name="viewport"');
    // SEO metadata + canonical
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('property="og:title"');
    // visible disclosure
    expect(html).toContain("プロモーション（PR）を含みます");
    // affiliate anchor rendered sponsored + safe
    expect(html).toMatch(/rel="sponsored noopener noreferrer"/);
    expect(html).toContain('href="/go/offer-sim-a"');
    // external official source links stay unsponsored but noopener
    expect(html).toMatch(/rel="noopener"/);
    // noindex must not appear on canonical articles
    expect(html).not.toContain('name="robots" content="noindex"');
  });

  it("renders the article with one h1, one disclosure and mobile-friendly components", async () => {
    const html = await readFile(path.join(DIST_DIR, "articles", "e2e-sim", "index.html"), "utf8");
    // the generated body repeats the title and disclosure; the page must show each once
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html.match(/プロモーション（PR）を含みます/g)).toHaveLength(1);
    expect(html).toContain('class="disclosure"');
    // tables scroll inside a focusable region instead of widening the page
    expect(html).toContain('class="table-scroll"');
    expect(html).toMatch(/<div class="table-scroll"[^>]*role="region"[^>]*tabindex="0"/);
    // call-to-action is a card with an explicit PR badge, keeping the sponsored rel
    expect(html).toMatch(/<a [^>]*href="\/go\/offer-sim-a"[^>]*class="cta-link"/);
    expect(html).toContain('<span class="pr-badge">PR</span>');
    expect(html).not.toContain("rel=sponsored");
    // table of contents, structured data and the reading aids
    expect(html).toContain('class="toc-inline"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('width=device-width, initial-scale=1');
  });

  it("paginates the archive at 12 articles per page and links pages together", async () => {
    const first = await readFile(path.join(DIST_DIR, "articles", "index.html"), "utf8");
    const second = await readFile(path.join(DIST_DIR, "articles", "page", "2", "index.html"), "utf8");
    expect(first.match(/class="card-title"/g)).toHaveLength(12);
    expect(first).toContain('href="/articles/page/2/"');
    expect(first).toContain("全14件");
    expect(second.match(/class="card-title"/g)).toHaveLength(FILLER_COUNT + 1 - 12);
    expect(second).toContain('rel="prev"');
    expect(second).toContain('href="/articles/"');
    expect(second).toContain('rel="canonical"');
  });

  it("publishes a compact search index and a noindex 404 page", async () => {
    const index = JSON.parse(await readFile(path.join(DIST_DIR, "search.json"), "utf8")) as {
      id: string;
      title: string;
      pr: boolean;
    }[];
    expect(index).toHaveLength(FILLER_COUNT + 1);
    expect(index[0]).toMatchObject({ id: "e2e-sim", pr: true });
    const notFound = await readFile(path.join(DIST_DIR, "404.html"), "utf8");
    expect(notFound).toContain('name="robots" content="noindex"');
  });

  it("builds privacy and about pages", async () => {
    const privacy = await readFile(path.join(DIST_DIR, "privacy", "index.html"), "utf8");
    const about = await readFile(path.join(DIST_DIR, "about", "index.html"), "utf8");
    const methodology = await readFile(path.join(DIST_DIR, "methodology", "index.html"), "utf8");
    const editorial = await readFile(path.join(DIST_DIR, "editorial-policy", "index.html"), "utf8");
    expect(privacy).toContain("プライバシーポリシー");
    expect(about).toContain("このサイトについて");
    expect(methodology).toContain("比較・試算の方法");
    expect(editorial).toContain("編集・広告掲載方針");
  });

  it("exposes robots.txt that disallows the affiliate redirect path", async () => {
    const robots = await readFile(path.join(DIST_DIR, "robots.txt"), "utf8");
    expect(robots).toContain("Disallow: /go/");
  });

  it("unregistered offers have no redirect endpoint", async () => {
    const goDir = path.join(DIST_DIR, "go");
    const exists = await readFile(path.join(goDir, "offer-sim-a.html"), "utf8").then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });
});
