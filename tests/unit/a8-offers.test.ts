import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { parsePolicyText, type PolicyConfig } from "@aff/domain";
import {
  applyBrandObservation,
  brandOfOfferId,
  ensureBrandOffers,
  offersOfPlan,
  parseA8ProgramsFile,
  programIdFor,
  termsFingerprint,
  type A8Brand,
  type ArticlePlan,
} from "@aff/agents";
import { readFileSync } from "./helpers.js";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const URL_A = "https://px.a8.net/svt/ejp?a8mat=3ABCDE+1FGHIJ+2KLMNO+PQRST";
const policy: PolicyConfig = parsePolicyText(readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"));

const brand: A8Brand = {
  brandSlug: "brand-a",
  keyword: "ブランドA",
  verticalId: "water_delivery",
  termsUrl: "https://brand-a.example.com/affiliate/",
  termsSha256: "a".repeat(64),
  trademarkTerms: ["ブランドA", "BRAND A"],
};
const config = { siteName: "総額比較", applicationsPerRun: 1, brands: [brand] };

const drafted = (slug: string, offerId: string): ArticlePlan => ({
  slug,
  title: "t",
  audience: "a",
  purpose: "p",
  verticalId: "water_delivery",
  keyword: "k",
  sourceUrls: ["https://brand-a.example.com/price/"],
  calculators: [],
  draft: { calculator: "water", offerId, title: `ブランドA ${slug}`, evidenceTerms: [slug], months: 24, monthlyLiters: 25 },
  offerIds: [],
});

describe("parseA8ProgramsFile", () => {
  const valid = {
    $comment: "note",
    siteName: "総額比較",
    brands: [
      {
        brandSlug: "brand-a",
        keyword: "ブランドA",
        verticalId: "water_delivery",
        termsUrl: "https://brand-a.example.com/affiliate/",
        termsSha256: "a".repeat(64),
        trademarkTerms: ["ブランドA"],
      },
    ],
  };

  it("reads a valid file and fills the defaults", () => {
    const parsed = parseA8ProgramsFile(JSON.stringify(valid));
    expect(parsed.siteName).toBe("総額比較");
    expect(parsed.applicationsPerRun).toBe(1);
    expect(parsed.brands[0]!.brandSlug).toBe("brand-a");
  });

  it.each([
    ["an unknown key", { ...valid, extra: 1 }],
    ["no brand", { ...valid, brands: [] }],
    ["no site name", { ...valid, siteName: " " }],
    ["a non-https terms page", { ...valid, brands: [{ ...valid.brands[0], termsUrl: "http://brand-a.example.com/a/" }] }],
    ["a malformed brand slug", { ...valid, brands: [{ ...valid.brands[0], brandSlug: "Brand A" }] }],
    ["a malformed reviewed hash", { ...valid, brands: [{ ...valid.brands[0], termsSha256: "abc" }] }],
    ["a keyword too short to be one program", { ...valid, brands: [{ ...valid.brands[0], keyword: "A" }] }],
    ["a repeated brand", { ...valid, brands: [valid.brands[0], valid.brands[0]] }],
    ["too many applications per run", { ...valid, applicationsPerRun: 50 }],
  ])("rejects %s", (_label, file) => {
    expect(() => parseA8ProgramsFile(JSON.stringify(file))).toThrow(/a8 programs file invalid/);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseA8ProgramsFile("{")).toThrow(/a8 programs file invalid/);
  });

  it("reads the committed file", () => {
    const parsed = parseA8ProgramsFile(readFileSync(new URL("../../config/a8-programs.json", import.meta.url), "utf8"));
    expect(parsed.brands.length).toBeGreaterThan(0);
    for (const entry of parsed.brands) expect(entry.trademarkTerms.length).toBeGreaterThan(0);
  });
});

describe("naming", () => {
  it("names the program record after the brand", () => {
    expect(programIdFor("brand-a")).toBe("prog-a8-brand-a");
  });

  it("finds the brand an offer id belongs to, only on a whole slug", () => {
    expect(brandOfOfferId("offer-brand-a-famfit2", [brand])?.brandSlug).toBe("brand-a");
    expect(brandOfOfferId("offer-brand-ab-famfit2", [brand])).toBeUndefined();
    expect(brandOfOfferId("offer-brand-a", [brand])).toBeUndefined();
    expect(brandOfOfferId("other-brand-a-x", [brand])).toBeUndefined();
  });

  it("prefers the longer brand slug", () => {
    const longer = { ...brand, brandSlug: "brand-a-plus" };
    expect(brandOfOfferId("offer-brand-a-plus-x", [brand, longer])?.brandSlug).toBe("brand-a-plus");
  });

  it("lists the offers of a plan, drafted or written", () => {
    expect(offersOfPlan(drafted("s", "offer-brand-a-s"))).toEqual([{ id: "offer-brand-a-s", title: "ブランドA s" }]);
    const written: ArticlePlan = {
      ...drafted("w", "x"),
      draft: undefined,
      calculators: [{ calculator: "water", input: { offerId: "offer-brand-a-w", title: "Written" } }] as never,
    };
    expect(offersOfPlan(written)).toEqual([{ id: "offer-brand-a-w", title: "Written" }]);
  });
});

