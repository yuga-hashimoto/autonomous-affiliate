import { describe, expect, it } from "vitest";
import { createMemoryRepository, type ScoutedBrand } from "@aff/db";
import { MapFetcher } from "@aff/integrations";
import { termsFingerprint, type VetCandidate, type VetResult } from "@aff/agents";
import { advanceScouted, registerCandidates, renewScoutedTerms } from "../../apps/worker/src/a8-register.js";
import type { ReadCandidate } from "../../apps/worker/src/a8-scout.js";

const NOW = new Date("2026-10-30T00:00:00.000Z");
const passed = (id: string, name: string, host: string | undefined, via: "labeled_link" | "none" | "ambiguous" = "labeled_link"): ReadCandidate => ({
  candidate: { programId: id, name, joined: false, detailPath: `/program/detail-not-partnered?programId=${id}` },
  gate: { ok: true, reasons: [] },
  site: host ? { host, via } : { via: via === "labeled_link" ? "none" : via },
  signals: { chars: 1000, prohibitions: 0, topics: [] },
});
const failed = (id: string, reasons: string[]): ReadCandidate => ({
  candidate: { programId: id, name: `広告主${id}`, joined: false, detailPath: `/program/detail-not-partnered?programId=${id}` },
  gate: { ok: false, reasons },
  site: { host: "x.com", via: "labeled_link" },
  signals: { chars: 1000, prohibitions: 1, topics: ["price"] },
});

const okVet = (candidate: VetCandidate): VetResult => ({
  ok: true,
  brandName: candidate.name,
  termsUrl: `https://${candidate.host}/affiliate/`,
  termsSha256: "c".repeat(64),
  listUrls: [`https://${candidate.host}/price/`],
  sourceUrls: [`https://${candidate.host}/price/`],
  services: 2,
});

function setup(vet: (candidate: VetCandidate) => Promise<VetResult> | VetResult = okVet, limits = { maxVets: 2, maxRegistered: 3 }) {
  const repo = createMemoryRepository();
  const vetted: string[] = [];
  const deps = {
    repo,
    clock: () => NOW,
    taken: new Set<string>(["premium-water"]),
    vet: async (candidate: VetCandidate) => {
      vetted.push(candidate.brandSlug);
      return vet(candidate);
    },
    ...limits,
  };
  return { repo, deps, vetted };
}

