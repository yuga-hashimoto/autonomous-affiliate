export interface GrowthPlan {
  pageId: string;
  decision: "HOLD" | "IMPROVE_CTR" | "VERIFY_LINKS" | "KEEP";
  hypothesis: string | null;
  metricBaseline: {
    pageId: string;
    monetizableSessions: number | "UNKNOWN";
    outboundClicks: number | "UNKNOWN";
    outboundCtr: number | "UNKNOWN";
    approvedConversions: number | "UNKNOWN";
    approvedConversionRate: number | "UNKNOWN";
    approvedEpcJpy: number | "UNKNOWN";
    approvedRevenuePer1kSessionsJpy: number | "UNKNOWN";
  };
  reason: string;
}