describe("termsFingerprint", () => {
  it("does not change with whitespace or width variants, and changes with the words", () => {
    expect(termsFingerprint("禁止  事項\n１")).toBe(termsFingerprint("禁止 事項 1"));
    expect(termsFingerprint("禁止事項")).not.toBe(termsFingerprint("禁止事項 追加"));
    expect(termsFingerprint("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("applyBrandObservation", () => {
  it("records a joined program with its link and a fresh terms check when the terms are as reviewed", async () => {
    const repo = createMemoryRepository();
    const summary = await applyBrandObservation(repo, brand, { kind: "linked", url: URL_A }, "unchanged", NOW);
    expect(summary).toBe("linked");
    expect(await repo.offers.getProgram("prog-a8-brand-a")).toMatchObject({
      status: "APPROVED",
      provider: "a8",
      termsUrl: brand.termsUrl,
      termsCheckedAt: NOW.toISOString(),
    });
    expect(await repo.offers.hasProgramTrackingUrl("prog-a8-brand-a")).toBe(true);
  });

  it("does not renew the terms check when the terms page changed or could not be read", async () => {
    const repo = createMemoryRepository();
    const earlier = "2026-10-25T00:00:00.000Z";
    await repo.offers.upsertProgram({ id: "prog-a8-brand-a", provider: "a8", status: "APPROVED", payoutCurrency: "JPY", termsUrl: brand.termsUrl, termsCheckedAt: earlier });
    expect(await applyBrandObservation(repo, brand, { kind: "linked", url: URL_A }, "changed", NOW)).toBe("linked_terms_changed");
    expect((await repo.offers.getProgram("prog-a8-brand-a"))?.termsCheckedAt).toBe(earlier);
    expect(await applyBrandObservation(repo, brand, { kind: "linked", url: URL_A }, "unreadable", NOW)).toBe("linked_terms_unreadable");
    expect((await repo.offers.getProgram("prog-a8-brand-a"))?.termsCheckedAt).toBe(earlier);
  });

  it("never makes a joined program usable on a first sight with changed terms", async () => {
    const repo = createMemoryRepository();
    await applyBrandObservation(repo, brand, { kind: "linked", url: URL_A }, "changed", NOW);
    expect((await repo.offers.getProgram("prog-a8-brand-a"))?.termsCheckedAt).toBeUndefined();
  });

  it("writes nothing when the console could not be read", async () => {
    const repo = createMemoryRepository();
    expect(await applyBrandObservation(repo, brand, { kind: "unreadable", reason: "list_unrecognized" }, "unchanged", NOW)).toBe("unreadable");
    expect(await repo.offers.getProgram("prog-a8-brand-a")).toBeUndefined();
  });

  it("keeps a known good program when only the link could not be read", async () => {
    const repo = createMemoryRepository();
    await applyBrandObservation(repo, brand, { kind: "linked", url: URL_A }, "unchanged", NOW);
    const before = await repo.offers.getProgram("prog-a8-brand-a");
    expect(await applyBrandObservation(repo, brand, { kind: "joined_unreadable", reason: "no_link_found" }, "unchanged", new Date(NOW.getTime() + 1000))).toBe("joined_unreadable");
    expect(await repo.offers.getProgram("prog-a8-brand-a")).toEqual(before);
    expect(await repo.offers.hasProgramTrackingUrl("prog-a8-brand-a")).toBe(true);
  });

  it("records an application as pending, with no link", async () => {
    const repo = createMemoryRepository();
    expect(await applyBrandObservation(repo, brand, { kind: "not_joined", application: "applied" }, "unchanged", NOW)).toBe("applied");
    expect(await repo.offers.getProgram("prog-a8-brand-a")).toMatchObject({ status: "PENDING" });
    expect(await repo.offers.hasProgramTrackingUrl("prog-a8-brand-a")).toBe(false);
  });

  it("ends a program that was joined and is no longer on the list, and drops its link", async () => {
    const repo = createMemoryRepository();
    await applyBrandObservation(repo, brand, { kind: "linked", url: URL_A }, "unchanged", NOW);
    expect(await applyBrandObservation(repo, brand, { kind: "not_joined", application: "none" }, "unchanged", NOW)).toBe("ended");
    expect(await repo.offers.getProgram("prog-a8-brand-a")).toMatchObject({ status: "TERMINATED" });
    expect(await repo.offers.hasProgramTrackingUrl("prog-a8-brand-a")).toBe(false);
  });

  it("records nothing for a program that was never joined and could not be applied to", async () => {
    const repo = createMemoryRepository();
    expect(await applyBrandObservation(repo, brand, { kind: "not_joined", application: "skipped" }, "unchanged", NOW)).toBe("not_joined");
    expect(await repo.offers.getProgram("prog-a8-brand-a")).toBeUndefined();
  });
});

describe("ensureBrandOffers", () => {
  const plans = [drafted("one", "offer-brand-a-one"), drafted("two", "offer-brand-a-two"), drafted("other", "offer-else-other")];

  async function joined(termsCheckedAt = NOW.toISOString(), withLink = true) {
    const repo = createMemoryRepository();
    await repo.offers.upsertProgram({ id: "prog-a8-brand-a", provider: "a8", status: "APPROVED", payoutCurrency: "JPY", termsUrl: brand.termsUrl, termsCheckedAt });
    if (withLink) await repo.offers.setProgramTrackingUrl("prog-a8-brand-a", URL_A);
    return repo;
  }

  it("registers an approved site offer for each plan of the brand, and none for other plans", async () => {
    const repo = await joined();
    const result = await ensureBrandOffers(repo, plans, config, policy, NOW);
    expect(result).toEqual({ offers: 2, active: 2 });
    const offers = await repo.offers.listOffers();
    expect(offers.map((o) => o.id).sort()).toEqual(["offer-brand-a-one", "offer-brand-a-two"]);
    expect(offers[0]).toMatchObject({
      programId: "prog-a8-brand-a",
      verticalId: "water_delivery",
      rewardModel: "unknown",
      channelPermissions: ["site"],
      active: true,
      status: "APPROVED",
      constraints: { trademark_terms: "ブランドA|BRAND A" },
    });
    expect(offers[0]!.rewardAmountJpy).toBeUndefined();
    expect(Object.keys(await repo.offers.listOfferTrackingUrls()).sort()).toEqual(["offer-brand-a-one", "offer-brand-a-two"]);
  });

  it("registers nothing for a program that is not joined", async () => {
    const repo = createMemoryRepository();
    expect(await ensureBrandOffers(repo, plans, config, policy, NOW)).toEqual({ offers: 0, active: 0 });
    expect(await repo.offers.listOffers()).toEqual([]);
  });

  it.each([
    ["not approved", async () => { const r = await joined(); await r.offers.upsertProgram({ id: "prog-a8-brand-a", provider: "a8", status: "PENDING", payoutCurrency: "JPY", termsUrl: brand.termsUrl, termsCheckedAt: NOW.toISOString() }); return r; }],
    ["without a link", () => joined(NOW.toISOString(), false)],
    ["with a stale terms check", () => joined("2026-10-01T00:00:00.000Z")],
  ])("keeps the offers but turns them off when the program is %s, so the articles go out without a link", async (_label, make) => {
    const repo = await make();
    const result = await ensureBrandOffers(repo, plans, config, policy, NOW);
    expect(result).toEqual({ offers: 2, active: 0 });
    for (const offer of await repo.offers.listOffers()) expect(offer).toMatchObject({ active: false, status: "PENDING" });
    expect(await repo.offers.listOfferTrackingUrls()).toEqual({});
  });

  it("turns an earlier offer off even when no current plan mentions it, and back on when the program is usable again", async () => {
    const repo = await joined();
    await ensureBrandOffers(repo, plans, config, policy, NOW);
    await repo.offers.setProgramTrackingUrl("prog-a8-brand-a", undefined);
    await ensureBrandOffers(repo, [], config, policy, NOW);
    expect((await repo.offers.listOffers()).every((o) => !o.active)).toBe(true);
    await repo.offers.setProgramTrackingUrl("prog-a8-brand-a", URL_A);
    await ensureBrandOffers(repo, [], config, policy, NOW);
    expect((await repo.offers.listOffers()).every((o) => o.active && o.status === "APPROVED")).toBe(true);
  });
});
