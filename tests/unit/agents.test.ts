import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { createLogger, parsePolicyText, type AffiliateOffer, type SerpObservation } from "@aff/domain";
import { refreshSweep, screenCandidates } from "@aff/agents";
import { readFileSync } from "node:fs";

const policy = parsePolicyText(
  readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"),
);
const now = new Date("2026-10-24T00:00:00Z");

function offer(overrides: Partial<AffiliateOffer> = {}): AffiliateOffer {
  return {
    id: "offer-1",
    programId: "prog-1",
    verticalId: "mobile",
    title: "SIM A",
    rewardModel: "fixed_jpy",
    rewardAmountJpy: 3000,
    channelPermissions: ["site"],
    active: true,
    status: "APPROVED",
    constraints: {},
    ...overrides,
  };
}

function serp(position: number, pageType: SerpObservation["pageType"]): SerpObservation {
  return {
    id: `s${position}`,
    keyword: "k",
    capturedAt: now.toISOString(),
    country: "JP",
    language: "ja",
    device: "mobile",
    position,
    url: `https://r${position}.example.com`,
    pageType,
    serpFeatures: [],
    accessStatus: "OK",
  };
}

describe("B017 refresh sweep", () => {
  it("moves published content with expired prices to UPDATE_CANDIDATE", async () => {
    const repo = createMemoryRepository();
    const item = await repo.content.createIfNotExists({ slug: "a", locale: "ja-JP", topic: "mobile" });
    await repo.content.updateState(item.id, "PUBLISHED");
    const source = {
      id: "src-1",
      canonicalUrl: "https://sim-a.example.com/price",
      sourceType: "official" as const,
      fetchedAt: "2026-01-01T00:00:00Z", // stale for price (7 days)
      hash: "x",
      provenance: "t",
      contentType: "text/html",
    };
    await repo.sources.save(source);
    await repo.facts.save({
      id: "f1",
      text: "price",
      claimType: "price",
      sourceIds: ["src-1"],
      verifiedAt: "2026-01-01T00:00:00Z",
      confidence: 1,
      verificationStatus: "VERIFIED",
    });
    await repo.content.saveRevision({
      id: "rev-1",
      itemId: item.id,
      contentHash: "h",
      markdownPath: "m",
      sourceIds: ["src-1"],
    });
    const result = await refreshSweep(repo, policy, now);
    expect(result.updateCandidates).toEqual(["a"]);
    const updated = await repo.content.get(item.id);
    expect(updated?.state).toBe("UPDATE_CANDIDATE");
  });

  it("revokes content with INVALID facts", async () => {
    const repo = createMemoryRepository();
    const item = await repo.content.createIfNotExists({ slug: "b", locale: "ja-JP", topic: "mobile" });
    await repo.content.updateState(item.id, "PUBLISHED");
    const source = {
      id: "src-2",
      canonicalUrl: "https://sim-b.example.com/price",
      sourceType: "official" as const,
      fetchedAt: now.toISOString(),
      hash: "y",
      provenance: "t",
      contentType: "text/html",
    };
    await repo.sources.save(source);
    await repo.facts.save({
      id: "f2",
      text: "price changed",
      claimType: "price",
      sourceIds: ["src-2"],
      verifiedAt: now.toISOString(),
      confidence: 1,
      verificationStatus: "INVALID",
    });
    await repo.content.saveRevision({
      id: "rev-2",
      itemId: item.id,
      contentHash: "h2",
      markdownPath: "m",
      sourceIds: ["src-2"],
    });
    const result = await refreshSweep(repo, policy, now);
    expect(result.revoked).toEqual(["b"]);
  });

  it("leaves fresh content alone", async () => {
    const repo = createMemoryRepository();
    const item = await repo.content.createIfNotExists({ slug: "c", locale: "ja-JP", topic: "mobile" });
    await repo.content.updateState(item.id, "PUBLISHED");
    await repo.sources.save({
      id: "src-3",
      canonicalUrl: "https://x.example.com",
      sourceType: "official",
      fetchedAt: now.toISOString(),
      hash: "z",
      provenance: "t",
      contentType: "text/html",
    });
    await repo.facts.save({
      id: "f3",
      text: "price",
      claimType: "price",
      sourceIds: ["src-3"],
      verifiedAt: now.toISOString(),
      confidence: 1,
      verificationStatus: "VERIFIED",
    });
    await repo.content.saveRevision({
      id: "rev-3",
      itemId: item.id,
      contentHash: "h3",
      markdownPath: "m",
      sourceIds: ["src-3"],
    });
    const result = await refreshSweep(repo, policy, now);
    expect(result.updateCandidates).toHaveLength(0);
    expect(result.revoked).toHaveLength(0);
  });
});