describe("registerCandidates", () => {
  it("registers a candidate whose rules and site pass", async () => {
    const { repo, deps } = setup();
    const counts = await registerCandidates([passed("s0001", "コスモウォーター", "cosmo-water.com")], deps);
    expect(counts).toEqual({ vetted: 1 });
    expect(await repo.scout.get("s0001")).toMatchObject({
      state: "vetted",
      brandSlug: "cosmo-water",
      keyword: "コスモウォーター",
      host: "cosmo-water.com",
      termsUrl: "https://cosmo-water.com/affiliate/",
      listUrls: ["https://cosmo-water.com/price/"],
      reasons: [],
      checkedAt: NOW.toISOString(),
    });
  });

  it("records why a candidate was refused, without looking at its site when the program's rules already say no", async () => {
    const { repo, deps, vetted } = setup();
    const counts = await registerCandidates(
      [failed("s0001", ["restricted_price"]), passed("s0002", "A社", undefined, "ambiguous"), passed("s0003", "B社", undefined, "none")],
      deps,
    );
    expect(counts).toEqual({ rejected: 3 });
    expect(vetted).toEqual([]);
    expect((await repo.scout.get("s0001"))?.reasons).toEqual(["restricted_price"]);
    expect((await repo.scout.get("s0002"))?.reasons).toEqual(["site_ambiguous"]);
    expect((await repo.scout.get("s0003"))?.reasons).toEqual(["site_none"]);
    expect((await repo.scout.get("s0001"))?.state).toBe("rejected");
  });

  it("records a refusal from the site check, and keeps a transient one apart", async () => {
    const { repo, deps } = setup((candidate) =>
      candidate.host === "down.com" ? { ok: false, reasons: ["site_unreachable"] } : { ok: false, reasons: ["terms_ban_automation"] },
    );
    const counts = await registerCandidates([passed("s0001", "A社", "down.com"), passed("s0002", "B社", "strict.com")], deps);
    expect(counts).toEqual({ retry_later: 1, rejected: 1 });
    expect((await repo.scout.get("s0002"))?.reasons).toEqual(["terms_ban_automation"]);
  });

  it("gives up on a site that takes too long, to look again tomorrow, and on one that throws", async () => {
    const { repo, deps } = setup((candidate) => (candidate.host === "slow.com" ? new Promise<VetResult>(() => undefined) : Promise.reject(new Error("boom"))));
    const counts = await registerCandidates([passed("s0001", "A社", "slow.com"), passed("s0002", "B社", "broken.com")], { ...deps, vetTimeoutMs: 20 });
    expect(counts).toEqual({ retry_later: 2 });
    expect((await repo.scout.get("s0001"))?.reasons).toEqual(["vet_timeout"]);
    expect((await repo.scout.get("s0002"))?.reasons).toEqual(["site_unreachable"]);
  });

  it("does not judge a page that came back almost empty", async () => {
    const { repo, deps, vetted } = setup();
    const empty = { ...passed("s0001", "A社", "a-site.com"), signals: { chars: 20, prohibitions: 0, topics: [] } };
    expect(await registerCandidates([empty], deps)).toEqual({ retry_later: 1 });
    expect(vetted).toEqual([]);
    expect((await repo.scout.get("s0001"))?.reasons).toEqual(["page_unreadable"]);
  });

  it("does not take a slug that a brand already has", async () => {
    const { repo, deps, vetted } = setup();
    const counts = await registerCandidates([passed("s0001", "プレミアム", "premium-water.com")], deps);
    expect(counts).toEqual({ rejected: 1 });
    expect(vetted).toEqual([]);
    expect((await repo.scout.get("s0001"))?.reasons).toEqual(["slug_taken"]);
  });

  it("checks at most a few sites in one run and leaves the rest for the next", async () => {
    const { repo, deps, vetted } = setup(okVet, { maxVets: 1, maxRegistered: 3 });
    const counts = await registerCandidates([passed("s0001", "A社", "a-site.com"), passed("s0002", "B社", "b-site.com")], deps);
    expect(counts).toEqual({ vetted: 1, waiting: 1 });
    expect(vetted).toEqual(["a-site"]);
    expect(await repo.scout.get("s0002")).toBeUndefined();
  });

  it("stops registering at the limit on advertisers in use", async () => {
    const { repo, deps } = setup(okVet, { maxVets: 5, maxRegistered: 1 });
    const counts = await registerCandidates([passed("s0001", "A社", "a-site.com"), passed("s0002", "B社", "b-site.com")], deps);
    expect(counts).toEqual({ vetted: 1, waiting: 1 });
    expect(await repo.scout.get("s0002")).toBeUndefined();
  });

  it("counts advertisers already registered against the limit", async () => {
    const { repo, deps } = setup(okVet, { maxVets: 5, maxRegistered: 1 });
    await repo.scout.upsert({ programId: "old", brandSlug: "old", state: "active", keyword: "旧", host: "old.com", brandName: "旧", listUrls: [], sourceUrls: [], reasons: [], checkedAt: NOW.toISOString() });
    expect(await registerCandidates([passed("s0001", "A社", "a-site.com")], deps)).toEqual({ waiting: 1 });
  });

  it("takes a slug once within a run", async () => {
    const { deps } = setup();
    const counts = await registerCandidates([passed("s0001", "A社", "same-site.com"), passed("s0002", "A社2", "www.same-site.com")], deps);
    expect(counts).toEqual({ vetted: 1, rejected: 1 });
  });
});

const stored = (overrides: Partial<ScoutedBrand> = {}): ScoutedBrand => ({
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
  checkedAt: "2026-10-20T00:00:00.000Z",
  ...overrides,
});

