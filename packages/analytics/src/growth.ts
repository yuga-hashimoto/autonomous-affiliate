import type { GrowthPlan } from "./types.js";
import { computePageKpis, type Metric, type PageKpis } from "./kpi.js";

export interface GrowthPrioritizerOptions {
  /** Minimum monetizable sessions before any conclusion is allowed. */
  minSessions: number;
  /** Minimum outbound clicks before CTR/conversion conclusions. */
  minClicks: number;
}

const DEFAULTS: GrowthPrioritizerOptions = { minSessions: 100, minClicks: 10 };

/**
 * B016: ranks pages for improvement. With insufficient samples the agent must
 * hold its conclusion (docs/10: continue collecting samples when data is insufficient).
 */
export function prioritizeGrowth(input: {
  pageIds: string[];
  traffic: Parameters<typeof computePageKpis>[0]["traffic"];
  clicks: Parameters<typeof computePageKpis>[0]["clicks"];
  conversions: Parameters<typeof computePageKpis>[0]["conversions"];
  options?: Partial<GrowthPrioritizerOptions>;
}): GrowthPlan[] {
  const options = { ...DEFAULTS, ...input.options };
  const plans: GrowthPlan[] = [];
  for (const pageId of input.pageIds) {
    const kpis: PageKpis = computePageKpis({ pageId, traffic: input.traffic, clicks: input.clicks, conversions: input.conversions });
    const sessions = kpis.monetizableSessions;
    if (sessions === "UNKNOWN" || sessions < options.minSessions) {
      plans.push({
        pageId,
        decision: "HOLD",
        hypothesis: null,
        metricBaseline: kpis,
        reason:
          sessions === "UNKNOWN"
            ? "traffic data is UNKNOWN; growth conclusions are held"
            : `only ${sessions} sessions observed (< ${options.minSessions}); sample insufficient`,
      });
      continue;
    }
    const clicks = kpis.outboundClicks;
    if (clicks === "UNKNOWN" || clicks < options.minClicks) {
      plans.push({
        pageId,
        decision: "HOLD",
        hypothesis: null,
        metricBaseline: kpis,
        reason: `only ${clicks === "UNKNOWN" ? "UNKNOWN" : clicks} outbound clicks observed (< ${options.minClicks}); sample insufficient`,
      });
      continue;
    }
    const ctr = kpis.outboundCtr as number;
    const epc = kpis.approvedEpcJpy;
    if (ctr < 0.02) {
      plans.push({
        pageId,
        decision: "IMPROVE_CTR",
        hypothesis: "CTA placement or comparison-table relevance is weak",
        metricBaseline: kpis,
        reason: `outbound CTR ${(ctr * 100).toFixed(2)}% is below the 2% guide; review CTA placement and table fit`,
      });
      continue;
    }
    if (epc !== "UNKNOWN" && epc === 0) {
      plans.push({
        pageId,
        decision: "VERIFY_LINKS",
        hypothesis: "clicks are not converting; tracking or offer fit may be broken",
        metricBaseline: kpis,
        reason: "clicks observed but zero approved conversions; verify link validity, conversion conditions and landing match",
      });
      continue;
    }
    plans.push({
      pageId,
      decision: "KEEP",
      hypothesis: null,
      metricBaseline: kpis,
      reason: `CTR ${(ctr * 100).toFixed(2)}% and EPC ${epc === "UNKNOWN" ? "UNKNOWN" : `${epc.toFixed(1)} JPY`} within expected range`,
    });
  }
  const order = { IMPROVE_CTR: 0, VERIFY_LINKS: 1, KEEP: 2, HOLD: 3 } as const;
  return plans.sort((a, b) => order[a.decision] - order[b.decision]);
}

export function formatMetric(value: Metric, unit = ""): string {
  return value === "UNKNOWN" ? "UNKNOWN" : `${value.toLocaleString("ja-JP")}${unit}`;
}
