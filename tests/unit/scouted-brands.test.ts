import { describe, expect, it } from "vitest";
import type { ScoutedBrand } from "@aff/db";
import { parsePolicyText } from "@aff/domain";
import {
  DRAFT_RULES_MARK,
  activeScoutedSources,
  brandOfScouted,
  knownProgramIds,
  registrableHost,
  scoutedInUse,
  scoutedTerms,
  withScoutedBrands,
  withScoutedDomains,
  type A8ProgramsConfig,
} from "@aff/agents";
import { readFileSync } from "./helpers.js";

const NOW = new Date("2026-10-30T00:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const scouted = (overrides: Partial<ScoutedBrand> = {}): ScoutedBrand => ({
  programId: "s0001",
  brandSlug: "brand-a",
  state: "vetted",
  keyword: "ブランドA",
  host: "brand-a.com",
  brandName: "ブランドA",
  termsUrl: "https://brand-a.com/affiliate/",
  termsSha256: "a".repeat(64),
  listUrls: ["https://brand-a.com/price/"],
  sourceUrls: ["https://brand-a.com/price/"],
  reasons: [],
  checkedAt: daysAgo(1),
  ...overrides,
});

const config: A8ProgramsConfig = {
  siteName: "総額比較",
  applicationsPerRun: 1,
  brands: [
    {
      brandSlug: "premium-water",
      keyword: "プレミアムウォーター",
      verticalId: "water_delivery",
      termsUrl: "https://premium-water.net/affiliate/",
      termsSha256: "b".repeat(64),
      trademarkTerms: ["プレミアムウォーター"],
    },
  ],
};

describe("brandOfScouted", () => {
  it("makes a brand whose title may not start with the company's name", () => {
    expect(brandOfScouted(scouted())).toEqual({
      brandSlug: "brand-a",
      keyword: "ブランドA",
      verticalId: "water_delivery",
      termsUrl: "https://brand-a.com/affiliate/",
      termsSha256: "a".repeat(64),
      trademarkTerms: ["ブランドA"],
    });
  });

  it("keeps the console's name too when it differs from the company's", () => {
    const brand = brandOfScouted(scouted({ keyword: "ブランドA(ウォーターサーバー)", brandName: "ブランドA" }));
    expect(brand?.trademarkTerms).toEqual(["ブランドA", "ブランドA(ウォーターサーバー)"]);
  });

  it("needs the terms that were read", () => {
    expect(brandOfScouted(scouted({ termsUrl: undefined }))).toBeUndefined();
    expect(brandOfScouted(scouted({ termsSha256: undefined }))).toBeUndefined();
  });
});

describe("withScoutedBrands", () => {
  it("adds advertisers that are vetted or active, after the written ones", () => {
    const merged = withScoutedBrands(config, [
      scouted(),
      scouted({ programId: "s0002", brandSlug: "brand-b", keyword: "ブランドB", state: "active" }),
      scouted({ programId: "s0003", brandSlug: "brand-c", keyword: "ブランドC", state: "rejected" }),
      scouted({ programId: "s0004", brandSlug: "brand-d", keyword: "ブランドD", state: "retired" }),
    ]);
    expect(merged.brands.map((brand) => brand.brandSlug)).toEqual(["premium-water", "brand-a", "brand-b"]);
    expect(merged.siteName).toBe("総額比較");
    expect(config.brands).toHaveLength(1);
  });

  it("never lets a scouted advertiser take a written brand's slug or name", () => {
    const merged = withScoutedBrands(config, [
      scouted({ brandSlug: "premium-water" }),
      scouted({ programId: "s0002", brandSlug: "other", keyword: "プレミアムウォーター" }),
    ]);
    expect(merged.brands.map((brand) => brand.brandSlug)).toEqual(["premium-water"]);
  });

  it("takes a slug once", () => {
    const merged = withScoutedBrands(config, [scouted(), scouted({ programId: "s0002", keyword: "ブランドA2" })]);
    expect(merged.brands.filter((brand) => brand.brandSlug === "brand-a")).toHaveLength(1);
  });
});