describe("advanceScouted", () => {
  it("marks an advertiser joined once its link is read, and ended when the program ended", async () => {
    const repo = createMemoryRepository();
    const all = [stored(), stored({ programId: "s0002", brandSlug: "brand-b", state: "active" }), stored({ programId: "s0003", brandSlug: "brand-c", state: "active" })];
    for (const brand of all) await repo.scout.upsert(brand);
    const labels = new Map([
      ["brand-a", "linked"],
      ["brand-b", "ended"],
      ["brand-c", "linked_terms_changed"],
    ]);
    expect(await advanceScouted(repo, all, labels, NOW)).toEqual({ activated: 1, retired: 1 });
    const states = Object.fromEntries((await repo.scout.list()).map((brand) => [brand.brandSlug, brand.state]));
    expect(states).toEqual({ "brand-a": "active", "brand-b": "retired", "brand-c": "active" });
  });

  it("gives up on an advertiser that never joined", async () => {
    const repo = createMemoryRepository();
    const waiting = stored({ checkedAt: "2026-09-01T00:00:00.000Z" });
    const recent = stored({ programId: "s0002", brandSlug: "brand-b", checkedAt: "2026-10-25T00:00:00.000Z" });
    await repo.scout.upsert(waiting);
    await repo.scout.upsert(recent);
    const labels = new Map([
      ["brand-a", "applying"],
      ["brand-b", "applying"],
    ]);
    expect(await advanceScouted(repo, [waiting, recent], labels, NOW)).toEqual({ retired: 1 });
    expect((await repo.scout.get("s0001"))?.state).toBe("retired");
    expect((await repo.scout.get("s0002"))?.state).toBe("vetted");
  });
});

describe("renewScoutedTerms", () => {
  const url = "https://brand-a.com/affiliate/";
  const page = (lines: string[]) => ({ body: `<html><head><title>規約</title></head><body>${lines.map((l) => `<p>${l}</p>`).join("")}</body></html>` });

  it("takes the new fingerprint when the changed rules still allow the site", async () => {
    const repo = createMemoryRepository();
    const brand = stored({ state: "active" });
    await repo.scout.upsert(brand);
    const fetcher = new MapFetcher(new Map([[url, page(["比較サイトは歓迎です。"])]]));
    expect(await renewScoutedTerms(repo, fetcher, [brand], new Map([["brand-a", "changed"]]), NOW)).toEqual({ renewed: 1 });
    expect((await repo.scout.get("s0001"))?.termsSha256).toBe(termsFingerprint("規約\n比較サイトは歓迎です。"));
    expect((await repo.scout.get("s0001"))?.state).toBe("active");
  });

  it("retires an advertiser whose changed rules now keep it out", async () => {
    const repo = createMemoryRepository();
    const brand = stored({ state: "active" });
    await repo.scout.upsert(brand);
    const fetcher = new MapFetcher(new Map([[url, page(["価格の掲載はできません。"])]]));
    expect(await renewScoutedTerms(repo, fetcher, [brand], new Map([["brand-a", "changed"]]), NOW)).toEqual({ retired: 1 });
    const after = await repo.scout.get("s0001");
    expect(after?.state).toBe("retired");
    expect(after?.reasons).toEqual(["restricted_price"]);
  });

  it("leaves everything as it is when the rules cannot be read now, and ignores unchanged ones", async () => {
    const repo = createMemoryRepository();
    const brand = stored({ state: "active" });
    const other = stored({ programId: "s0002", brandSlug: "brand-b" });
    await repo.scout.upsert(brand);
    expect(await renewScoutedTerms(repo, new MapFetcher(new Map()), [brand, other], new Map([["brand-a", "changed"], ["brand-b", "unchanged"]]), NOW)).toEqual({ unreadable: 1 });
    expect((await repo.scout.get("s0001"))?.termsSha256).toBe("a".repeat(64));
  });
});
