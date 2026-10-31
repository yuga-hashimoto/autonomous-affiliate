import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { parsePolicyText, type PolicyConfig } from "@aff/domain";
import { MapFetcher } from "@aff/integrations";
import { termsFingerprint, vetAdvertiserSite, type ListRequest, type PlanLister } from "@aff/agents";
import { readFileSync } from "./helpers.js";

const HOST = "brand-a.com";
const ORIGIN = `https://${HOST}`;
const T0 = new Date("2026-10-30T00:00:00.000Z");
const candidate = { name: "ブランドA", host: HOST, brandSlug: "brand-a" };

const basePolicy = parsePolicyText(readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"));
const policy: PolicyConfig = { ...basePolicy, security: { ...basePolicy.security, allowed_source_domains: ["other.example.org"] } };

const page = (lines: string[], links = ""): string =>
  `<html><head><title>ブランドA</title></head><body>${lines.map((l) => `<p>${l}</p>`).join("")}${links}</body></html>`;

const FILLER = "お水の宅配サービスのご案内です。".repeat(20);
const TOP_LINKS = `<a href="/terms/">ご利用規約</a><a href="/affiliate/">アフィリエイトについて</a><a href="/price/">料金プラン</a><a href="/privacy/">プライバシーポリシー</a>`;
const SERVER_LINES = [
  "ミニサーバー", "月額 3,000円", "詳しく見る", "ミニサーバー", "ミニサーバー（ホワイト）", "水代 月額 2,000円", "ミニサーバー",
];

function site(overrides: Record<string, string | undefined> = {}) {
  const pages: Record<string, string | undefined> = {
    [`${ORIGIN}/`]: page(["ブランドAへようこそ", FILLER], TOP_LINKS),
    [`${ORIGIN}/terms/`]: page(["第1条 本サイトの利用条件を定めます。", "第三者の権利を侵害する行為を禁止します。"]),
    [`${ORIGIN}/affiliate/`]: page(["アフィリエイトの提携者向けの規約です。", "比較サイトでの掲載は可能です。"]),
    [`${ORIGIN}/price/`]: page(SERVER_LINES),
    ...overrides,
  };
  const map = new Map<string, { body: string }>();
  for (const [url, body] of Object.entries(pages)) {
    if (body === undefined) continue;
    map.set(url, { body });
    // The source collector asks for the canonical address, which has no trailing slash.
    if (!url.endsWith("//") && /[^/]\/$/.test(url) && new URL(url).pathname !== "/") map.set(url.replace(/\/$/, ""), { body });
  }
  return new MapFetcher(map);
}

class FakeLister implements PlanLister {
  constructor(private readonly names: string[]) {}
  async list(_request: ListRequest): Promise<string[]> {
    return this.names;
  }
}

const deps = (fetcher: MapFetcher, lister: PlanLister | null = new FakeLister(["ミニサーバー"])) => ({
  fetcher,
  lister: lister ?? undefined,
  repo: createMemoryRepository(),
  policy,
  clock: () => T0,
});

describe("vetAdvertiserSite", () => {
  it("accepts a site whose rules allow it and whose price page lists servers", async () => {
    const result = await vetAdvertiserSite(candidate, deps(site()));
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      brandName: "ブランドA",
      termsUrl: `${ORIGIN}/affiliate/`,
      listUrls: [`${ORIGIN}/price/`],
      services: 1,
    });
    if (result.ok) {
      const text = "ブランドA\nアフィリエイトの提携者向けの規約です。\n比較サイトでの掲載は可能です。";
      expect(result.termsSha256).toBe(termsFingerprint(text));
    }
  });

  it("falls back to the terms of use when the site has no page for partners", async () => {
    const links = `<a href="/terms/">ご利用規約</a><a href="/price/">料金プラン</a>`;
    const result = await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: page(["ブランドA", FILLER], links) })));
    expect(result).toMatchObject({ ok: true, termsUrl: `${ORIGIN}/terms/` });
  });

  it("rejects a site that cannot be reached", async () => {
    const result = await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: undefined })));
    expect(result).toEqual({ ok: false, reasons: ["site_unreachable"] });
  });

  it("rejects a site whose robots.txt keeps everything out", async () => {
    const result = await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/robots.txt`]: "User-agent: *\nDisallow: /" })));
    expect(result).toEqual({ ok: false, reasons: ["robots_disallow"] });
  });

  it("finds the company by the distinctive part of the console's name, not by what it sells", async () => {
    const named = { ...candidate, name: "【新規設置】ブランドA・ウォーターサーバー" };
    expect(await vetAdvertiserSite(named, deps(site()))).toMatchObject({ ok: true, brandName: "ブランドA" });
    const generic = { ...candidate, name: "ウォーターサーバー宅配水" };
    expect(await vetAdvertiserSite(generic, deps(site()))).toEqual({ ok: false, reasons: ["name_not_on_site"] });
  });

  it("does not judge a front page with almost no text, and treats unreadable rules pages as not now", async () => {
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: page(["ブランドA"], TOP_LINKS) })))).toEqual({
      ok: false,
      reasons: ["site_unreachable"],
    });
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/terms/`]: undefined })))).toEqual({ ok: false, reasons: ["site_unreachable"] });
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/affiliate/`]: undefined })))).toEqual({ ok: false, reasons: ["site_unreachable"] });
  });

  it("needs a price page that shows prices and is read like every other page", async () => {
    const noPrices = page(["ミニサーバー", "詳しく見る", "ミニサーバー", "ミニサーバー"]);
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/price/`]: noPrices })))).toEqual({ ok: false, reasons: ["no_price_page"] });
    const robots = "User-agent: *\nDisallow: /price";
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/robots.txt`]: robots })))).toEqual({ ok: false, reasons: ["no_price_page"] });
  });

  it("rejects a site that does not show the advertiser's name", async () => {
    const result = await vetAdvertiserSite({ ...candidate, name: "別の会社" }, deps(site()));
    expect(result).toEqual({ ok: false, reasons: ["name_not_on_site"] });
  });

  it("rejects a site with no terms of use, because unknown is a no", async () => {
    const links = `<a href="/price/">料金プラン</a>`;
    const result = await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: page(["ブランドA", FILLER], links) })));
    expect(result).toEqual({ ok: false, reasons: ["terms_not_found"] });
  });

  it("rejects a site whose terms forbid collecting it by program", async () => {
    const terms = page(["本サイトの情報をスクレイピング等により収集することを禁止します。"]);
    const result = await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/terms/`]: terms })));
    expect(result).toEqual({ ok: false, reasons: ["terms_ban_automation"] });
  });

  it("rejects a partner page that forbids price statements", async () => {
    const rules = page(["価格・料金の掲載はできません。"]);
    const result = await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/affiliate/`]: rules })));
    expect(result).toEqual({ ok: false, reasons: ["restricted_price"] });
  });

  it("rejects a site whose price pages list no servers", async () => {
    const result = await vetAdvertiserSite(candidate, deps(site(), new FakeLister([])));
    expect(result).toEqual({ ok: false, reasons: ["no_services"] });
  });

  it("cannot check the price page without the model that reads it", async () => {
    const result = await vetAdvertiserSite(candidate, deps(site(), null));
    expect(result).toEqual({ ok: false, reasons: ["no_lister"] });
  });

  it("never follows a link to another site", async () => {
    const links = `<a href="https://evil.example.net/terms/">ご利用規約</a><a href="https://evil.example.net/price/">料金プラン</a>`;
    const fetcher = site({ [`${ORIGIN}/`]: page(["ブランドA", FILLER], links), "https://evil.example.net/terms/": page(["利用条件"]) });
    expect(await vetAdvertiserSite(candidate, deps(fetcher))).toEqual({ ok: false, reasons: ["terms_not_found"] });
  });

  it("rejects a site that sends visitors to another site", async () => {
    const redirecting = {
      async fetch(url: string) {
        return { status: 200, body: page(["ブランドA", FILLER], TOP_LINKS), contentType: "text/html", finalUrl: url.replace(HOST, "elsewhere.example.net") };
      },
    };
    const result = await vetAdvertiserSite(candidate, { ...deps(site()), fetcher: redirecting });
    expect(result).toEqual({ ok: false, reasons: ["site_unreachable"] });
  });
});
