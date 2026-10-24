import type { Fact, PolicyConfig, ContentState } from "@aff/domain";
import type { Repository } from "@aff/db";
import { createFreshnessPolicy } from "@aff/integrations";
import { prioritizeGrowth } from "@aff/analytics";
import type { GrowthPlan } from "@aff/analytics";

/**
 * B017: freshness patrol. Published content whose facts expired is moved to
 * UPDATE_CANDIDATE; content in QUARANTINE-worthy condition (INVALID facts) is
 * revoked (auto-unpublished) until re-verification passes.
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

  for (const item of items) {
    if (item.state !== "PUBLISHED" && item.state !== "MEASURING") continue;
    const revision = await repo.content.getLatestRevision(item.id);
    if (!revision) continue;
    const relatedFacts = facts.filter((f) => revision.sourceIds.some((s) => f.sourceIds.includes(s)));
    if (relatedFacts.length === 0) continue;

    const expired = relatedFacts.filter((f) => !freshness.isFactUsable(f, now));
    const invalid = relatedFacts.filter((f) => f.verificationStatus === "INVALID");
    if (invalid.length > 0) {
      await repo.content.updateState(item.id, "REVOKED");
      await repo.content.recordTransition({
        itemId: item.id,
        runId: `refresh:${now.toISOString()}`,
        fromState: item.state,
        toState: "REVOKED",
        policyVersion: policy.version,
        evidenceIds: invalid.map((f) => f.id),
        at: now.toISOString(),
      });
      revoked.push(item.slug);
      continue;
    }
    if (expired.length > 0) {
      await repo.content.updateState(item.id, "UPDATE_CANDIDATE");
      await repo.content.recordTransition({
        itemId: item.id,
        runId: `refresh:${now.toISOString()}`,
        fromState: item.state,
        toState: "UPDATE_CANDIDATE",
        policyVersion: policy.version,
        evidenceIds: expired.map((f) => f.id),
        at: now.toISOString(),
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