describe("activeScoutedSources and withScoutedDomains", () => {
  const all = [scouted(), scouted({ programId: "s0002", brandSlug: "brand-b", host: "brand-b.co.jp", state: "active", brandName: "ブランドB" })];

  it("lists price pages only for advertisers the account has joined", () => {
    expect(activeScoutedSources(all)).toEqual([
      {
        verticalId: "water_delivery",
        brandSlug: "brand-b",
        brandName: "ブランドB",
        listUrls: ["https://brand-a.com/price/"],
        sourceUrls: ["https://brand-a.com/price/"],
        months: 24,
        monthlyLiters: 25,
      },
    ]);
  });

  it("allows only the hosts of joined advertisers, on top of the policy's", () => {
    const policy = parsePolicyText(readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"));
    const widened = withScoutedDomains(policy, all);
    expect(widened.security.allowed_source_domains).toEqual([...policy.security.allowed_source_domains, "brand-b.co.jp"]);
    expect(policy.security.allowed_source_domains).not.toContain("brand-b.co.jp");
  });
});

describe("knownProgramIds", () => {
  it("skips what is registered, and what was refused recently", () => {
    const known = knownProgramIds(
      [
        scouted({ programId: "v", state: "vetted" }),
        scouted({ programId: "a", state: "active" }),
        scouted({ programId: "r", state: "retired" }),
        scouted({ programId: "rej-new", state: "rejected", reasons: ["robots_disallow"], checkedAt: daysAgo(3) }),
        scouted({ programId: "rej-old", state: "rejected", reasons: ["robots_disallow"], checkedAt: daysAgo(31) }),
        scouted({ programId: "soon", state: "rejected", reasons: ["site_unreachable"], checkedAt: new Date(NOW.getTime() - 20 * 3_600_000).toISOString() }),
        scouted({ programId: "now", state: "rejected", reasons: ["site_unreachable"], checkedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }),
        scouted({ programId: "noted", state: "rejected", reasons: ["site_unreachable", "unreachable_top_http403"], checkedAt: new Date(NOW.getTime() - 20 * 3_600_000).toISOString() }),
        scouted({ programId: "noted-now", state: "rejected", reasons: ["site_unreachable", "unreachable_top_http403"], checkedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }),
      ],
      NOW,
    );
    expect([...known].sort()).toEqual(["a", "noted-now", "now", "r", "rej-new", "v"]);
  });
});

describe("scoutedInUse", () => {
  it("is the one filter for brands, sources and domains: a brand that takes a written slug is in none of them", () => {
    const clash = scouted({ programId: "s0009", brandSlug: "premium-water", host: "evil-site.com", state: "active", keyword: "別名" });
    const fine = scouted({ programId: "s0002", brandSlug: "brand-b", host: "brand-b.com", state: "active", keyword: "ブランドB" });
    const inUse = scoutedInUse(config, [clash, fine]);
    expect(inUse.map((brand) => brand.brandSlug)).toEqual(["brand-b"]);
    const policy = parsePolicyText(readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"));
    expect(withScoutedDomains(policy, inUse).security.allowed_source_domains).not.toContain("evil-site.com");
    expect(activeScoutedSources(inUse).map((source) => source.brandSlug)).toEqual(["brand-b"]);
  });
});

describe("shared hosting", () => {
  it("is not a site's own name", () => {
    expect(registrableHost("shop.shop-pro.jp")).toBeUndefined();
    expect(registrableHost("brand.tokyo.jp")).toBeUndefined();
    expect(registrableHost("www.brand-a.com")).toBe("brand-a.com");
  });
});

describe("scoutedTerms", () => {
  it("names every word that would identify a picked advertiser, whatever its state", () => {
    const terms = scoutedTerms([
      scouted({ state: "active" }),
      scouted({ programId: "s0002", brandSlug: "brand-b", keyword: "ブランドB【水】", brandName: "ブランドB", host: "brand-b.example.jp", state: "rejected" }),
    ]);
    for (const word of ["s0001", "brand-a", "ブランドA", "brand-a.com", "s0002", "brand-b", "ブランドB【水】", "ブランドB", "brand-b.example.jp"]) {
      expect(terms).toContain(word);
    }
  });

  it("has nothing to say about an empty list", () => {
    expect(scoutedTerms([])).toEqual([]);
  });
});

describe("knownProgramIds for a site whose plans cannot be drafted", () => {
  it("looks at it again after a week, not a month, because the reading improves", () => {
    const brand = (days: number) => scouted({ state: "rejected", reasons: ["plan_not_draftable", "draft_water", DRAFT_RULES_MARK], checkedAt: daysAgo(days) });
    expect(knownProgramIds([brand(6)], NOW).has("s0001")).toBe(true);
    expect(knownProgramIds([brand(8)], NOW).has("s0001")).toBe(false);
  });
});

describe("knownProgramIds for an advertiser let go of because its plans could not be drafted", () => {
  const letGo = (days: number, reasons = ["plan_not_draftable", "draft_water", DRAFT_RULES_MARK]) => scouted({ state: "retired", reasons, checkedAt: daysAgo(days) });

  it("is looked at again after a week, so that a better reading can take it back; other retired ones are not", () => {
    expect(knownProgramIds([letGo(6)], NOW).has("s0001")).toBe(true);
    expect(knownProgramIds([letGo(8)], NOW).has("s0001")).toBe(false);
    expect(knownProgramIds([letGo(30, ["no_articles"])], NOW).has("s0001")).toBe(true);
    expect(knownProgramIds([scouted({ state: "active", reasons: [], checkedAt: daysAgo(30) })], NOW).has("s0001")).toBe(true);
  });
});

describe("knownProgramIds for a site judged by an older way of reading amounts", () => {
  it("looks at a site refused as undraftable again at once when it was judged without the current reading", () => {
    const older = ["plan_not_draftable", "draft_water"];
    expect(knownProgramIds([scouted({ state: "rejected", reasons: older, checkedAt: daysAgo(1) })], NOW).has("s0001")).toBe(false);
    expect(knownProgramIds([scouted({ state: "retired", reasons: older, checkedAt: daysAgo(1) })], NOW).has("s0001")).toBe(false);
  });

  it("does not look again at once at one judged with the current reading, or at one refused for another reason", () => {
    expect(knownProgramIds([scouted({ state: "retired", reasons: ["plan_not_draftable", DRAFT_RULES_MARK], checkedAt: daysAgo(1) })], NOW).has("s0001")).toBe(true);
    expect(knownProgramIds([scouted({ state: "rejected", reasons: ["no_affiliate_page"], checkedAt: daysAgo(1) })], NOW).has("s0001")).toBe(true);
  });
});
