import {
  assertTransition,
  newId,
  type AffiliateOffer,
  type ContentItem,
  type ContentState,
  type Fact,
  type Logger,
  type PolicyConfig,
  type SourceRecord,
} from "@aff/domain";
import type { Repository } from "@aff/db";
import { buildDraft } from "@aff/content";
import {
  calculateFiberTotalCost,
  calculateSimTotalCost,
  calculateWaterServerCost,
  buildDecisionMatrix,
  type TotalCostCalculation,
} from "@aff/analysis";
import {
  createFreshnessPolicy,
  DomainAllowlist,
  SourceCollector,
  SourceUnavailableError,
  type CollectedSource,
  type Fetcher,
} from "@aff/integrations";
import type { ArticlePlan, PipelineServices } from "./pipeline.js";
import type { PublishArtifact, PublishTarget, PublisherAgent } from "./publisher.js";
import { toFact, type FactExtractor } from "./research.js";

/**
 * The evidence one cycle collected. The update path drafts and checks QA
 * against exactly this, never against older snapshots of the same pages.
 */
export interface PlanEvidence {
  sources: SourceRecord[];
  facts: Fact[];
}

/**
 * Adds the article's hero image to what is about to be published, or leaves the
 * artifact as it is. The image is decoration (QA checks the text), so a failure
 * is logged and the article goes out without one. Only an article the publisher
 * would accept gets one, so nothing is spent on an image that would not ship.
 */
export async function withHeroImage(
  artifact: PublishArtifact,
  input: {
    plan: ArticlePlan;
    services: PipelineServices;
    publisher: PublisherAgent;
    target: PublishTarget;
    offers: AffiliateOffer[];
    logger: Logger;
  },
): Promise<PublishArtifact> {
  const { plan, services, publisher, target, offers, logger } = input;
  if (!services.heroImages || target.destination === "preview") return artifact;
  const gate = await publisher.canPublish({ artifact, target }, offers);
  if (!gate.ok) return artifact;
  try {
    const result = await services.heroImages.prepare({ slug: plan.slug, verticalId: plan.verticalId });
    if (!result) return artifact;
    return { ...artifact, hero: result.image, ...(result.file ? { heroFile: result.file } : {}) };
  } catch (error) {
    logger.warn("hero image skipped; the article is published without one", {
      slug: plan.slug,
      error: String(error),
    });
    return artifact;
  }
}

export async function transition(
  repo: Repository,
  item: ContentItem,
  to: ContentState,
  runId: string,
  policyVersion: string,
  options: { evidenceIds?: string[]; at?: Date } = {},
): Promise<ContentItem> {
  assertTransition(item.state, to);
  await repo.content.recordTransition({
    itemId: item.id,
    runId,
    fromState: item.state,
    toState: to,
    policyVersion,
    evidenceIds: options.evidenceIds ?? [],
    at: (options.at ?? new Date()).toISOString(),
  });
  return repo.content.updateState(item.id, to);
}

export interface SourceStageDeps {
  repo: Repository;
  policy: PolicyConfig;
  fetcher: Fetcher;
  clock: () => Date;
}

/** Fetches every official page of the plan; pages that cannot be read are listed, not guessed. */
export async function collectPlanSources(
  plan: ArticlePlan,
  deps: SourceStageDeps,
): Promise<{ collected: CollectedSource[]; unavailable: string[] }> {
  const collector = new SourceCollector(
    deps.fetcher,
    new DomainAllowlist(deps.policy.security.allowed_source_domains),
    deps.repo.sources,
    { provenance: `pipeline:${plan.slug}`, clock: deps.clock },
  );
  const collected: CollectedSource[] = [];
  const unavailable: string[] = [];
  for (const url of plan.sourceUrls) {
    try {
      collected.push(await collector.collect(url));
    } catch (error) {
      if (error instanceof SourceUnavailableError) {
        unavailable.push(url);
        continue;
      }
      throw error;
    }
  }
  return { collected, unavailable };
}

export interface FactStageDeps {
  repo: Repository;
  policy: PolicyConfig;
  extractor: FactExtractor;
}

