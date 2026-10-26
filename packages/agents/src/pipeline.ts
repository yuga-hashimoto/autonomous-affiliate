import {
  assertTransition,
  dayKeyInTz,
  newId,
  type AffiliateOffer,
  type ContentItem,
  type ContentState,
  type Logger,
  type PolicyConfig,
  type QaCheck,
  type QualityDecision,
} from "@aff/domain";
import type { Repository } from "@aff/db";
import { buildDraft, QaEngine, DraftRejectedError } from "@aff/content";
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
  MapFetcher,
  SourceCollector,
  SourceUnavailableError,
  type Fetcher,
} from "@aff/integrations";
import { PublisherAgent, type PublishArtifact, type PublishTarget, type PublisherIO } from "./publisher.js";
import { checkPlanEvidence, type DerivedAmount } from "./plan-evidence.js";
import { toFact, type FactExtractor } from "./research.js";

export type VerticalCalculatorKey = "sim" | "fiber" | "water";

export interface CalculatorEntry {
  calculator: VerticalCalculatorKey;
  /** Matches the calculator input type for the selected vertical. */
  input: Record<string, unknown>;
  /** Normalized conditions for the decision matrix (from official facts). */
  conditions?: Record<string, string | number>;
  /** One or more service-name fragments that must match extracted official price Facts. */
  factEvidenceTerms?: string[];
  /**
   * Official pages of this service whose extracted facts may back its amounts even
   * when a fact does not name the service. Defaults to the plan's sourceUrls for a
   * single-service plan; a multi-service plan must list them per entry.
   */
  evidenceSourceUrls?: string[];
  /**
   * Yen inputs built from page amounts, keyed by the input path (for example
   * "waterChargeJpy"). QA checks each component against the extracted facts and
   * that the components add up to the input value.
   */
  derivedAmounts?: Record<string, DerivedAmount[]>;
}

export interface ArticlePlan {
  slug: string;
  title: string;
  locale?: string;
  audience: string;
  purpose: string;
  verticalId: string;
  keyword: string;
  sourceUrls: string[];
  /** One entry per compared offer; same formula family for a uniform unit. */
  calculators: CalculatorEntry[];
  /** Offers referenced by this article (CTA candidates). */
  offerIds: string[];
  decisionCriteria?: { id: string; label: string }[];
}

export interface PipelineServices {
  repo: Repository;
  policy: PolicyConfig;
  logger: Logger;
  /** Overrides the collector's fetcher (fixtures in dry-run). */
  fetcher?: Fetcher;
  extractor: FactExtractor;
  publisherIO: PublisherIO;
  previewDir?: string;
  clock?: () => Date;
  /** Called between repair attempts; may mutate the plan (LLM repair in live mode). */
  repair?: (plan: ArticlePlan, attempt: number, lastDecision: QualityDecision) => Promise<ArticlePlan>;
}

export interface PipelineResult {
  itemId: string;
  slug: string;
  finalState: ContentState;
  qaStatus: QualityDecision["status"];
  published: boolean;
  publishReason?: string;
  /** Checks that did not pass, present only when QA blocked the article. */
  qaFailures?: QaCheck[];
  reasons: string[];
}

function transition(
  repo: Repository,
  item: ContentItem,
  to: ContentState,
  runId: string,
  policyVersion: string,
): Promise<ContentItem> {
  assertTransition(item.state, to);
  return (async () => {
    await repo.content.recordTransition({
      itemId: item.id,
      runId,
      fromState: item.state,
      toState: to,
      policyVersion,
      evidenceIds: [],
      at: new Date().toISOString(),
    });
    return repo.content.updateState(item.id, to);
  })();
}

/**
 * Runs one article through research → analysis → draft → QA → publish.
 * Deterministic, idempotent (job_key per stage+plan), fail closed: any
 * UNKNOWN or missing source blocks publication (docs/04, docs/11 B023).
 */