describe("B000A-C cross-vertical screening", () => {
  it("ranks candidates and never privileges AI/SaaS", () => {
    const ranked = screenCandidates([
      {
        verticalId: "saas",
        keyword: "saas tool comparison",
        offers: [],
        demand: { score: "UNKNOWN", evidence: [] },
        friction: { score: "UNKNOWN", evidence: [] },
        monetization: { score: "UNKNOWN", evidence: [] },
        autonomy: { score: 5, evidence: ["official docs exist"] },
      },
      {
        verticalId: "mobile",
        keyword: "20GB SIM comparison",
        offers: [offer()],
        serpObservations: [serp(1, "official"), serp(2, "media"), serp(3, "media"), serp(4, "corporate"), serp(5, "official")],
        demand: { score: 7, evidence: ["keyword data"] },
        friction: { score: 8, evidence: ["online application"] },
        monetization: { score: 6, evidence: ["approved program"] },
        autonomy: { score: 8, evidence: ["complete official price pages"] },
      },
    ]);
    // SaaS has an UNKNOWN score so it cannot outrank an evidenced candidate.
    expect(ranked[0]!.verticalId).toBe("mobile");
    expect(ranked[1]!.score.weightedTotal).toBe("UNKNOWN");
    expect(ranked[0]!.eligible).toBe(true);
    expect(ranked[1]!.ineligibilityReasons).toContain("no_offers_registered");
  });

  it("marks candidates with unapproved offers as non-monetizable but scorable", () => {
    const ranked = screenCandidates([
      {
        verticalId: "fiber",
        keyword: "fiber mansion",
        offers: [offer({ status: "PENDING", active: false })],
        demand: { score: 6, evidence: ["x"] },
        friction: { score: 6, evidence: ["x"] },
        monetization: { score: "UNKNOWN", evidence: [] },
        autonomy: { score: 7, evidence: ["x"] },
      },
    ]);
    expect(ranked[0]!.monetizableOffers).toHaveLength(0);
    expect(ranked[0]!.ineligibilityReasons).toContain("offers_not_approved_or_active");
    expect(ranked[0]!.score.weightedTotal).toBe("UNKNOWN");
  });

  it("flags missing SERP capture", () => {
    const ranked = screenCandidates([
      {
        verticalId: "buyback",
        keyword: "game buyback",
        offers: [offer()],
        demand: { score: 5, evidence: [] },
        friction: { score: 5, evidence: [] },
        monetization: { score: 5, evidence: [] },
        autonomy: { score: 5, evidence: [] },
      },
    ]);
    expect(ranked[0]!.ineligibilityReasons).toContain("serp_not_captured");
  });
});

describe("growth agent wiring", () => {
  it("returns HOLD plans when repository metrics are empty", async () => {
    const repo = createMemoryRepository();
    const item = await repo.content.createIfNotExists({ slug: "g", locale: "ja-JP", topic: "mobile" });
    const { growthPlan } = await import("@aff/agents");
    const plans = await growthPlan(repo, [item.id]);
    expect(plans[0]!.decision).toBe("HOLD");
  });

  it("logger helper is available with redaction", () => {
    const log = createLogger({ sink: () => undefined });
    expect(log.traceId).toMatch(/[0-9a-f-]{36}/);
  });
});
