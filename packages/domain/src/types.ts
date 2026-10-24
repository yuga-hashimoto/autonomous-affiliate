/**
 * Core cross-package types. These mirror docs/05-data-model.md.
 * All monetary amounts are integers in the currency's smallest common unit
 * (JPY has no minor unit; amounts are whole yen).
 */

export type IsoDateTime = string;

export const VERIFICATION_STATUSES = ["VERIFIED", "UNKNOWN", "INVALID"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const CLAIM_TYPES = [
  "price",
  "contract_term",
  "feature",
  "coverage_area",
  "cancellation",
  "reward",
  "terms",
  "other",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** A primary-source record captured by the source collector (docs/05 `sources`). */
export interface SourceRecord {
  id: string;
  canonicalUrl: string;
  sourceType: "official" | "asp_report" | "regulatory" | "other";
  fetchedAt: IsoDateTime;
  /** sha256 hex of the raw body. */
  hash: string;
  provenance: string;
  contentType: string;
}

/** A structured fact extracted from a source, with provenance (B008). */
export interface Fact {
  id: string;
  text: string;
  claimType: ClaimType;
  sourceIds: string[];
  verifiedAt: IsoDateTime;
  confidence: number;
  verificationStatus: VerificationStatus;
  /** When this fact stops being usable (freshness). */
  expiresAt?: IsoDateTime;
}

export const PROGRAM_STATUSES = ["PENDING", "APPROVED", "REJECTED", "TERMINATED"] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export interface AffiliateProgram {
  id: string;
  provider: string;
  status: ProgramStatus;
  termsUrl?: string;
  termsCheckedAt?: IsoDateTime;
  payoutCurrency: string;
}

export const CHANNELS = ["site", "search", "youtube", "x", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export const OFFER_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export interface AffiliateOffer {
  id: string;
  programId: string;
  verticalId: string;
  title: string;
  landingUrl?: string;
  /** Reference into secret storage; never the tracking URL itself. */
  trackingUrlSecretRef?: string;
  rewardModel: "fixed_jpy" | "rate_percent" | "unknown";
  rewardAmountJpy?: number;
  conversionEvent?: string;
  channelPermissions: Channel[];
  active: boolean;
  status: OfferStatus;
  constraints: Record<string, string | number | boolean>;
}

export const CONVERSION_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELED",
  "PAID",
] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

export interface Conversion {
  id: string;
  programId: string;
  externalEventId?: string;
  offerId?: string;
  occurredAt: IsoDateTime;
  status: ConversionStatus;
  amount?: number;
  currency?: string;
  amountJpy?: number;
}

export interface Payout {
  id: string;
  programId: string;
  paidAt: IsoDateTime;
  currency: string;
  amount: number;
  amountJpy?: number;
  reference?: string;
}

export interface SpendRecord {
  date: string;
  category: "llm" | "api" | "infra" | "other";
  provider: string;
  costJpy: number;
  source: string;
  estimated: boolean;
}

export interface DailyTraffic {
  date: string;
  pageId: string;
  channel: string;
  sessions: number | "UNKNOWN";
  searchClicks: number | "UNKNOWN";
  impressions: number | "UNKNOWN";
}

export interface DailyOutboundClicks {
  date: string;
  pageId: string;
  offerId: string;
  ctaId: string;
  channel: string;
  clicks: number | "UNKNOWN";
}

export const CONTENT_STATES = [
  "DISCOVERED",
  "ELIGIBILITY_CHECKED",
  "RESEARCHED",
  "ANALYZED",
  "DRAFTED",
  "QA_PENDING",
  "APPROVED_AUTOMATICALLY",
  "DEPLOYING",
  "PUBLISHED",
  "MEASURING",
  "UPDATE_CANDIDATE",
  "QUARANTINED",
  "REJECTED",
  "REVOKED",
  "RETRY_SCHEDULED",
  "STOPPED_BUDGET",
] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

export interface ContentItem {
  id: string;
  slug: string;
  locale: string;
  topic: string;
  state: ContentState;
  currentRevision?: string;
  offerIds: string[];
}

export interface ContentRevision {
  id: string;
  itemId: string;
  contentHash: string;
  markdownPath: string;
  qaReportId?: string;
  publishedAt?: IsoDateTime;
  sourceIds: string[];
}

export const QA_STATUSES = ["PASS", "FAIL", "UNKNOWN"] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

export interface QaCheck {
  id: string;
  status: QaStatus;
  detail: string;
}

export interface QualityDecision {
  id: string;
  itemId: string;
  revisionId: string;
  artifactHash: string;
  status: QaStatus;
  checks: QaCheck[];
  policyVersion: string;
  decidedAt: IsoDateTime;
}

export interface Publication {
  id: string;
  itemId: string;
  revisionId: string;
  destination: "preview" | "git" | "pages";
  publicUrl?: string;
  commitSha?: string;
  status: "SUCCEEDED" | "FAILED" | "ROLLED_BACK";
  publishedAt: IsoDateTime;
}

export interface SerpObservation {
  id: string;
  keyword: string;
  capturedAt: IsoDateTime;
  country: "JP";
  language: "ja";
  device: "desktop" | "mobile";
  position: number;
  url: string;
  pageType: "official" | "corporate" | "media" | "personal" | "comparison" | "other";
  serpFeatures: string[];
  accessStatus: "OK" | "UNKNOWN";
}
