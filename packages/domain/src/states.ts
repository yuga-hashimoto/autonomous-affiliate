import type { ContentState } from "./types.js";

/**
 * Article pipeline state machine per docs/04-workflows.md.
 * Transitions are explicit and closed: anything not listed is invalid.
 */
const TRANSITIONS: Readonly<Record<ContentState, readonly ContentState[]>> = {
  DISCOVERED: ["ELIGIBILITY_CHECKED", "QUARANTINED"],
  ELIGIBILITY_CHECKED: ["RESEARCHED", "QUARANTINED", "REJECTED"],
  RESEARCHED: ["ANALYZED", "QUARANTINED", "RETRY_SCHEDULED"],
  ANALYZED: ["DRAFTED", "QUARANTINED", "RETRY_SCHEDULED"],
  DRAFTED: ["QA_PENDING", "QUARANTINED"],
  QA_PENDING: [
    "APPROVED_AUTOMATICALLY",
    "DRAFTED", // repair loop, max attempts enforced by orchestrator
    "REJECTED",
    "QUARANTINED",
    "STOPPED_BUDGET",
  ],
  APPROVED_AUTOMATICALLY: ["DEPLOYING", "STOPPED_BUDGET"],
  DEPLOYING: ["PUBLISHED", "QUARANTINED", "RETRY_SCHEDULED"],
  PUBLISHED: ["MEASURING", "REVOKED"],
  MEASURING: ["UPDATE_CANDIDATE", "REVOKED"],
  UPDATE_CANDIDATE: ["RESEARCHED", "REVOKED"],
  QUARANTINED: ["RESEARCHED"], // only after re-verification succeeds
  REJECTED: ["RESEARCHED"], // a fresh research cycle may restart the article
  REVOKED: ["RESEARCHED"], // returns only through re-research + re-QA
  RETRY_SCHEDULED: ["RESEARCHED", "ANALYZED", "DEPLOYING"], // transient failure retry entry points
  STOPPED_BUDGET: ["QA_PENDING"], // resume within a new budget period
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ContentState,
    public readonly to: ContentState,
  ) {
    super(`invalid content state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: ContentState, to: ContentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: ContentState, to: ContentState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function allowedTransitions(from: ContentState): readonly ContentState[] {
  return TRANSITIONS[from] ?? [];
}

/** Terminal-ish states from which the MVP cannot proceed without external change. */
export const BLOCKING_STATES: readonly ContentState[] = ["QUARANTINED", "REJECTED"];

// ---- Job run state machine (docs/04 retry / dead letter) ----

export const JOB_STATES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "RETRY_SCHEDULED",
  "DEAD_LETTER",
  "CANCELED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  PENDING: ["RUNNING", "CANCELED"],
  RUNNING: ["SUCCEEDED", "RETRY_SCHEDULED", "DEAD_LETTER", "CANCELED"],
  RETRY_SCHEDULED: ["RUNNING", "DEAD_LETTER", "CANCELED"],
  SUCCEEDED: [],
  DEAD_LETTER: [],
  CANCELED: [],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertJobTransition(from: JobState, to: JobState): void {
  if (!canTransitionJob(from, to)) {
    throw new InvalidTransitionError(from as unknown as ContentState, to as unknown as ContentState);
  }
}
