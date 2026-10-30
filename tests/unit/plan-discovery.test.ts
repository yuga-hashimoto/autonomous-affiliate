import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { parsePolicyText, type PolicyConfig } from "@aff/domain";
import { type Fetcher } from "@aff/integrations";
import {
  discoverPlans,
  discoveredSlug,
  findServiceNames,
  mergeDiscovered,
  parseDiscoveryFile,
  planForService,
  type ArticlePlan,
  type DiscoverySource,
  type ListRequest,
  type PlanLister,
} from "@aff/agents";
import { readFileSync } from "./helpers.js";

const HOST = "water-a.example.com";
const LIST_URL = `https://${HOST}/price/plan-a/`;
const T0 = new Date("2026-10-30T00:00:00.000Z");

const basePolicy = parsePolicyText(
  readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"),
);
const policy: PolicyConfig = {
  ...basePolicy,
  security: { ...basePolicy.security, allowed_source_domains: [HOST] },
};

/**
 * The shape of an official price page: each server's name is a line of its own and is
 * repeated (price cards, detail sections, the footer list), once with a space in it and
 * once with a note in brackets. Menu words, the plan name and a sentence are lines too.
 */
const PAGE_LINES = [
  "プランAの料金",
  "メニュー",
  "選べるウォーターサーバー",
  "AURA Water Server",
  "famfit2",
  "詳しく見る このサーバーで申し込む",
  "スリムサーバー4",
  "amadana スタンダードサーバー",
  "詳しく見る このサーバーで申し込む",
  "famfit2",
  "AURA Water Server",
  "amadanaスタンダードサーバー",
  "スリムサーバー4",
  "famfit2の使い方",
  "AURA Water Server​（オーラウォーターサーバー）",
  "famfit2（ファムフィットツー）",
  "スリムサーバー4（ロング/ショートタイプ）",
  "amadanaスタンダードサーバー",
  "プランAの料金",
];
const PAGE_HTML = `<html><body>${PAGE_LINES.map((line) => `<p>${line}</p>`).join("\n")}</body></html>`;
const PAGE_TEXT = PAGE_LINES.join("\n");

const source: DiscoverySource = {
  verticalId: "water_delivery",
  brandSlug: "brand-a",
  brandName: "ブランドA",
  planName: "プランA",
  listUrls: [LIST_URL],
  sourceUrls: [LIST_URL, `https://${HOST}/price/`],
  months: 24,
  monthlyLiters: 25,
};

class FakeLister implements PlanLister {
  readonly calls: ListRequest[] = [];
  constructor(private readonly names: string[] | Error) {}
  async list(request: ListRequest): Promise<string[]> {
    this.calls.push(request);
    if (this.names instanceof Error) throw this.names;
    return this.names;
  }
}

const PROPOSED = ["amadanaスタンダードサーバー", "famfit2", "AURA Water Server", "スリムサーバー4"];

function fetcherOf(body: string = PAGE_HTML): { fetcher: Fetcher; fetched: string[] } {
  const fetched: string[] = [];
  const fetcher: Fetcher = {
    async fetch(url) {
      fetched.push(url);
      return { status: 200, body, contentType: "text/html", finalUrl: url };
    },
  };
  return { fetcher, fetched };
}

function depsOf(lister: PlanLister | undefined, fetcher: Fetcher = fetcherOf().fetcher) {
  return { repo: createMemoryRepository(), policy, clock: () => T0, lister, fetcher };
}

