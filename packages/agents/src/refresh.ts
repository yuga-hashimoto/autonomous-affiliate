import { isLiveState, type Fact, type PolicyConfig, type ContentState } from "@aff/domain";
import type { Repository } from "@aff/db";
import { createFreshnessPolicy } from "@aff/integrations";
import { prioritizeGrowth } from "@aff/analytics";
import { transition } from "./pipeline-support.js";
import type { GrowthPlan } from "@aff/analytics";

/**
 * B017: freshness patrol. Published content whose facts expired is moved to
 * UPDATE_CANDIDATE (the update path, update.ts, regenerates it); content with
 * INVALID facts is revoked until re-verification passes.
 *
 * Staleness is judged from the revision that is live (`currentRevision`), so a
 * candidate that never went live cannot hide an expired article.
 */
export async function refreshSweep(
  repo: Repository,
  policy: PolicyConfig,
  now: Date,
): Promise<{ updateCandidates: string[]; revoked: string[] }> {
  const freshness = createFreshnessPolicy(policy);
  const facts = await repo.facts.listAll();
  const items = await repo.content.listAll();
  const updateCandidates: string[] = [];
  const revoked: string[] = [];
  const runId = `refresh:${now.toISOString()}`;

  for (const item of items) {
    if (!isLiveState(item.state)) continue;
    const revision =
      (item.currentRevision ? await repo.content.getRevision(item.currentRevision) : undefined) ??
      (await repo.content.getLatestRevision(item.id));
    if (!revision) continue;
    const relatedFacts = facts.filter((f) => revision.sourceIds.some((s) => f.sourceIds.includes(s)));
    if (relatedFacts.length === 0) continue;

    const expired = relatedFacts.filter((f) => !freshness.isFactUsable(f, now));
    const invalid = relatedFacts.filter((f) => f.verificationStatus === "INVALID");
    if (invalid.length > 0) {
      await transition(repo, item, "REVOKED", runId, policy.version, {
        evidenceIds: invalid.map((f) => f.id),
        at: now,
      });
      revoked.push(item.slug);
      continue;
    }
    if (expired.length > 0 && item.state !== "UPDATE_CANDIDATE") {
      // PUBLISHED -> MEASURING -> UPDATE_CANDIDATE: the state machine has no direct edge.
      const measuring =
        item.state === "PUBLISHED"
          ? await transition(repo, item, "MEASURING", runId, policy.version, { at: now })
          : item;
      await transition(repo, measuring, "UPDATE_CANDIDATE", runId, policy.version, {
        evidenceIds: expired.map((f) => f.id),
        at: now,
      });
      updateCandidates.push(item.slug);
    }
  }
  return { updateCandidates, revoked };
}

/** FACT stale helper reused by tests. */
export function isExpiredFact(fact: Fact, policy: PolicyConfig, now: Date): boolean {
  return !createFreshnessPolicy(policy).isFactUsable(fact, now);
}

/** B016 entry: growth plan from repository data. */
export async function growthPlan(repo: Repository, pageIds: string[]): Promise<GrowthPlan[]> {
  const [traffic, clicks, conversions] = await Promise.all([
    repo.metrics.listTraffic(),
    repo.metrics.listOutboundClicks(),
    repo.offers.listConversions(),
  ]);
  return prioritizeGrowth({ pageIds, traffic, clicks, conversions });
}

export type { ContentState };