export async function runArticlePipeline(
  plan: ArticlePlan,
  services: PipelineServices,
): Promise<PipelineResult> {
  const { repo, policy, logger } = services;
  const clock = services.clock ?? (() => new Date());
  const runId = newId("run");
  const trace = logger.child({ run_id: runId, slug: plan.slug });
  const reasons: string[] = [];

  const item = await repo.content.createIfNotExists({
    slug: plan.slug,
    locale: plan.locale ?? "ja-JP",
    topic: plan.verticalId,
  });
  let current = item;

  // B003 idempotency: re-running the same plan does not duplicate work.
  const jobKey = `pipeline|${plan.slug}|${policy.version}`;
  const { record: job, created } = await repo.jobs.enqueue({ jobKey, jobType: "article_pipeline", traceId: trace.traceId });
  if (!created && job.state === "SUCCEEDED") {
    trace.info("pipeline already completed for this plan; skipping", { job_key: jobKey });
    const qa = await repo.content.getLatestQaReport(item.id);
    return {
      itemId: item.id,
      slug: plan.slug,
      finalState: item.state,
      qaStatus: qa?.status ?? "UNKNOWN",
      published: item.state === "PUBLISHED",
      reasons: ["already_completed"],
    };
  }
  let jobRecord = created
    ? job
    : await repo.jobs.update({ ...job, state: "PENDING" });
  jobRecord = await repo.jobs.update({ ...jobRecord, state: "RUNNING" });

  try {
    // --- Stage: eligibility ---
    if (current.state === "DISCOVERED") {
      current = await transition(repo, current, "ELIGIBILITY_CHECKED", runId, policy.version);
    }

    // --- Stage: research (B006/B008) ---
    if (current.state === "ELIGIBILITY_CHECKED") {
      const collector = new SourceCollector(
        services.fetcher ?? new MapFetcher(new Map()),
        new DomainAllowlist(policy.security.allowed_source_domains),
        repo.sources,
        { provenance: `pipeline:${plan.slug}` },
      );
      const freshness = createFreshnessPolicy(policy);
      let collected = 0;
      for (const url of plan.sourceUrls) {
        let collectedSource;
        try {
          collectedSource = await collector.collect(url);
          collected += 1;
        } catch (error) {
          if (error instanceof SourceUnavailableError) {
            reasons.push(`source_unavailable:${url}`);
            continue;
          }
          throw error;
        }
        const specs = await services.extractor.extract(collectedSource.body, collectedSource.record.contentType);
        for (const spec of specs) {
          const expiresAt = new Date(
            Date.parse(collectedSource.record.fetchedAt) +
              freshness.maxAgeDaysFor(spec.claimType) * 86_400_000,
          ).toISOString();
          await repo.facts.save(
            toFact(spec, collectedSource.record.id, collectedSource.record.fetchedAt, expiresAt, (prefix) => newId(prefix)),
          );
        }
      }
      trace.info("research done", { sources: collected });
      current = await transition(repo, current, "RESEARCHED", runId, policy.version);
    }

    // --- Stage: analysis (B007) ---
    if (current.state === "RESEARCHED") {
      const calculations = computeCalculations(plan);
      for (const calculation of calculations) {
        await repo.analyses.save({
          id: newId("ana"),
          opportunityId: plan.keyword,
          sourceIds: (await repo.sources.list()).map((s) => s.id),
          assumptions: Object.fromEntries(calculation.assumptions.entries()),
          formulaVersion: calculation.formulaVersion,
          result: calculation as unknown as Record<string, unknown>,
          checkedAt: clock().toISOString(),
        });
      }
      trace.info("analysis done", {
        formula_version: calculations[0]?.formulaVersion ?? "none",
        offers_compared: calculations.length,
      });
      current = await transition(repo, current, "ANALYZED", runId, policy.version);
    }

    // --- Stage: draft + QA with bounded repair loop ---
    if (current.state === "ANALYZED") {
      current = await transition(repo, current, "DRAFTED", runId, policy.version);
    }
    if (current.state === "DRAFTED") {
      current = await transition(repo, current, "QA_PENDING", runId, policy.version);
    }

    let decision: QualityDecision | undefined;
    let repairAttempts = 0;
    while (true) {
      const draft = await buildDraftFor(plan, repo, clock);
      const freshness = createFreshnessPolicy(policy);
      const qa = new QaEngine(policy, {
        freshness,
        existingContentHashes: await existingHashes(repo, plan.slug),
      });
      const allFacts = await repo.facts.listAll();
      decision = qa.evaluate({
        draft,
        facts: allFacts,
        planEvidenceIssues: checkPlanEvidence(
          plan,
          allFacts.filter((fact) => freshness.isFactUsable(fact, clock())),
          await repo.sources.list(),
        ),
        offers: await repo.offers.listOffers(),
        sources: await repo.sources.list(),
        itemId: item.id,
        revisionId: newId("rev"),
      });
      await repo.content.saveQaReport(decision);
      await repo.content.saveRevision({
        id: decision.revisionId,
        itemId: item.id,
        contentHash: decision.artifactHash,
        markdownPath: `content/articles/${plan.slug}.${plan.locale ?? "ja-JP"}.md`,
        qaReportId: decision.id,
        sourceIds: draft.sourceIds,
      });
      await repo.content.setCurrentRevision(item.id, decision.revisionId);
      if (decision.status === "PASS" || repairAttempts >= policy.limits.qa_repair_attempts) break;
      repairAttempts += 1;
      reasons.push(`qa_repair_attempt:${repairAttempts}`);
      if (services.repair) {
        plan = await services.repair(plan, repairAttempts, decision);
      }
      trace.warn("qa failed; repair scheduled", { attempt: repairAttempts });
    }

    if (!decision) {
      throw new Error("unreachable: QA decision missing");
    }
    if (decision.status !== "PASS") {
      const to: ContentState = decision.status === "UNKNOWN" ? "QUARANTINED" : "REJECTED";
      current = await transition(repo, current, to, runId, policy.version);
      await repo.jobs.update({ ...jobRecord, state: "SUCCEEDED", lastError: `qa_${decision.status}` });
      trace.warn("article blocked by QA", { status: decision.status });
      return {
        itemId: item.id,
        slug: plan.slug,
        finalState: to,
        qaStatus: decision.status,
        published: false,
        publishReason: `qa_${decision.status}`,
        qaFailures: decision.checks.filter((check) => check.status !== "PASS"),
        reasons,
      };
    }
    current = await transition(repo, current, "APPROVED_AUTOMATICALLY", runId, policy.version);

    // --- Stage: publish (B012) ---
    current = await transition(repo, current, "DEPLOYING", runId, policy.version);
    const publisher = new PublisherAgent({
      repo,
      policy,
      logger: trace,
      io: services.publisherIO,
      siteContentDir: "content/articles",
      clock,
    });
    const target: PublishTarget = {
      destination: policy.flags.publish_enabled ? "git" : "preview",
      previewDir: services.previewDir,
    };
    const draft = await buildDraftFor(plan, repo, clock);
    const latestQa = await repo.content.getLatestQaReport(item.id);
    const artifact: PublishArtifact = {
      itemId: item.id,
      revisionId: latestQa!.revisionId,
      slug: plan.slug,
      locale: draft.locale,
      title: draft.title,
      description: plan.purpose,
      markdown: draft.bodyMarkdown,
      contentHash: latestQa?.artifactHash ?? "",
      qa: latestQa!,
      offerIds: draft.offerIds,
    };
    const offers = await repo.offers.listOffers();
    const outcome = await publisher.publish({ artifact, target, item }, offers);
    if (!outcome.published) {
      current = await transition(repo, current, "QUARANTINED", runId, policy.version);
      await repo.jobs.update({ ...jobRecord, state: "SUCCEEDED", lastError: outcome.reason });
      return {
        itemId: item.id,
        slug: plan.slug,
        finalState: "QUARANTINED",
        qaStatus: "PASS",
        published: false,
        publishReason: outcome.reason,
        reasons,
      };
    }
    current = await transition(repo, current, "PUBLISHED", runId, policy.version);
    await repo.jobs.update({ ...jobRecord, state: "SUCCEEDED" });
    return {
      itemId: item.id,
      slug: plan.slug,
      finalState: "PUBLISHED",
      qaStatus: "PASS",
      published: true,
      reasons,
    };
  } catch (error) {
    const message = error instanceof DraftRejectedError ? "draft_rejected_hands_on" : String(error);
    await repo.jobs.update({ ...jobRecord, state: "DEAD_LETTER", lastError: message }).catch(() => undefined);
    trace.error("pipeline failed", { error });
    throw error;
  }
}

async function existingHashes(repo: Repository, excludeSlug: string): Promise<Set<string>> {
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

async function buildDraftFor(plan: ArticlePlan, repo: Repository, clock: () => Date) {
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
  const sources = await repo.sources.list();
  const facts = await repo.facts.listAll();
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

/** Guard for budget-aware scheduling (docs/07). */
export function currentMonthKey(clock: () => Date = () => new Date()): string {
  return dayKeyInTz(clock()).slice(0, 7);
}