describe("findServiceNames", () => {
  it("keeps the names that are lines of the page, in the page's order and not the model's", () => {
    const { names } = findServiceNames(PROPOSED, PAGE_TEXT, { exclude: ["ブランドA", "プランA"] });
    expect(names.map((name) => name.display)).toEqual([
      "AURA Water Server",
      "famfit2",
      "スリムサーバー4",
      "amadanaスタンダードサーバー",
    ]);
  });

  it("drops a name the page does not have, a line that appears only once, and the brand or plan name", () => {
    const { names, rejected } = findServiceNames(
      [...PROPOSED, "存在しない機種X", "famfit2の使い方", "プランAの料金", "メニュー"],
      PAGE_TEXT,
      { exclude: ["ブランドA", "プランA"] },
    );
    expect(names.map((name) => name.display)).not.toContain("存在しない機種X");
    expect(names.map((name) => name.display)).not.toContain("famfit2の使い方");
    expect(names.map((name) => name.display)).not.toContain("プランAの料金");
    expect(names.map((name) => name.display)).not.toContain("メニュー");
    expect(names).toHaveLength(4);
    expect(rejected).toBe(4);
  });

  it("treats a bracketed note, a space and a zero-width space as the same server", () => {
    const { names } = findServiceNames(
      ["famfit2（ファムフィットツー）", "famfit2", "amadana スタンダードサーバー", "AURA Water Server​（オーラウォーターサーバー）"],
      PAGE_TEXT,
      { exclude: [] },
    );
    expect(names.map((name) => name.canonical)).toEqual(["AURAWaterServer", "famfit2", "amadanaスタンダードサーバー"]);
  });

  it("names a server by the form that the page uses most", () => {
    const { names } = findServiceNames(["amadana スタンダードサーバー"], PAGE_TEXT, { exclude: [] });
    expect(names[0]?.display).toBe("amadanaスタンダードサーバー");
  });

  it("returns nothing for an empty proposal", () => {
    expect(findServiceNames([], PAGE_TEXT, { exclude: [] })).toEqual({ names: [], rejected: 0 });
  });
});

describe("discoveredSlug", () => {
  it("keeps an ASCII name readable, so the hand-written plan's slug is the same one", () => {
    expect(discoveredSlug("premium-water", "famfit2", 24)).toBe("premium-water-famfit2-24month");
    expect(discoveredSlug("premium-water", "AURA Water Server", 24)).toBe("premium-water-aura-water-server-24month");
  });

  it("adds a fixed digest of the name when the name has Japanese in it, and never changes", () => {
    expect(discoveredSlug("premium-water", "amadanaスタンダードサーバー", 24)).toBe(
      "premium-water-amadana-53b10b-24month",
    );
    expect(discoveredSlug("premium-water", "amadanaグランデサーバー", 24)).toBe(
      "premium-water-amadana-23812f-24month",
    );
    expect(discoveredSlug("premium-water", "スリムサーバー4", 24)).toBe("premium-water-model-ec990c-24month");
  });

  it("does not depend on spaces in the name", () => {
    expect(discoveredSlug("b", "amadana スタンダードサーバー", 24)).toBe(discoveredSlug("b", "amadanaスタンダードサーバー", 24));
  });

  it("separates the same server over different periods", () => {
    expect(discoveredSlug("b", "famfit2", 12)).not.toBe(discoveredSlug("b", "famfit2", 24));
  });
});

describe("planForService", () => {
  it("makes a brief-only plan: no yen amount, the page's own words for the service", () => {
    const plan = planForService(source, { display: "famfit2", canonical: "famfit2" });
    expect(plan).toMatchObject({
      slug: "brand-a-famfit2-24month",
      verticalId: "water_delivery",
      calculators: [],
      sourceUrls: source.sourceUrls,
      offerIds: [],
      draft: {
        calculator: "water",
        offerId: "offer-brand-a-famfit2",
        title: "ブランドA famfit2（プランAプラン）",
        evidenceTerms: ["famfit2", "ブランドA"],
        priceTerms: ["famfit2"],
        planTerms: ["プランA"],
        months: 24,
        monthlyLiters: 25,
      },
    });
    expect(plan.title).toContain("famfit2");
    expect(plan.title).toContain("24ヶ月");
    expect(plan.keyword).toContain("famfit2");
  });

  it("reads the plan's pages when no other page is given, and has no plan term without a plan name", () => {
    const plan = planForService(
      { ...source, sourceUrls: undefined, planName: undefined },
      { display: "famfit2", canonical: "famfit2" },
    );
    expect(plan.sourceUrls).toEqual(source.listUrls);
    expect(plan.draft?.planTerms).toBeUndefined();
    expect(plan.draft?.title).toBe("ブランドA famfit2");
  });

  it("also accepts the spaceless spelling of a server the page spaces out", () => {
    const plan = planForService(source, { display: "AURA Water Server", canonical: "AURAWaterServer" });
    expect(plan.draft?.evidenceTerms).toEqual(["AURA Water Server", "AURAWaterServer", "ブランドA"]);
  });
});

