import { describe, expect, it } from "vitest";
import type { ScoutedBrand } from "@aff/db";
import { parsePolicyText } from "@aff/domain";
import {
  activeScoutedSources,
  brandOfScouted,
  knownProgramIds,
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
        scouted({ programId: "soon", state: "rejected", reasons: ["site_unreachable"], checkedAt: daysAgo(2) }),
        scouted({ programId: "now", state: "rejected", reasons: ["site_unreachable"], checkedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }),
      ],
      NOW,
    );
    expect([...known].sort()).toEqual(["a", "now", "r", "rej-new", "v"]);
  });
});
