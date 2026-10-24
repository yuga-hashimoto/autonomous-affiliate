import type { AffiliateOffer, SerpObservation } from "@aff/domain";
import {
  competitionGaps,
  scoreOpportunity,
  type OpportunityScore,
  type OpportunityScoringInputs,
} from "@aff/analysis";

export interface CandidateVertical {
  verticalId: string;
  keyword: string;
  offers: AffiliateOffer[];
  serpObservations?: SerpObservation[];
  /** Dimension scores with evidence; UNKNOWN stays UNKNOWN (docs/15). */
  demand: OpportunityScoringInputs["demand"];
  friction: OpportunityScoringInputs["friction"];
  monetization: OpportunityScoringInputs["monetization"];
  autonomy: OpportunityScoringInputs["autonomy"];
}

export interface RankedCandidate {
  verticalId: string;
  keyword: string;
  score: OpportunityScore;
  competitionGap: ReturnType<typeof competitionGaps>;
  /** Only offers a monetizable CTA could use (approved, active). */
  monetizableOffers: AffiliateOffer[];
  eligible: boolean;
  ineligibilityReasons: string[];
}

/**
 * B000A/B000B/B000C: cross-vertical screening. Ranks candidates without
 * privileging any niche; unapproved offers can make a candidate
 * non-monetizable but the informative article may still be drafted.
 */
export function screenCandidates(candidates: CandidateVertical[]): RankedCandidate[] {
  const ranked: RankedCandidate[] = candidates.map((c) => {
    const competitionGap = competitionGaps(c.serpObservations ?? []);
    const competitionScore = competitionGap.comparisonShare === "UNKNOWN"
      ? "UNKNOWN"
      : competitionGap.comparisonShare < 0.3
        ? 8
        : 4;
    const score = scoreOpportunity({
      verticalId: c.verticalId,
      keyword: c.keyword,
      demand: c.demand,
      competition: { score: competitionScore, evidence: [competitionGap.gapNote] },
      friction: c.friction,
      monetization: c.monetization,
      autonomy: c.autonomy,
      serpObservations: c.serpObservations,
    });
    const monetizableOffers = c.offers.filter(
      (o) => o.active && o.status === "APPROVED" && o.channelPermissions.includes("site"),
    );
    const ineligibilityReasons: string[] = [];
    if (c.offers.length === 0) ineligibilityReasons.push("no_offers_registered");
    if (monetizableOffers.length === 0 && c.offers.length > 0) {
      ineligibilityReasons.push("offers_not_approved_or_active");
    }
    if (!c.serpObservations || c.serpObservations.length === 0) {
      ineligibilityReasons.push("serp_not_captured");
    }
    return {
      verticalId: c.verticalId,
      keyword: c.keyword,
      score,
      competitionGap,
      monetizableOffers,
      eligible: ineligibilityReasons.length === 0,
      ineligibilityReasons,
    };
  });
  const rankOrder = (r: RankedCandidate): number =>
    r.score.weightedTotal === "UNKNOWN" ? -1 : r.score.weightedTotal;
  return ranked.sort((a, b) => rankOrder(b) - rankOrder(a));
}
