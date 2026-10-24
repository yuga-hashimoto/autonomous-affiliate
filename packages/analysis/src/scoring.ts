import type { SerpObservation } from "@aff/domain";
import type { Known } from "./types.js";

export const SCORING_WEIGHTS = {
  demand: 0.2,
  competition: 0.2,
  friction: 0.2,
  monetization: 0.25,
  autonomy: 0.15,
} as const;

export type DimensionId = keyof typeof SCORING_WEIGHTS;

export interface DimensionInput {
  /** 0..10; "UNKNOWN" when no external evidence exists. */
  score: Known<number>;
  evidence: string[];
}

export interface DimensionResult {
  id: DimensionId;
  weight: number;
  score: Known<number>;
  evidence: string[];
}

export interface OpportunityScore {
  verticalId: string;
  keyword: string;
  dimensions: DimensionResult[];
  /** UNKNOWN whenever any dimension is UNKNOWN — unknown items are not counted as 0 points (docs/15). */
  weightedTotal: Known<number>;
  evidenceCoverage: number;
  notes: string[];
}

export interface OpportunityScoringInputs {
  verticalId: string;
  keyword: string;
  demand: DimensionInput;
  competition: DimensionInput;
  friction: DimensionInput;
  monetization: DimensionInput;
  autonomy: DimensionInput;
  serpObservations?: SerpObservation[];
}

/**
 * B000C: pre-evaluation only. The result is a hypothesis with explicit
 * evidence coverage, never a measured performance claim. Search-volume/CVR
 * numbers that were never observed stay UNKNOWN upstream.
 */
export function scoreOpportunity(inputs: OpportunityScoringInputs): OpportunityScore {
  const raw: [DimensionId, DimensionInput][] = [
    ["demand", inputs.demand],
    ["competition", inputs.competition],
    ["friction", inputs.friction],
    ["monetization", inputs.monetization],
    ["autonomy", inputs.autonomy],
  ];
  const dimensions: DimensionResult[] = raw.map(([id, input]) => ({
    id,
    weight: SCORING_WEIGHTS[id],
    score: input.score === "UNKNOWN" ? "UNKNOWN" : Math.min(10, Math.max(0, input.score)),
    evidence: input.evidence,
  }));

  const unknowns = dimensions.filter((d) => d.score === "UNKNOWN");
  const weightedTotal: Known<number> =
    unknowns.length > 0
      ? "UNKNOWN"
      : dimensions.reduce((sum, d) => sum + (d.score as number) * d.weight, 0);

  const totalEvidence = dimensions.reduce((n, d) => n + d.evidence.length, 0);
  const maxEvidence = dimensions.length;
  const evidenceCoverage = totalEvidence / maxEvidence;

  const notes: string[] = [
    "this score is a pre-evaluation with assumed weights; it is not a measured result",
  ];
  if (inputs.serpObservations) {
    const ok = inputs.serpObservations.filter((o) => o.accessStatus === "OK");
    notes.push(
      `SERP observations attached: ${ok.length}/${inputs.serpObservations.length} accessible (country=JP, language=ja)`,
    );
  }
  for (const d of unknowns) {
    notes.push(`${d.id}: UNKNOWN — treated as UNKNOWN, not as 0 points`);
  }

  return {
    verticalId: inputs.verticalId,
    keyword: inputs.keyword,
    dimensions,
    weightedTotal,
    evidenceCoverage,
    notes,
  };
}

/** Simple SERP gap detection: how many top-10 results look like comparison pages. */
export function competitionGaps(observations: SerpObservation[]): {
  accessible: number;
  comparisonShare: Known<number>;
  officialShare: Known<number>;
  gapNote: string;
} {
  const ok = observations.filter((o) => o.accessStatus === "OK");
  if (ok.length === 0) {
    return {
      accessible: 0,
      comparisonShare: "UNKNOWN",
      officialShare: "UNKNOWN",
      gapNote: "SERP could not be captured; competition level is UNKNOWN",
    };
  }
  const comparison = ok.filter((o) => o.pageType === "comparison").length;
  const official = ok.filter((o) => o.pageType === "official").length;
  return {
    accessible: ok.length,
    comparisonShare: comparison / ok.length,
    officialShare: official / ok.length,
    gapNote:
      comparison / ok.length < 0.3
        ? "few comparison pages in the top results: differentiation opportunity"
        : "comparison pages dominate the top results: entry requires a distinct angle",
  };
}