/** Extracts and stores the facts of the collected pages; each fact expires by its claim type. */
export async function extractPlanFacts(collected: CollectedSource[], deps: FactStageDeps): Promise<Fact[]> {
  const freshness = createFreshnessPolicy(deps.policy);
  const saved: Fact[] = [];
  for (const source of collected) {
    const specs = await deps.extractor.extract(source.body, source.record.contentType);
    for (const spec of specs) {
      const expiresAt = new Date(
        Date.parse(source.record.fetchedAt) + freshness.maxAgeDaysFor(spec.claimType) * 86_400_000,
      ).toISOString();
      saved.push(
        await deps.repo.facts.save(
          toFact(spec, source.record.id, source.record.fetchedAt, expiresAt, (prefix) => newId(prefix)),
        ),
      );
    }
  }
  return saved;
}

export async function existingHashes(repo: Repository, excludeSlug: string): Promise<Set<string>> {
  const items = await repo.content.listAll();
  const hashes = new Set<string>();
  for (const item of items) {
    if (item.slug === excludeSlug) continue;
    const rev = await repo.content.getLatestRevision(item.id);
    if (rev) hashes.add(rev.contentHash);
  }
  return hashes;
}

export function computeCalculations(plan: ArticlePlan): TotalCostCalculation[] {
  return plan.calculators.map((entry) => {
    switch (entry.calculator) {
      case "sim":
        return calculateSimTotalCost(entry.input as never);
      case "fiber":
        return calculateFiberTotalCost(entry.input as never);
      case "water":
        return calculateWaterServerCost(entry.input as never);
    }
  });
}

export async function buildDraftFor(
  plan: ArticlePlan,
  repo: Repository,
  clock: () => Date,
  evidence?: PlanEvidence,
) {
  const calculations = computeCalculations(plan);
  const allOffers = await repo.offers.listOffers();
  const offerById = new Map(allOffers.map((o) => [o.id, o]));
  const comparedOffers = plan.calculators
    .map((entry) => {
      const id = String(entry.input.offerId);
      return offerById.get(id);
    })
    .filter((o): o is AffiliateOffer => Boolean(o));
  const planOffers =
    plan.offerIds.length === 0
      ? comparedOffers
      : comparedOffers.filter((o) => plan.offerIds.includes(o.id));
  const sources = evidence?.sources ?? (await repo.sources.list());
  const facts = evidence?.facts ?? (await repo.facts.listAll());
  const factIdsByOfferId = Object.fromEntries(
    plan.calculators.map((entry) => {
      const offerId = String(entry.input.offerId);
      const terms = entry.factEvidenceTerms ?? [String(entry.input.title)];
      const matchingFacts = facts.filter(
        (fact) =>
          fact.claimType === "price" &&
          terms.some((term) => term.length > 0 && fact.text.includes(term)),
      );
      return [offerId, matchingFacts.map((fact) => fact.id)];
    }),
  );
  const conditionsByOffer = new Map(
    plan.calculators.map((entry) => [String(entry.input.offerId), entry.conditions ?? {}]),
  );
  const matrix = plan.decisionCriteria
    ? buildDecisionMatrix(
        comparedOffers.map((o) => ({
          offerId: o.id,
          title: o.title,
          conditions: { ...(conditionsByOffer.get(o.id) ?? {}), ...offerConditions(o) },
        })),
        plan.decisionCriteria!,
      )
    : undefined;
  return buildDraft({
    slug: plan.slug,
    title: plan.title,
    locale: plan.locale,
    audience: plan.audience,
    purpose: plan.purpose,
    facts,
    sources,
    offers: comparedOffers,
    calculations,
    factIdsByOfferId,
    matrix,
    ctaOffers: planOffers,
    now: clock(),
  });
}

function offerConditions(offer: AffiliateOffer): Record<string, string | number> {
  return {
    reward: offer.rewardAmountJpy ?? "UNKNOWN",
    conversion_event: offer.conversionEvent ?? "UNKNOWN",
    ...offer.constraints,
  };
}
