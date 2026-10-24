import type { Conversion, DailyOutboundClicks, DailyTraffic, Payout, SpendRecord } from "@aff/domain";

export type Metric = number | "UNKNOWN";

export interface PageKpis {
  pageId: string;
  monetizableSessions: Metric;
  outboundClicks: Metric;
  outboundCtr: Metric;
  approvedConversions: Metric;
  approvedConversionRate: Metric;
  approvedEpcJpy: Metric;
  approvedRevenuePer1kSessionsJpy: Metric;
}

/**
 * KPI formulas per docs/08. Anything without observed data returns UNKNOWN —
 * never 0, never an invented rate.
 */
export function computePageKpis(input: {
  pageId: string;
  traffic: DailyTraffic[];
  clicks: DailyOutboundClicks[];
  conversions: Conversion[];
}): PageKpis {
  const traffic = input.traffic.filter((t) => t.pageId === input.pageId);
  const clicks = input.clicks.filter((c) => c.pageId === input.pageId);
  const sessions: Metric =
    traffic.length === 0
      ? "UNKNOWN"
      : traffic.some((t) => t.sessions === "UNKNOWN")
        ? "UNKNOWN"
        : traffic.reduce((acc, t) => acc + (t.sessions as number), 0);

  const clicksKnown = clicks.length > 0 && clicks.every((c) => c.clicks !== "UNKNOWN");
  const outboundClicks: Metric = clicksKnown ? clicks.reduce((acc, c) => acc + (c.clicks as number), 0) : "UNKNOWN";

  // Conversions cannot be attributed per page unless the offer linkage exists;
  // count only conversions tied to offers referenced by this page's CTA clicks.
  const pageOfferIds = new Set(clicks.map((c) => c.offerId));
  const attributed = input.conversions.filter((c) => c.offerId && pageOfferIds.has(c.offerId));
  const approved = attributed.filter((c) => c.status === "APPROVED" || c.status === "PAID");
  const approvedRevenue = approved.reduce((acc, c) => acc + (c.amountJpy ?? c.amount ?? 0), 0);

  const outboundCtr: Metric =
    sessions === "UNKNOWN" || outboundClicks === "UNKNOWN" ? "UNKNOWN" : outboundClicks / sessions;
  const approvedConversionRate: Metric =
    outboundClicks === "UNKNOWN" ? "UNKNOWN" : outboundClicks === 0 ? "UNKNOWN" : approved.length / outboundClicks;
  const approvedEpcJpy: Metric =
    outboundClicks === "UNKNOWN" ? "UNKNOWN" : outboundClicks === 0 ? "UNKNOWN" : approvedRevenue / outboundClicks;
  const approvedRevenuePer1kSessionsJpy: Metric =
    sessions === "UNKNOWN" ? "UNKNOWN" : (approvedRevenue / Math.max(1, sessions)) * 1000;

  return {
    pageId: input.pageId,
    monetizableSessions: sessions,
    outboundClicks,
    outboundCtr,
    approvedConversions: approved.length,
    approvedConversionRate,
    approvedEpcJpy,
    approvedRevenuePer1kSessionsJpy,
  };
}

export function operatingProfitEstimateJpy(input: {
  conversions: Conversion[];
  payouts: Payout[];
  spend: SpendRecord[];
}): { approvedRevenueJpy: number; cashFlowJpy: Metric; estimatedCostsJpy: number; operatingProfitJpy: number } {
  const approvedRevenueJpy = input.conversions
    .filter((c) => c.status === "APPROVED")
    .reduce((acc, c) => acc + (c.amountJpy ?? c.amount ?? 0), 0);
  const cashIn = input.payouts.reduce((acc, p) => acc + (p.amountJpy ?? p.amount ?? 0), 0);
  const estimatedCostsJpy = input.spend.reduce((acc, s) => acc + s.costJpy, 0);
  return {
    approvedRevenueJpy,
    cashFlowJpy: input.payouts.length === 0 ? "UNKNOWN" : cashIn - estimatedCostsJpy,
    estimatedCostsJpy,
    operatingProfitJpy: approvedRevenueJpy - estimatedCostsJpy,
  };
}
