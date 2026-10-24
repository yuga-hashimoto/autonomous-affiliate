import { describe, expect, it } from "vitest";
import {
  AllowlistViolationError,
  AspReportImporter,
  DomainAllowlist,
  MapFetcher,
  MockGa4Adapter,
  MockSearchConsoleAdapter,
  SourceCollector,
  SourceUnavailableError,
  DisabledDistributionAdapter,
  ApiGrantedDistributionAdapter,
  canonicalizeUrl,
  createFreshnessPolicy,
} from "@aff/integrations";
import { createMemoryRepository } from "@aff/db";
import { parsePolicyText, readFileSync } from "./helpers.js";

const policy = parsePolicyText(
  readFileSync(new URL("../../config/policy.example.yaml", import.meta.url), "utf8"),
);

describe("canonical URL", () => {
  it("strips tracking params, sorts query, forces https", () => {
    expect(
      canonicalizeUrl(
        "http://Example.com:443/path/?utm_source=x&b=2&a=1&fbclid=zz#section",
      ),
    ).toBe("https://example.com/path?a=1&b=2");
  });
});

describe("B006 source collector", () => {
  it("rejects hosts outside the allowlist before any network access", async () => {
    const repo = createMemoryRepository();
    const fetcher = new MapFetcher(new Map());
    const collector = new SourceCollector(
      fetcher,
      new DomainAllowlist(["example.com"]),
      repo.sources,
    );
    await expect(collector.collect("https://evil.example.org/page")).rejects.toBeInstanceOf(
      AllowlistViolationError,
    );
    expect(await repo.sources.list()).toHaveLength(0);
  });

  it("fails closed when the allowlist is empty", async () => {
    const repo = createMemoryRepository();
    const collector = new SourceCollector(
      new MapFetcher(new Map()),
      new DomainAllowlist(policy.security.allowed_source_domains),
      repo.sources,
    );
    await expect(collector.collect("https://example.com")).rejects.toBeInstanceOf(
      AllowlistViolationError,
    );
  });

  it("stores canonical URL, checksum and fetched_at for official pages", async () => {
    const repo = createMemoryRepository();
    const body = "<html><body>月額 2,980円（20GB）</body></html>";
    const collector = new SourceCollector(
      new MapFetcher(new Map([["https://provider.example.com/price", { body }]])),
      new DomainAllowlist(["provider.example.com"]),
      repo.sources,
    );
    const { record } = await collector.collect("https://provider.example.com/price?utm_source=x");
    expect(record.canonicalUrl).toBe("https://provider.example.com/price");
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(record.fetchedAt).getTime()).toBeLessThanOrEqual(Date.now());
    const latest = await repo.sources.getLatestByUrl("https://provider.example.com/price");
    expect(latest?.hash).toBe(record.hash);
  });

  it("raises SourceUnavailableError for HTTP failures so claims become UNKNOWN", async () => {
    const repo = createMemoryRepository();
    const collector = new SourceCollector(
      new MapFetcher(new Map()),
      new DomainAllowlist(["provider.example.com"]),
      repo.sources,
    );
    await expect(collector.collect("https://provider.example.com/missing")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });
});