describe("parseDiscoveryFile", () => {
  const file = (sources: unknown) => JSON.stringify({ sources });

  it("fills the comparison period and volume the stock uses", () => {
    const [parsed] = parseDiscoveryFile(
      file([{ verticalId: "water_delivery", brandSlug: "brand-a", brandName: "ブランドA", listUrls: [LIST_URL] }]),
    );
    expect(parsed).toMatchObject({ months: 24, monthlyLiters: 25, listUrls: [LIST_URL] });
  });

  it.each([
    ["a vertical it cannot draft", { verticalId: "sim" }],
    ["an uppercase brand slug", { brandSlug: "Brand_A" }],
    ["a list URL that is not a URL", { listUrls: ["premium-water.net/price"] }],
    ["no list page", { listUrls: [] }],
    ["a plain-http page", { listUrls: ["http://water-a.example.com/price/"] }],
    ["a period beyond ten years", { months: 121 }],
  ])("rejects %s", (_label, patch) => {
    const entry = { verticalId: "water_delivery", brandSlug: "brand-a", brandName: "ブランドA", listUrls: [LIST_URL], ...patch };
    expect(() => parseDiscoveryFile(file([entry]))).toThrow(/discovery file invalid/);
  });

  it("rejects a file with no source", () => {
    expect(() => parseDiscoveryFile(file([]))).toThrow(/discovery file invalid/);
  });

  it("reads the file the daily run uses", () => {
    const sources = parseDiscoveryFile(readFileSync(new URL("../../config/discovery.live.json", import.meta.url), "utf8"));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      brandSlug: "premium-water",
      planName: "もっとPREMIUM",
      months: 24,
      monthlyLiters: 25,
    });
    expect(sources[0]?.listUrls.every((url) => new URL(url).hostname === "premium-water.net")).toBe(true);
    expect((sources[0]?.sourceUrls ?? []).every((url) => new URL(url).hostname === "premium-water.net")).toBe(true);
  });

  it("rejects a file that is not JSON", () => {
    expect(() => parseDiscoveryFile("{")).toThrow(/discovery file invalid/);
  });
});

