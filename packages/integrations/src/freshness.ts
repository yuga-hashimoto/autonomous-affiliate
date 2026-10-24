import { isFresh, type ClaimType, type Fact, type PolicyConfig } from "@aff/domain";

export interface FreshnessPolicy {
  maxAgeDaysFor(claimType: ClaimType): number;
  isFactUsable(fact: Fact, now: Date): boolean;
}

/**
 * Freshness rules per docs/06: prices 7 days, features 30 days, terms must be
 * re-checked at publish time (treated as price-freshness here unless set).
 */
export function createFreshnessPolicy(policy: PolicyConfig): FreshnessPolicy {
  function maxAgeDaysFor(claimType: ClaimType): number {
    switch (claimType) {
      case "price":
      case "cancellation":
      case "reward":
        return policy.content.price_source_max_age_days;
      case "feature":
      case "contract_term":
      case "coverage_area":
        return policy.content.feature_source_max_age_days;
      case "terms":
        return policy.content.price_source_max_age_days;
      case "other":
        return policy.content.feature_source_max_age_days;
    }
  }
  return {
    maxAgeDaysFor,
    isFactUsable(fact: Fact, now: Date): boolean {
      if (fact.verificationStatus !== "VERIFIED") return false;
      if (!isFresh(fact.verifiedAt, now, maxAgeDaysFor(fact.claimType))) return false;
      if (fact.expiresAt && Date.parse(fact.expiresAt) <= now.getTime()) return false;
      return true;
    },
  };
}
