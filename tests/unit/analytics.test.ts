import { describe, expect, it } from "vitest";
import {
  buildMonthlyReport,
  computePageKpis,
  formatMetric,
  operatingProfitEstimateJpy,
  prioritizeGrowth,
  renderMonthlyReportMarkdown,
} from "@aff/analytics";
import type { Conversion, DailyOutboundClicks, DailyTraffic, Payout, SpendRecord } from "@aff/domain";

const traffic: DailyTraffic[] = [
  { date: "2026-10-20", pageId: "p1", channel: "search", sessions: 600, searchClicks: 120, impressions: 9000 },
  { date: "2026-10-21", pageId: "p1", channel: "search", sessions: 400, searchClicks: 80, impressions: "UNKNOWN" },
];

const clicks: DailyOutboundClicks[] = [
  { date: "2026-10-20", pageId: "p1", offerId: "o1", ctaId: "cta-main", channel: "site", clicks: 30 },
  { date: "2026-10-21", pageId: "p1", offerId: "o1", ctaId: "cta-main", channel: "site", clicks: 20 },
];

const conversions: Conversion[] = [
  { id: "c1", programId: "p", externalEventId: "e1", offerId: "o1", occurredAt: "2026-10-21T00:00:00Z", status: "APPROVED", amountJpy: 3000 },
  { id: "c2", programId: "p", externalEventId: "e2", offerId: "o1", occurredAt: "2026-10-21T00:00:00Z", status: "PENDING", amountJpy: 3000 },
];

describe("B016 page KPIs", () => {
  it("computes CTR, EPC and per-1k revenue from observed data", () => {
    const kpis = computePageKpis({ pageId: "p1", traffic, clicks, conversions });
    expect(kpis.monetizableSessions).toBe(1000);
    expect(kpis.outboundClicks).toBe(50);
    expect(kpis.outboundCtr).toBeCloseTo(0.05);
    expect(kpis.approvedEpcJpy).toBeCloseTo(3000 / 50);
    expect(kpis.approvedRevenuePer1kSessionsJpy).toBeCloseTo(3000);
  });

  it("returns UNKNOWN when traffic data is missing", () => {
    const kpis = computePageKpis({ pageId: "missing", traffic, clicks, conversions });
    expect(kpis.monetizableSessions).toBe("UNKNOWN");
    expect(kpis.outboundCtr).toBe("UNKNOWN");
  });
});

describe("B016 growth prioritizer", () => {
  it("holds conclusions on insufficient samples", () => {
    const plans = prioritizeGrowth({
      pageIds: ["low"],
      traffic: [{ date: "d", pageId: "low", channel: "search", sessions: 10, searchClicks: 1, impressions: 100 }],
      clicks: [],
      conversions: [],
    });
    expect(plans[0]!.decision).toBe("HOLD");
    expect(plans[0]!.reason).toContain("insufficient");
  });

  it("proposes CTR improvement for low-CTR pages with enough data", () => {
    const plans = prioritizeGrowth({
      pageIds: ["p2"],
      traffic: [{ date: "d", pageId: "p2", channel: "search", sessions: 5000, searchClicks: 500, impressions: 50000 }],
      clicks: [{ date: "d", pageId: "p2", offerId: "o", ctaId: "c", channel: "site", clicks: 40 }],
      conversions: [],
    });
    expect(plans[0]!.decision).toBe("IMPROVE_CTR");
  });
});

describe("B020 monthly report", () => {
  const spend: SpendRecord[] = [
    { date: "2026-10-01", category: "llm", provider: "mock", costJpy: 900, source: "jobs", estimated: true },
    { date: "2026-10-05", category: "infra", provider: "pages", costJpy: 0, source: "cf", estimated: false },
  ];
  const payouts: Payout[] = [
    { id: "pay1", programId: "p", paidAt: "2026-11-01T00:00:00Z", currency: "JPY", amount: 3000 },
  ];

  it("separates approved/pending/paid and never mixes estimates", () => {
    const report = buildMonthlyReport({ yearMonth: "2026-10", conversions, payouts, spend });
    expect(report.confirmed.approvedRevenueJpy).toBe(3000);
    expect(report.confirmed.pendingJpy).toBe(3000);
    expect(report.costs.totalJpy).toBe(900);
    expect(report.operatingProfitEstimateJpy).toBe(3000 - 900);
    expect(report.cashFlowJpy).toBe("UNKNOWN"); // payout is in November
    expect(report.warnings.join("\n")).toContain("NOT counted as revenue");
    expect(report.warnings.join("\n")).toContain("estimates");
  });

  it("renders markdown that labels estimates explicitly", () => {
    const report = buildMonthlyReport({ yearMonth: "2026-10", conversions, payouts: [], spend });
    const md = renderMonthlyReportMarkdown(report);
    expect(md).toContain("NOT revenue");
    expect(md).toContain("not confirmed");
    expect(formatMetric("UNKNOWN")).toBe("UNKNOWN");
  });

  it("computes operating profit estimates independently", () => {
    const profit = operatingProfitEstimateJpy({ conversions, payouts: [], spend });
    expect(profit.approvedRevenueJpy).toBe(3000);
    expect(profit.estimatedCostsJpy).toBe(900);
  });
});
