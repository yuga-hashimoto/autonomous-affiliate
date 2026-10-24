import type { DailyOutboundClicks, DailyTraffic } from "@aff/domain";

export type MetricValue = number | "UNKNOWN";

export interface DailyPageMetrics {
  pageId: string;
  date: string;
  sessions: MetricValue;
  searchClicks: MetricValue;
  impressions: MetricValue;
}

/**
 * B014: read-only adapters. Live credentials are optional; without them the
 * mock adapters report UNKNOWN instead of inventing zeros (docs/08).
 */
export interface SearchConsoleAdapter {
  readonly configured: boolean;
  fetchDaily(date: string): Promise<DailyTraffic[]>;
}

export interface Ga4Adapter {
  readonly configured: boolean;
  fetchDaily(date: string): Promise<DailyTraffic[]>;
}

function row(pageId: string, date: string, sessions: MetricValue, searchClicks: MetricValue, impressions: MetricValue): DailyTraffic {
  return { date, pageId, channel: "search", sessions, searchClicks, impressions };
}

export class MockSearchConsoleAdapter implements SearchConsoleAdapter {
  readonly configured = true;

  constructor(private readonly fixtures: Map<string, Map<string, { clicks: number; impressions: number }>>) {}

  async fetchDaily(date: string): Promise<DailyTraffic[]> {
    const pages = this.fixtures.get(date);
    if (!pages) {
      // Missing data must never become 0 (docs/11 B014 DoD).
      return [row("UNKNOWN_PAGE", date, "UNKNOWN", "UNKNOWN", "UNKNOWN")];
    }
    return [...pages.entries()].map(([pageId, v]) =>
      row(pageId, date, "UNKNOWN", v.clicks, v.impressions),
    );
  }
}

export class UnconfiguredSearchConsoleAdapter implements SearchConsoleAdapter {
  readonly configured = false;

  async fetchDaily(date: string): Promise<DailyTraffic[]> {
    return [row("UNKNOWN_PAGE", date, "UNKNOWN", "UNKNOWN", "UNKNOWN")];
  }
}

export class MockGa4Adapter implements Ga4Adapter {
  readonly configured = true;

  constructor(private readonly fixtures: Map<string, Map<string, number>>) {}

  async fetchDaily(date: string): Promise<DailyTraffic[]> {
    const pages = this.fixtures.get(date);
    if (!pages) {
      return [{ date, pageId: "UNKNOWN_PAGE", channel: "search", sessions: "UNKNOWN", searchClicks: "UNKNOWN", impressions: "UNKNOWN" }];
    }
    return [...pages.entries()].map(([pageId, sessions]) => ({
      date,
      pageId,
      channel: "search",
      sessions,
      searchClicks: "UNKNOWN" as const,
      impressions: "UNKNOWN" as const,
    }));
  }
}

export class UnconfiguredGa4Adapter implements Ga4Adapter {
  readonly configured = false;

  async fetchDaily(date: string): Promise<DailyTraffic[]> {
    return [{ date, pageId: "UNKNOWN_PAGE", channel: "search", sessions: "UNKNOWN", searchClicks: "UNKNOWN", impressions: "UNKNOWN" }];
  }
}

export interface CtaClickFixture {
  date: string;
  pageId: string;
  offerId: string;
  ctaId: string;
  clicks: number;
}

export function outboundClicksFromFixtures(fixtures: CtaClickFixture[]): DailyOutboundClicks[] {
  return fixtures.map((f) => ({ ...f, channel: "site" }));
}