describe("discoverPlans", () => {
  it("makes one brief-only plan per server on the page, in the page's order", async () => {
    const lister = new FakeLister(PROPOSED);
    const result = await discoverPlans([source], depsOf(lister));
    expect(result.plans.map((plan) => plan.slug)).toEqual([
      "brand-a-aura-water-server-24month",
      "brand-a-famfit2-24month",
      "brand-a-model-ec990c-24month",
      "brand-a-amadana-53b10b-24month",
    ]);
    expect(result.plans.every((plan) => plan.calculators.length === 0 && plan.draft !== undefined)).toBe(true);
    expect(result.summary).toEqual({ sources: 1, found: 4, skipped: {} });
  });

  it("gives the lister the page text and the brand, and nothing else of the page's markup", async () => {
    const lister = new FakeLister(PROPOSED);
    await discoverPlans([source], depsOf(lister));
    expect(lister.calls.length).toBeGreaterThan(0);
    expect(lister.calls[0]?.brand).toBe("ブランドA");
    expect(lister.calls[0]?.window).toContain("famfit2");
    expect(lister.calls[0]?.window).not.toContain("<p>");
  });

  it("makes the same plans whatever order the model lists the servers in", async () => {
    const a = await discoverPlans([source], depsOf(new FakeLister(PROPOSED)));
    const b = await discoverPlans([source], depsOf(new FakeLister([...PROPOSED].reverse())));
    expect(b.plans.map((plan) => plan.slug)).toEqual(a.plans.map((plan) => plan.slug));
  });

  it("makes no plan for a name the model invented", async () => {
    const result = await discoverPlans([source], depsOf(new FakeLister(["famfit2", "存在しない機種X"])));
    expect(result.plans.map((plan) => plan.slug)).toEqual(["brand-a-famfit2-24month"]);
  });

  it("does not fetch a source whose host the owner has not allowed", async () => {
    const { fetcher, fetched } = fetcherOf();
    const lister = new FakeLister(PROPOSED);
    const other: DiscoverySource = { ...source, listUrls: ["https://not-allowed.example.net/price/"], sourceUrls: undefined };
    const result = await discoverPlans([other], depsOf(lister, fetcher));
    expect(result.plans).toEqual([]);
    expect(fetched).toEqual([]);
    expect(lister.calls).toEqual([]);
    expect(result.summary.skipped).toEqual({ domain_not_allowlisted: 1 });
  });

  it("does not use a source whose plan pages are outside the allowlist, even when its list page is allowed", async () => {
    const { fetcher, fetched } = fetcherOf();
    const mixed: DiscoverySource = { ...source, sourceUrls: [LIST_URL, "https://not-allowed.example.net/price/"] };
    const result = await discoverPlans([mixed], depsOf(new FakeLister(PROPOSED), fetcher));
    expect(result.plans).toEqual([]);
    expect(fetched).toEqual([]);
    expect(result.summary.skipped).toEqual({ domain_not_allowlisted: 1 });
  });

  it("skips a source whose list page cannot be read, without stopping the others", async () => {
    const gone: Fetcher = {
      async fetch(url) {
        const status = url.includes("/gone") ? 404 : 200;
        return { status, body: status === 200 ? PAGE_HTML : "", contentType: "text/html", finalUrl: url };
      },
    };
    const result = await discoverPlans(
      [{ ...source, listUrls: [`https://${HOST}/gone/`], sourceUrls: undefined }, source],
      depsOf(new FakeLister(["famfit2"]), gone),
    );
    expect(result.plans.map((plan) => plan.slug)).toEqual(["brand-a-famfit2-24month"]);
    expect(result.summary).toEqual({ sources: 2, found: 1, skipped: { source_unavailable: 1 } });
  });

  it("skips a source when the model fails, and says why", async () => {
    const result = await discoverPlans([source], depsOf(new FakeLister(new Error("rate limited"))));
    expect(result.plans).toEqual([]);
    expect(result.summary.skipped).toEqual({ listing_failed: 1 });
  });

  it("skips a source when nothing can name the model", async () => {
    const result = await discoverPlans([source], depsOf(undefined));
    expect(result.plans).toEqual([]);
    expect(result.summary.skipped).toEqual({ listing_failed: 1 });
  });

  it("says when the page has no server the model named", async () => {
    const result = await discoverPlans([source], depsOf(new FakeLister(["存在しない機種X"])));
    expect(result.plans).toEqual([]);
    expect(result.summary.skipped).toEqual({ no_services: 1 });
  });

  it("makes a server once when two sources list it", async () => {
    const result = await discoverPlans([source, source], depsOf(new FakeLister(["famfit2"])));
    expect(result.plans.map((plan) => plan.slug)).toEqual(["brand-a-famfit2-24month"]);
  });
});

describe("mergeDiscovered", () => {
  const plan = (slug: string): ArticlePlan => ({
    slug,
    title: slug,
    audience: "a",
    purpose: "p",
    verticalId: "water_delivery",
    keyword: "k",
    sourceUrls: [LIST_URL],
    calculators: [],
    offerIds: [],
  });

  it("keeps the written plans first and unchanged, then the discovered ones", () => {
    const merged = mergeDiscovered([plan("written")], [plan("found-1"), plan("found-2")]);
    expect(merged.map((p) => p.slug)).toEqual(["written", "found-1", "found-2"]);
  });

  it("lets a written plan win over a discovered plan of the same slug", () => {
    const written = { ...plan("same"), title: "written title" };
    const merged = mergeDiscovered([written], [{ ...plan("same"), title: "found title" }, plan("other")]);
    expect(merged.map((p) => p.title)).toEqual(["written title", "other"]);
  });
});
