import type { JobState } from "@aff/domain";

export interface JobRunRecord {
  id: string;
  /** task_kind + target_entity + source_version + policy_version (docs/04). */
  jobKey: string;
  jobType: string;
  state: JobState;
  attempt: number;
  payload: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  traceId: string;
  costJpy: number;
  lastError?: string;
  runAfter: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobRunEnqueueInput {
  jobKey: string;
  jobType: string;
  payload?: Record<string, unknown>;
  traceId: string;
  runAfter?: string;
}
