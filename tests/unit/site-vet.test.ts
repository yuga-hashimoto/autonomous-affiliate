import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { parsePolicyText, type PolicyConfig } from "@aff/domain";
import { FetchError, MapFetcher } from "@aff/integrations";
import { identityText, isTransientReason, refreshSourcePages, selfNames, termsFingerprint, trialRegistered, vetAdvertiserSite, type ListRequest, type PlanLister } from "@aff/agents";
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
    expect(result).toEqual({ ok: false, reasons: ["site_unreachable", "unreachable_top_http404"] });
  });

  it("rejects a site whose robots.txt keeps everything out", async () => {
    const result = await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/robots.txt`]: "User-agent: *\nDisallow: /" })));
    expect(result).toEqual({ ok: false, reasons: ["robots_disallow"] });
  });

  it("finds the company by the distinctive part of the console's name, not by what it sells", async () => {
    const named = { ...candidate, name: "【新規設置】ブランドA・ウォーターサーバー" };
    expect(await vetAdvertiserSite(named, deps(site()))).toMatchObject({ ok: true, brandName: "ブランドA" });
    const generic = { ...candidate, name: "ウォーターサーバー宅配水" };
    expect(await vetAdvertiserSite(generic, deps(site()))).toMatchObject({ ok: false, reasons: ["name_not_on_site", expect.any(String)] });
  });

  it("does not judge a front page with almost no text, and treats unreadable rules pages as not now", async () => {
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: page(["ブランドA"], TOP_LINKS) })))).toEqual({
      ok: false,
      reasons: ["site_unreachable", "unreachable_top_thin"],
    });
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/terms/`]: undefined })))).toEqual({
      ok: false,
      reasons: ["site_unreachable", "unreachable_terms_http404"],
    });
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/affiliate/`]: undefined })))).toEqual({
      ok: false,
      reasons: ["site_unreachable", "unreachable_partner_http404"],
    });
  });

  it("needs a price page that shows prices and is read like every other page", async () => {
    const noPrices = page(["ミニサーバー", "詳しく見る", "ミニサーバー", "ミニサーバー"]);
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/price/`]: noPrices })))).toEqual({ ok: false, reasons: ["no_price_page"] });
    const robots = "User-agent: *\nDisallow: /price";
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/robots.txt`]: robots })))).toEqual({ ok: false, reasons: ["no_price_page"] });
  });

  it("rejects a site that does not show the advertiser's name, and says what kind of miss it was without the name", async () => {
    const result = await vetAdvertiserSite({ ...candidate, name: "別の会社" }, deps(site()));
    expect(result).toEqual({ ok: false, reasons: ["name_not_on_site", "name_miss_lt1k_kanji_p1_v0_o0_tjp_s1"] });
    const generic = await vetAdvertiserSite({ ...candidate, name: "ウォーターサーバー宅配水" }, deps(site()));
    expect(generic).toEqual({ ok: false, reasons: ["name_not_on_site", "name_miss_lt1k_kana_p0_v0_o0_tjp_s1"] });
  });

  it("finds the name in what the site says about itself besides its text: a logo's alternative text, its meta names", async () => {
    const shell = (head: string, body: string): string =>
      `<html><head><title>ようこそ</title>${head}</head><body>${body}<p>${FILLER}</p>${TOP_LINKS}</body></html>`;
    const logo = shell("", `<img src="/logo.png" alt="ブランドA">`);
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: logo })))).toMatchObject({ ok: true, brandName: "ブランドA" });
    const meta = shell(`<meta property="og:site_name" content="ブランドA">`, "");
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: meta })))).toMatchObject({ ok: true, brandName: "ブランドA" });
    const structured = shell(`<script type="application/ld+json">{"@type":"Organization","name":"ブランドA"}</script>`, "");
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: structured })))).toMatchObject({ ok: true, brandName: "ブランドA" });
    const none = shell("", `<img src="/logo.png" alt="別の会社">`);
    expect(await vetAdvertiserSite(candidate, deps(site({ [`${ORIGIN}/`]: none })))).toMatchObject({ ok: false, reasons: ["name_not_on_site", expect.any(String)] });
  });

  it("does not tell hiragana from katakana, nor a long-vowel mark or a dot from nothing", async () => {
    const hira = page(["ぶらんど・えー", FILLER], TOP_LINKS).replace("<title>ブランドA</title>", "<title>ようこそ</title>");
    const named = { ...candidate, name: "ブランドエー" };
    expect(await vetAdvertiserSite(named, deps(site({ [`${ORIGIN}/`]: hira })))).toMatchObject({ ok: true });
    const other = page(["べつのかいしゃ", FILLER], TOP_LINKS).replace("<title>ブランドA</title>", "<title>ようこそ</title>");
    expect(await vetAdvertiserSite(named, deps(site({ [`${ORIGIN}/`]: other })))).toMatchObject({ ok: false });
  });

  it("says, without the name, how near a miss was: what the page sells, whether its title is in Latin letters, how much of the name is on it", async () => {
    const latin = `<html><head><title>BRAND A Official</title></head><body><p>ウォーターサーバーの宅配です。</p><p>${FILLER}</p>${TOP_LINKS}</body></html>`;
    const result = await vetAdvertiserSite({ ...candidate, name: "ゆゆゆゆ" }, deps(site({ [`${ORIGIN}/`]: latin })));
    expect(result).toEqual({ ok: false, reasons: ["name_not_on_site", "name_miss_lt1k_other_p1_v1_o0_tlatin_s1"] });
    const near = page(["ぶらんど", FILLER], TOP_LINKS).replace("<title>ブランドA</title>", "<title>ようこそ</title>");
    const partly = await vetAdvertiserSite({ ...candidate, name: "ブランドエクセル" }, deps(site({ [`${ORIGIN}/`]: near })));
    expect(partly).toMatchObject({ ok: false, reasons: ["name_not_on_site", expect.stringMatching(/_o[12]_tjp_s0$/)] });
  });

  it("reads what a page says about itself in time proportional to its size, however it is broken", () => {
    const started = Date.now();
    identityText("<meta ".repeat(250_000));
    identityText('<script type="application/ld+json">'.repeat(40_000));
    identityText("<img alt=".repeat(150_000));
    expect(Date.now() - started).toBeLessThan(2_000);
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
    expect(result).toEqual({ ok: false, reasons: ["site_unreachable", "unreachable_top_offsite"] });
  });

  it("says, without the address, why a page could not be read: the status it answered with, a page that is not HTML, a timeout", async () => {
    const answering = (status: number, contentType = "text/html") => ({
      async fetch(url: string) {
        if (url.endsWith("/robots.txt")) return { status: 404, body: "", contentType: "text/plain", finalUrl: url };
        return { status, body: page(["ブランドA", FILLER], TOP_LINKS), contentType, finalUrl: url };
      },
    });
    const run = (fetcher: { fetch: MapFetcher["fetch"] }) => vetAdvertiserSite(candidate, { ...deps(site()), fetcher });
    expect(await run(answering(403))).toEqual({ ok: false, reasons: ["site_unreachable", "unreachable_top_http403"] });
    expect(await run(answering(503))).toEqual({ ok: false, reasons: ["site_unreachable", "unreachable_top_http503"] });
    expect(await run(answering(200, "application/pdf"))).toEqual({ ok: false, reasons: ["site_unreachable", "unreachable_top_notHtml"] });
    const timingOut = { async fetch(url: string): Promise<never> { throw new FetchError(url, null, "AbortError: This operation was aborted"); } };
    expect(await run(timingOut)).toEqual({ ok: false, reasons: ["site_unreachable", "unreachable_top_timeout"] });
    const broken = { async fetch(url: string): Promise<never> { throw new FetchError(url, null, "TypeError: fetch failed"); } };
    expect(await run(broken)).toEqual({ ok: false, reasons: ["site_unreachable", "unreachable_top_network"] });
  });

  it("is not now, not never, when a page could not be read, however the reason is told", () => {
    expect(isTransientReason("site_unreachable")).toBe(true);
    expect(isTransientReason("unreachable_top_http403")).toBe(true);
    expect(isTransientReason("name_not_on_site")).toBe(false);
    expect(isTransientReason("name_miss_lt1k_kanji_p1_v0_o0_tjp_s1")).toBe(false);
  });
});

describe("a name the site gives itself, checked against the console's own page", () => {
  const operator = { ...candidate, name: "運営会社", programText: "プログラムの概要\nブランドAは、ご家庭にお水を届けるサービスです。" };
  const shell = (head: string): string => `<html><head>${head}</head><body><p>${FILLER}</p>${TOP_LINKS}</body></html>`;

  it("accepts a site whose own name the console's page also gives, though the console names the operating company", async () => {
    expect(await vetAdvertiserSite(operator, deps(site()))).toMatchObject({ ok: true, brandName: "ブランドA" });
    const meta = shell(`<title>ようこそ</title><meta property="og:site_name" content="ブランドA">`);
    expect(await vetAdvertiserSite(operator, deps(site({ [`${ORIGIN}/`]: meta })))).toMatchObject({ ok: true, brandName: "ブランドA" });
    const structured = shell(`<title>ようこそ</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"ブランドA"}]}</script>`);
    expect(await vetAdvertiserSite(operator, deps(site({ [`${ORIGIN}/`]: structured })))).toMatchObject({ ok: true, brandName: "ブランドA" });
    const titled = shell(`<title>ウォーターサーバーの宅配 | ブランドA 公式サイト</title>`);
    expect(await vetAdvertiserSite(operator, deps(site({ [`${ORIGIN}/`]: titled })))).toMatchObject({ ok: true, brandName: "ブランドA" });
  });

  it("does not accept it when the console's page does not give that name, or gives no page text at all", async () => {
    const other = { ...operator, programText: "プログラムの概要\n別のサービスです。" };
    expect(await vetAdvertiserSite(other, deps(site()))).toMatchObject({ ok: false, reasons: ["name_not_on_site", expect.any(String)] });
    const { programText: _unused, ...bare } = operator;
    expect(await vetAdvertiserSite(bare, deps(site()))).toMatchObject({ ok: false, reasons: ["name_not_on_site", expect.any(String)] });
  });

  it("does not take words for what is sold, or for what a page is, as the site's name", async () => {
    const generic = { ...operator, programText: "ウォーターサーバー 公式サイト 料金 比較 トップページ ブランド" };
    for (const title of ["ウォーターサーバー公式サイト", "料金比較 | トップページ", "ようこそ", "水"]) {
      const result = await vetAdvertiserSite(generic, deps(site({ [`${ORIGIN}/`]: shell(`<title>${title}</title>`) })));
      expect(result, title).toMatchObject({ ok: false, reasons: ["name_not_on_site", expect.any(String)] });
    }
  });

  it("lists what the page calls itself, once each and not too many", () => {
    const html = `<title>A社の宅配水 | ブランドA</title><meta property="og:site_name" content="ブランドA"><meta name="application-name" content="ブランドA">`;
    expect(selfNames(html)).toEqual(["ブランドA", "A社の宅配水"]);
    expect(selfNames(`<meta property="og:site_name" content="ブランドA">`.repeat(5_000)).length).toBeLessThanOrEqual(12);
    expect(selfNames("<script type=\"application/ld+json\">{broken</script>")).toEqual([]);
  });
});

describe("the pages a plan takes its amounts from", () => {
  const MORE_LINKS = `${TOP_LINKS}<a href="/fee/">ご利用料金</a><a href="/server/">サーバー一覧</a>`;
  const withFees = (overrides: Record<string, string | undefined> = {}) =>
    site({
      [`${ORIGIN}/`]: page(["ブランドAへようこそ", FILLER], MORE_LINKS),
      [`${ORIGIN}/fee/`]: page(["送料 無料", "初回費用 3,300円", "電気代 月 400円"]),
      [`${ORIGIN}/server/`]: page(["レンタル料 無料", "サーバー一覧"]),
      ...overrides,
    });

  it("keeps every page of the site that shows prices, the one that lists the servers first, because the amounts of one service are spread over several pages", async () => {
    const result = await vetAdvertiserSite(candidate, deps(withFees()));
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      listUrls: [`${ORIGIN}/price/`],
      sourceUrls: [`${ORIGIN}/price/`, `${ORIGIN}/fee/`],
    });
  });

  it("leaves out a page that shows no price, one that robots.txt keeps out, and one that is not on the site", async () => {
    const result = await vetAdvertiserSite(
      candidate,
      deps(withFees({ [`${ORIGIN}/server/`]: page(["サーバー一覧"]), [`${ORIGIN}/robots.txt`]: "User-agent: *\nDisallow: /fee" })),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sourceUrls: [`${ORIGIN}/price/`] });
  });

  it("takes the front page too when it shows prices, at most four pages in all", async () => {
    const result = await vetAdvertiserSite(
      candidate,
      deps(
        withFees({
          [`${ORIGIN}/`]: page(["ブランドAへようこそ 月 1,000円から", FILLER], `${MORE_LINKS}<a href="/plan/">プラン</a><a href="/line/">ラインナップ</a>`),
          [`${ORIGIN}/server/`]: page(["サーバー一覧 レンタル料 500円"]),
          [`${ORIGIN}/plan/`]: page(["プラン 2,000円"]),
          [`${ORIGIN}/line/`]: page(["ラインナップ 3,000円"]),
        }),
      ),
    );
    expect(result.ok && result.sourceUrls).toEqual([`${ORIGIN}/price/`, `${ORIGIN}/fee/`, `${ORIGIN}/server/`, `${ORIGIN}/`]);
  });
});

describe("refreshSourcePages", () => {
  const MORE_LINKS = `${TOP_LINKS}<a href="/fee/">ご利用料金</a>`;
  const fetcher = () =>
    site({
      [`${ORIGIN}/`]: page(["ブランドAへようこそ", FILLER], MORE_LINKS),
      [`${ORIGIN}/fee/`]: page(["送料 無料", "初回費用 3,300円"]),
    });

  it("adds the price pages the site has now to the ones a brand already has, and keeps the ones it has first", async () => {
    expect(await refreshSourcePages(fetcher(), HOST, [`${ORIGIN}/price/`], [`${ORIGIN}/affiliate/`])).toEqual([
      `${ORIGIN}/price/`,
      `${ORIGIN}/fee/`,
    ]);
  });

  it("never takes a page away, however the site looks today", async () => {
    const known = [`${ORIGIN}/price/`, `${ORIGIN}/gone/`];
    const refreshed = await refreshSourcePages(fetcher(), HOST, known, []);
    expect(refreshed?.slice(0, 2)).toEqual(known);
  });

  it("stops at four pages", async () => {
    const known = [1, 2, 3, 4].map((n) => `${ORIGIN}/p${n}/`);
    expect(await refreshSourcePages(fetcher(), HOST, known, [])).toEqual(known);
  });

  it("says nothing when the front page cannot be read now, so that a bad day changes nothing", async () => {
    expect(await refreshSourcePages(new MapFetcher(new Map()), HOST, [`${ORIGIN}/price/`], [])).toBeUndefined();
  });
});

describe("a site whose plans cannot be drafted", () => {
  const draftOf = (outcome: { ok: true } | { ok: false; issues: string[] }) => {
    const seen: string[][] = [];
    return {
      seen,
      draft: async (plan: { sourceUrls: string[] }) => {
        seen.push(plan.sourceUrls);
        return outcome.ok ? { ok: true as const, plan: plan as never } : { ok: false as const, issues: outcome.issues };
      },
    };
  };

  it("is registered when a plan can be drafted from the pages it would rest on", async () => {
    const { seen, draft } = draftOf({ ok: true });
    const result = await vetAdvertiserSite(candidate, { ...deps(site()), draft });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([[`${ORIGIN}/price/`]]);
  });

  it("is refused, with which amounts were missing and none of the page's words, when no plan can be", async () => {
    const { draft } = draftOf({ ok: false, issues: ["水代: 月25Lあたりの金額を示す公式Factが見つかりません（候補: 「ミニサーバー 3,000円」）", "電気代: 公式Factに金額が見つかりません", "初回費用: 公式Factに金額が見つかりません"] });
    const result = await vetAdvertiserSite(candidate, { ...deps(site()), draft });
    expect(result).toEqual({ ok: false, reasons: ["plan_not_draftable", "draft_electricity", "draft_initial", "draft_water"] });
  });

  it("tries a second service before it gives up", async () => {
    const attempts: number[] = [];
    const draft = async (plan: { slug: string }) => {
      attempts.push(attempts.length);
      return attempts.length === 1 ? { ok: false as const, issues: ["電気代: 公式Factに金額が見つかりません"] } : { ok: true as const, plan: plan as never };
    };
    const twoServices = site({ [`${ORIGIN}/price/`]: page(["ミニサーバー", "月額 3,000円", "ミニサーバー", "スリムサーバー", "月額 2,000円", "スリムサーバー"]) });
    const result = await vetAdvertiserSite(candidate, { ...deps(twoServices, new FakeLister(["ミニサーバー", "スリムサーバー"])), draft });
    expect(result.ok).toBe(true);
    expect(attempts.length).toBe(2);
  });

  it("is not now, not never, when the model failed while drafting", async () => {
    const draft = async () => {
      throw new Error("model down");
    };
    const result = await vetAdvertiserSite(candidate, { ...deps(site()), draft });
    expect(result).toEqual({ ok: false, reasons: ["listing_failed"] });
    expect(isTransientReason("listing_failed")).toBe(true);
  });
});

describe("trialRegistered", () => {
  const brand = { brandSlug: "brand-a", brandName: "ブランドA", host: HOST, listUrls: [`${ORIGIN}/price/`], sourceUrls: [`${ORIGIN}/price/`, `${ORIGIN}/fee/`] };
  const make = (draft: (plan: { sourceUrls: string[] }) => Promise<{ ok: true; plan: never } | { ok: false; issues: string[] }>, names = ["ミニサーバー"]) => ({
    ...deps(site(), new FakeLister(names)),
    draft: draft as never,
  });

  it("drafts the services of a registered advertiser from all the pages it rests on", async () => {
    const seen: string[][] = [];
    const result = await trialRegistered(brand, make(async (plan) => (seen.push(plan.sourceUrls), { ok: true, plan: plan as never })));
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([brand.sourceUrls]);
  });

  it("refuses with the amounts that were missing", async () => {
    const result = await trialRegistered(brand, make(async () => ({ ok: false, issues: ["電気代: 公式Factに金額が見つかりません"] })));
    expect(result).toEqual({ ok: false, reasons: ["plan_not_draftable", "draft_electricity"] });
  });

  it("does not judge when no service could be listed today", async () => {
    const result = await trialRegistered(brand, make(async () => ({ ok: false, issues: ["電気代: x"] }), []));
    expect(result).toEqual({ ok: false, reasons: ["listing_failed"] });
  });
});