describe("freshness policy (docs/06)", () => {
  const freshness = createFreshnessPolicy(policy);
  const now = new Date("2026-10-24T00:00:00Z");

  it("accepts fresh verified price facts", () => {
    expect(
      freshness.isFactUsable(
        {
          id: "f1",
          text: "月額2980円",
          claimType: "price",
          sourceIds: ["s1"],
          verifiedAt: "2026-10-20T00:00:00Z",
          confidence: 1,
          verificationStatus: "VERIFIED",
        },
        now,
      ),
    ).toBe(true);
  });

  it("expires price facts older than 7 days", () => {
    expect(
      freshness.isFactUsable(
        {
          id: "f2",
          text: "月額2980円",
          claimType: "price",
          sourceIds: ["s1"],
          verifiedAt: "2026-10-10T00:00:00Z",
          confidence: 1,
          verificationStatus: "VERIFIED",
        },
        now,
      ),
    ).toBe(false);
  });

  it("never accepts UNKNOWN or INVALID facts", () => {
    expect(
      freshness.isFactUsable(
        {
          id: "f3",
          text: "?",
          claimType: "price",
          sourceIds: [],
          verifiedAt: now.toISOString(),
          confidence: 0,
          verificationStatus: "UNKNOWN",
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("B015 ASP report import", () => {
  it("imports rows, keeps PENDING/APPROVED/PAID distinct, dedupes events", async () => {
    const repo = createMemoryRepository();
    await repo.offers.upsertProgram({ id: "p1", provider: "a8", status: "APPROVED", payoutCurrency: "JPY" });
    await repo.offers.upsertOffer({
      id: "o1",
      programId: "p1",
      verticalId: "mobile",
      title: "SIM A",
      rewardModel: "fixed_jpy",
      rewardAmountJpy: 3000,
      channelPermissions: ["site"],
      active: true,
      status: "APPROVED",
      constraints: {},
    });
    const importer = new AspReportImporter(repo.offers);
    const csv = [
      "program_id,external_event_id,offer_id,occurred_at,status,amount,currency",
      "p1,e1,o1,2026-10-20T00:00:00Z,PENDING,3000,JPY",
      "p1,e2,o1,2026-10-20T00:00:00Z,APPROVED,3000,JPY",
      "p1,e3,o1,2026-10-20T00:00:00Z,PAID,3000,JPY",
      "p1,e1,o1,2026-10-20T00:00:00Z,PENDING,3000,JPY",
      "unknown,e9,,2026-10-20T00:00:00Z,APPROVED,3000,JPY",
    ].join("\n");
    const result = await importer.importCsv(csv);
    expect(result.imported).toBe(3);
    expect(result.duplicates).toBe(1);
    expect(result.skipped).toBe(1);
    const conversions = await repo.offers.listConversions();
    const statuses = new Set(conversions.map((c) => c.status));
    expect(statuses).toEqual(new Set(["PENDING", "APPROVED", "PAID"]));
  });
});

describe("B014 analytics mock adapters", () => {
  it("reports UNKNOWN instead of zero when data is missing", async () => {
    const gsc = new MockSearchConsoleAdapter(
      new Map([["2026-10-23", new Map([["p1", { clicks: 12, impressions: 900 }]])]]),
    );
    const missing = await gsc.fetchDaily("2026-10-24");
    expect(missing[0]!.searchClicks).toBe("UNKNOWN");

    const ga4 = new MockGa4Adapter(new Map());
    const ga4Missing = await ga4.fetchDaily("2026-10-24");
    expect(ga4Missing[0]!.sessions).toBe("UNKNOWN");
  });
});

describe("B019/B022 distribution adapters", () => {
  it("skips when disabled and never fabricates posts", async () => {
    const yt = new DisabledDistributionAdapter("youtube");
    const outcome = await yt.publish({
      pageId: "p1",
      title: "t",
      summary: "s",
      url: "https://site.example.com/p1",
      disclosure: "PR",
    });
    expect(outcome).toEqual({ status: "SKIPPED", reason: expect.stringContaining("disabled") });
  });

  it("publishes only with disclosure when an API grant is wired", async () => {
    const x = new ApiGrantedDistributionAdapter("x", async () => ({ id: "x-1" }));
    const ok = await x.publish({ pageId: "p", title: "t", summary: "s", url: "https://s.example.com", disclosure: "PR" });
    expect(ok).toEqual({ status: "PUBLISHED", externalId: "x-1" });
    const skipped = await x.publish({ pageId: "p", title: "t", summary: "s", url: "https://s.example.com", disclosure: "" });
    expect(skipped.status).toBe("SKIPPED");
  });
});
