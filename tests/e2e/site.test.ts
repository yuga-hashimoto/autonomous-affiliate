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

  it("builds privacy and about pages", async () => {
    const privacy = await readFile(path.join(DIST_DIR, "privacy", "index.html"), "utf8");
    const about = await readFile(path.join(DIST_DIR, "about", "index.html"), "utf8");
    expect(privacy).toContain("プライバシーポリシー");
    expect(about).toContain("このサイトについて");
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
