import {
  dayKeyInTz,
  isLiveState,
  newId,
  type ContentState,
  type Logger,
  type PolicyConfig,
  type QaCheck,
  type QualityDecision,
} from "@aff/domain";
import type { Repository } from "@aff/db";
import { QaEngine, DraftRejectedError } from "@aff/content";
import { createFreshnessPolicy, MapFetcher, type CollectedSource, type Fetcher } from "@aff/integrations";
import { PublisherAgent, type PublishArtifact, type PublishTarget, type PublisherIO } from "./publisher.js";
import { checkPlanEvidence, type DerivedAmount } from "./plan-evidence.js";
import { draftPlanFromPages, type QuoteSelector } from "./plan-quotes.js";
import {
  buildDraftFor,
  collectPlanSources,
  computeCalculations,
  existingHashes,
  extractPlanFacts,
  transition,
  withHeroImage,
} from "./pipeline-support.js";
import type { HeroImageService } from "./hero-image.js";
import type { FactExtractor } from "./research.js";

export { computeCalculations };

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

/**
 * A brief for one compared service whose yen amounts are not typed in but read
 * from the official facts (docs/18, plan-draft.ts). Used when `calculators` is empty.
 */
export interface PlanDraft {
  calculator: "water";
  offerId: string;
  /** The service and plan as the article names it. */
  title: string;
  /** Fragments that name this service in the facts (the facts are matched by text). */
  evidenceTerms: string[];
  /** Comparison window; an assumption of the article, not a page fact. */
  months: number;
  /** Monthly volume the comparison assumes; the page's charge must be for this volume. */
  monthlyLiters: number;
  /**
   * The brief's statement of which page lines are this service's water price when the
   * page prices by plan and server rather than by the service's name (for example
   * "もっとPREMIUM" and "省エネサーバー" for a server the page does not name in its
   * price table). A price fact must contain every fragment. Without it the facts that
   * name the service are read.
   */
  priceTerms?: string[];
  /** Likewise for the minimum term: the facts must contain every fragment (the plan's name). */
  planTerms?: string[];
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
  /** Fills `calculators` from the facts when it is empty (docs/18). */
  draft?: PlanDraft;
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
  /** Points at passages of a page for a plan kept as a brief (docs/18); without it such a plan is not made. */
  quoteSelector?: QuoteSelector;
  publisherIO: PublisherIO;
  /** Supplies each published article's hero image; without it articles go out text-only. */
  heroImages?: HeroImageService;
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

  // A live article is only ever replaced by the update path (update.ts): this
  // pipeline would otherwise try PUBLISHED -> APPROVED_AUTOMATICALLY under a new
  // policy version, and a revoked article must not return without re-verification.
  if (isLiveState(item.state) || item.state === "REVOKED") {
    trace.info("article is already published or revoked; the new-article pipeline leaves it alone", {
      state: item.state,
    });
    const qa = await repo.content.getLatestQaReport(item.id);
    return {
      itemId: item.id,
      slug: plan.slug,
      finalState: item.state,
      qaStatus: qa?.status ?? "UNKNOWN",
      published: isLiveState(item.state),
      reasons: [isLiveState(item.state) ? "already_published" : "revoked"],
    };
  }

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
    let collectedPages: CollectedSource[] | undefined;
    if (current.state === "ELIGIBILITY_CHECKED") {
      const { collected, unavailable } = await collectPlanSources(plan, {
        repo,
        policy,
        fetcher: services.fetcher ?? new MapFetcher(new Map()),
        clock,
      });
      for (const url of unavailable) reasons.push(`source_unavailable:${url}`);
      collectedPages = collected;
      await extractPlanFacts(collected, { repo, policy, extractor: services.extractor });
      trace.info("research done", { sources: collected.length });
      current = await transition(repo, current, "RESEARCHED", runId, policy.version);
    }

    // --- Stage: plan drafting (docs/18) ---
    // A plan kept as a brief gets its amounts from quotes of this cycle's official pages. Done on
    // every run (not only right after research) so a resumed article has them too.
    const drafted = await draftPlanFromPages(plan, {
      repo,
      policy,
      clock,
      selector: services.quoteSelector,
      collected: collectedPages,
      fetcher: services.fetcher,
    });
    if (!drafted.ok) {
      current = await transition(repo, current, "QUARANTINED", runId, policy.version);
      await repo.jobs.update({ ...jobRecord, state: "SUCCEEDED", lastError: "plan_draft_failed" });
      trace.warn("plan could not be drafted from the official page", { issues: drafted.issues });
      return {
        itemId: item.id,
        slug: plan.slug,
        finalState: "QUARANTINED",
        qaStatus: "UNKNOWN",
        published: false,
        publishReason: "plan_draft_failed",
        reasons: [...reasons, ...drafted.issues],
      };
    }
    plan = drafted.plan;

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
        now: clock(),
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
    const textArtifact: PublishArtifact = {
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
    const artifact = await withHeroImage(textArtifact, { plan, services, publisher, target, offers, logger: trace });
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

/** Guard for budget-aware scheduling (docs/07). */
export function currentMonthKey(clock: () => Date = () => new Date()): string {
  return dayKeyInTz(clock()).slice(0, 7);
}
