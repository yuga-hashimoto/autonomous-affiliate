import type { AffiliateOffer, Fact, SourceRecord } from "@aff/domain";
import type { DecisionMatrix, TotalCostCalculation } from "@aff/analysis";

export const AD_DISCLOSURE = "本記事にはプロモーション（PR）を含みます。";

/**
 * Phrases claiming hands-on experience are banned in the MVP (docs/06):
 * the platform never uses the products it writes about.
 */
export const PROHIBITED_HANDS_ON_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /使ってみた/, reason: "claims personal usage (使ってみた)" },
  { pattern: /実際に(使|利)用した/, reason: "claims personal usage (実際に使用した)" },
  { pattern: /試しに?(使|動か)した/, reason: "claims hands-on trial" },
  { pattern: /体験(した|談|レビュー)/, reason: "claims personal experience" },
  { pattern: /実測(した|値|結果)/, reason: "claims personal measurement" },
  { pattern: /レビュー(を書|しました)/, reason: "claims to be a user review" },
  { pattern: /私[はが]利用/, reason: "first-person usage claim" },
];

export interface DraftClaim {
  claimId: string;
  text: string;
  factIds: string[];
  sourceIds: string[];
  claimType: string;
}

export interface Draft {
  slug: string;
  locale: string;
  title: string;
  bodyMarkdown: string;
  claims: DraftClaim[];
  sourceIds: string[];
  offerIds: string[];
  disclosure: string;
  metadata: {
    formulaVersion: string;
    audience: string;
    generatedAt: string;
    assumptions: string[];
    comparisonMonths: number | null;
  };
}

export interface DraftInput {
  slug: string;
  title: string;
  locale?: string;
  audience: string;
  purpose: string;
  facts: Fact[];
  sources: SourceRecord[];
  offers: AffiliateOffer[];
  calculations: TotalCostCalculation[];
  /** Explicit fact links per calculation offer_id. */
  factIdsByOfferId?: Record<string, string[]>;
  matrix?: DecisionMatrix;
  /** Approved+active offers with site permission; CTAs render only for these. */
  ctaOffers: AffiliateOffer[];
  now?: Date;
}

export class DraftRejectedError extends Error {
  constructor(public readonly violations: { line: number; text: string; reason: string }[]) {
    super(`draft rejected: ${violations.length} hands-on/unsupported experience phrases found`);
    this.name = "DraftRejectedError";
  }
}

export function findProhibitedPhrases(body: string): { line: number; text: string; reason: string }[] {
  const violations: { line: number; text: string; reason: string }[] = [];
  const lines = body.split("\n");
  lines.forEach((line, index) => {
    for (const { pattern, reason } of PROHIBITED_HANDS_ON_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ line: index + 1, text: line.trim().slice(0, 120), reason });
      }
    }
  });
  return violations;
}
