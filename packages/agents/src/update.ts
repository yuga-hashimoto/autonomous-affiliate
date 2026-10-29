import {
  dayKeyInTz,
  isLiveState,
  newId,
  type ContentItem,
  type ContentState,
  type Fact,
  type QaCheck,
  type QualityDecision,
} from "@aff/domain";
import type { JobRunRecord } from "@aff/db";
import { DraftRejectedError, QaEngine } from "@aff/content";
import { BudgetExceededError } from "@aff/llm";
import { createFreshnessPolicy, MapFetcher } from "@aff/integrations";
import { PublisherAgent, type PublishArtifact, type PublishTarget } from "./publisher.js";
import { checkPlanEvidence } from "./plan-evidence.js";
import { draftPlanFromPages } from "./plan-quotes.js";
import {
  buildDraftFor,
  collectPlanSources,
  computeCalculations,
  existingHashes,
  extractPlanFacts,
  transition,
  withHeroImage,
  type PlanEvidence,
} from "./pipeline-support.js";
import { runArticlePipeline, type ArticlePlan, type PipelineResult, type PipelineServices } from "./pipeline.js";

/**
 * Why a live article is being regenerated:
 * - stale: the refresh sweep found expired facts and set UPDATE_CANDIDATE.
 * - template: an operator/workflow input says the generator changed
 *   (`revision` names that change, for example "figures-1").
 */
export type UpdateTrigger = { kind: "stale" } | { kind: "template"; revision: string };

/** One update cycle. Equal cycles are the same job; a new cycle runs again. */
export type UpdateCycle = { kind: "stale"; baseRevisionId: string } | { kind: "template"; revision: string };

export type UpdateOutcome =
  /** The article was regenerated, QA passed, and the file was replaced. */
  | "updated"
  /** Publishing is off: a QA-passed draft went to the preview directory only. */
  | "previewed"
  /** The attempt failed closed; the previous version is still live. */
  | "kept_previous"
  /** Nothing was attempted (not live, already done, retry not due, ...). */
  | "skipped";

export interface UpdateResult {
  itemId: string;
  slug: string;
  trigger: UpdateTrigger["kind"];
  outcome: UpdateOutcome;
  finalState: ContentState;
  qaStatus?: QualityDecision["status"];
  /** Checks that did not pass, present only when QA blocked the new version. */
  qaFailures?: QaCheck[];
  revisionId?: string;
  commitSha?: string;
  reasons: string[];
}

/** Same-day repeats are skipped; the next scheduled run (about a day later) retries. */
const RETRY_DELAY_MS = 12 * 3_600_000;

/** docs/04: job_key = task_kind + target_entity + cycle + policy_version. */
export function updateJobKey(slug: string, locale: string, cycle: UpdateCycle, policyVersion: string): string {
  const cycleKey = cycle.kind === "stale" ? `stale:${cycle.baseRevisionId}` : `template:${cycle.revision}`;
  return `update|${slug}|${locale}|${cycleKey}|${policyVersion}`;
}

type JobClaim = { job: JobRunRecord } | { skip: string };

/** Claims the cycle's job: a finished, dead, busy or not-yet-due job is not run again. */
async function claimJob(
  services: PipelineServices,
  jobKey: string,
  traceId: string,
  now: Date,
): Promise<JobClaim> {
  const { repo, policy } = services;
  const { record, created } = await repo.jobs.enqueue({ jobKey, jobType: "article_update", traceId });
  if (!created) {
    switch (record.state) {
      case "SUCCEEDED":
        return { skip: "already_completed" };
      case "DEAD_LETTER":
        return { skip: "dead_lettered" };
      case "CANCELED":
        return { skip: "canceled" };
      case "RETRY_SCHEDULED":
        if (Date.parse(record.runAfter) > now.getTime()) return { skip: "retry_not_due" };
        break;
      case "RUNNING":
        // A run that died leaves RUNNING behind; only a job older than the job deadline is taken over.
        if (now.getTime() - Date.parse(record.updatedAt) < policy.limits.max_job_duration_seconds * 1000) {
          return { skip: "in_progress" };
        }
        break;
      case "PENDING":
        break;
    }
  }
  return { job: await repo.jobs.update({ ...record, state: "RUNNING", attempt: record.attempt + 1 }) };
}

/**
 * Regenerates one live article: research -> analysis -> draft -> QA, and
 * replaces `content/articles/<slug>.<locale>.md` only when QA passes and the
 * site still builds. Any failure keeps the previous version live (the item
 * stays UPDATE_CANDIDATE and the cycle is retried on a later day, up to
 * `limits.task_retry_attempts`). Draft and QA see only the evidence collected
 * in this cycle, never older snapshots of the same pages.
 *
 * Updates do not count against `limits.new_articles_per_day` (publisher kind
 * "update"). With publishing off the result is a preview and nothing durable
 * changes: no state move, no job, no revision.
 */
export async function runArticleUpdate(
  inputPlan: ArticlePlan,
  services: PipelineServices,
  trigger: UpdateTrigger,
): Promise<UpdateResult> {
  const { repo, policy } = services;
  const clock = services.clock ?? (() => new Date());
  const locale = inputPlan.locale ?? "ja-JP";
  const runId = newId("run");
  const trace = services.logger.child({ run_id: runId, slug: inputPlan.slug, update_trigger: trigger.kind });
  const dryRun = !policy.flags.publish_enabled;

  const item = await repo.content.getBySlug(inputPlan.slug, locale);
  if (!item) throw new Error(`no content item for ${inputPlan.slug}; the update path only handles published articles`);

  let current: ContentItem = item;
  const result = (
    outcome: UpdateOutcome,
    reasons: string[],
    extra: Partial<Omit<UpdateResult, "itemId" | "slug" | "trigger" | "outcome" | "reasons">> = {},
  ): UpdateResult => ({
    itemId: item.id,
    slug: inputPlan.slug,
    trigger: trigger.kind,
    outcome,
    finalState: current.state,
    reasons,
    ...extra,
  });

  if (item.state === "REVOKED") return result("skipped", ["revoked"]);
  if (!isLiveState(item.state)) return result("skipped", [`not_live:${item.state}`]);
  if (trigger.kind === "stale" && item.state !== "UPDATE_CANDIDATE") {
    return result("skipped", ["not_update_candidate"]);
  }
  const baseRevisionId = item.currentRevision ?? (await repo.content.getLatestRevision(item.id))?.id;
  if (!baseRevisionId) return result("skipped", ["no_live_revision"]);

  // Idempotency per cycle (docs/04). A preview has no durable effect, so it has no job.
  let job: JobRunRecord | undefined;
  if (!dryRun) {
    const cycle: UpdateCycle =
      trigger.kind === "stale" ? { kind: "stale", baseRevisionId } : { kind: "template", revision: trigger.revision };
    const claim = await claimJob(services, updateJobKey(inputPlan.slug, locale, cycle, policy.version), trace.traceId, clock());
    if ("skip" in claim) {
      trace.info("update cycle not run", { reason: claim.skip });
      return result("skipped", [claim.skip]);
    }
    job = claim.job;
  }

  // A failed attempt is retried on a later day; the cap keeps a broken cycle from spending forever.
  const scheduleRetry = async (lastError: string): Promise<void> => {
    if (!job) return;
    await repo.jobs.update(
      job.attempt >= policy.limits.task_retry_attempts
        ? { ...job, state: "DEAD_LETTER", lastError }
        : {
            ...job,
            state: "RETRY_SCHEDULED",
            lastError,
            runAfter: new Date(clock().getTime() + RETRY_DELAY_MS).toISOString(),
          },
    );
  };
  const keep = async (
    reasons: string[],
    extra: Partial<Omit<UpdateResult, "itemId" | "slug" | "trigger" | "outcome" | "reasons">> = {},
  ): Promise<UpdateResult> => {
    trace.warn("update failed closed; the previous version stays live", { reasons });
    if (job) {
      await scheduleRetry(reasons.join(","));
      await repo.audit.append({
        runId,
        agent: "updater",
        eventType: "article.update.kept_previous",
        payload: {
          slug: inputPlan.slug,
          trigger: trigger.kind,
          reasons,
          failedChecks: (extra.qaFailures ?? []).map((check) => ({ id: check.id, detail: check.detail })),
        },
        at: clock().toISOString(),
      });
    }
    return result("kept_previous", reasons, extra);
  };

  try {
    if (policy.operations.stop_on_budget_limit) {
      const spend = await repo.spend.sumMonth(dayKeyInTz(clock()).slice(0, 7));
      if (spend > policy.limits.monthly_operating_cost_jpy) return await keep(["budget_stopped"]);
    }

    // The operator says this live article is outdated, so it is an update candidate
    // until replaced; a failed attempt leaves it there for the scheduled retry.
    if (!dryRun && trigger.kind === "template") {
      if (current.state === "PUBLISHED") {
        current = await transition(repo, current, "MEASURING", runId, policy.version, { at: clock() });
      }
      if (current.state === "MEASURING") {
        current = await transition(repo, current, "UPDATE_CANDIDATE", runId, policy.version, { at: clock() });
      }
    }

    // --- research: every official page must be read again, or nothing is regenerated ---
    let sources: Awaited<ReturnType<typeof collectPlanSources>>;
    try {
      sources = await collectPlanSources(inputPlan, {
        repo,
        policy,
        fetcher: services.fetcher ?? new MapFetcher(new Map()),
        clock,
      });
    } catch (error) {
      return await keep([`research_failed:${String(error)}`]);
    }
    const { collected, unavailable } = sources;
    if (unavailable.length > 0) return await keep(unavailable.map((url) => `source_unavailable:${url}`));

    let facts: Fact[];
    try {
      facts = await extractPlanFacts(collected, { repo, policy, extractor: services.extractor });
    } catch (error) {
      return await keep([error instanceof BudgetExceededError ? "budget_stopped" : `research_failed:${String(error)}`]);
    }
    // --- a plan kept as a brief takes its amounts from quotes of this cycle's pages (docs/18) ---
    const completed = await draftPlanFromPages(inputPlan, {
      repo,
      policy,
      clock,
      selector: services.quoteSelector,
      collected,
    });
    if (!completed.ok) return await keep(["plan_draft_failed", ...completed.issues]);
    const currentPlan = completed.plan;
    // The quotes the amounts were read from are part of this cycle's evidence, like the extracted facts.
    const evidence: PlanEvidence = {
      sources: collected.map((source) => source.record),
      facts: [...facts, ...(completed.facts ?? [])],
    };

    // --- analysis ---
    const calculations = computeCalculations(currentPlan);
    for (const calculation of calculations) {
      await repo.analyses.save({
        id: newId("ana"),
        opportunityId: inputPlan.keyword,
        sourceIds: evidence.sources.map((source) => source.id),
        assumptions: Object.fromEntries(calculation.assumptions.entries()),
        formulaVersion: calculation.formulaVersion,
        result: calculation as unknown as Record<string, unknown>,
        checkedAt: clock().toISOString(),
      });
    }

    // --- draft + QA against this cycle's evidence only ---
    const freshness = createFreshnessPolicy(policy);
    let plan = currentPlan;
    let attempts = 0;
    let decision: QualityDecision;
    let draft: Awaited<ReturnType<typeof buildDraftFor>>;
    while (true) {
      try {
        draft = await buildDraftFor(plan, repo, clock, evidence);
      } catch (error) {
        if (error instanceof DraftRejectedError) return await keep(["draft_rejected"]);
        throw error;
      }
      const qa = new QaEngine(policy, {
        freshness,
        existingContentHashes: await existingHashes(repo, plan.slug),
      });
      decision = qa.evaluate({
        draft,
        facts: evidence.facts,
        planEvidenceIssues: checkPlanEvidence(
          plan,
          evidence.facts.filter((fact) => freshness.isFactUsable(fact, clock())),
          evidence.sources,
        ),
        offers: await repo.offers.listOffers(),
        sources: evidence.sources,
        itemId: item.id,
        revisionId: newId("rev"),
        now: clock(),
      });
      if (decision.status === "PASS" || !services.repair || attempts >= policy.limits.qa_repair_attempts) break;
      attempts += 1;
      plan = await services.repair(plan, attempts, decision);
    }
    if (decision.status !== "PASS") {
      return await keep([`qa_${decision.status}`], {
        qaStatus: decision.status,
        qaFailures: decision.checks.filter((check) => check.status !== "PASS"),
      });
    }

    // --- publish: replaces the live file; a rejected or failed publish restores it ---
    if (!dryRun) {
      await repo.content.saveQaReport(decision);
      await repo.content.saveRevision({
        id: decision.revisionId,
        itemId: item.id,
        contentHash: decision.artifactHash,
        markdownPath: `content/articles/${plan.slug}.${locale}.md`,
        qaReportId: decision.id,
        sourceIds: evidence.sources.map((source) => source.id),
      });
    }
    const publisher = new PublisherAgent({
      repo,
      policy,
      logger: trace,
      io: services.publisherIO,
      siteContentDir: "content/articles",
      clock,
    });
    const target: PublishTarget = { destination: dryRun ? "preview" : "git", previewDir: services.previewDir };
    const textArtifact: PublishArtifact = {
      itemId: item.id,
      revisionId: decision.revisionId,
      slug: plan.slug,
      locale: draft.locale,
      title: draft.title,
      description: plan.purpose,
      markdown: draft.bodyMarkdown,
      contentHash: decision.artifactHash,
      qa: decision,
      offerIds: draft.offerIds,
    };
    const offers = await repo.offers.listOffers();
    const artifact = await withHeroImage(textArtifact, { plan, services, publisher, target, offers, logger: trace });
    const outcome = await publisher.publish({ artifact, target, item: current, kind: "update" }, offers);
    if (!outcome.published) return await keep([outcome.reason], { qaStatus: "PASS" });

    if (dryRun) {
      return result("previewed", [], { qaStatus: "PASS", revisionId: decision.revisionId });
    }

    // The article is live: only now does the item's state follow (docs/04 state machine).
    await repo.content.setCurrentRevision(item.id, decision.revisionId);
    const path: ContentState[] = [
      "RESEARCHED",
      "ANALYZED",
      "DRAFTED",
      "QA_PENDING",
      "APPROVED_AUTOMATICALLY",
      "DEPLOYING",
      "PUBLISHED",
    ];
    for (const [index, to] of path.entries()) {
      current = await transition(repo, current, to, runId, policy.version, {
        at: clock(),
        evidenceIds: index === 0 ? facts.map((fact) => fact.id) : [],
      });
    }
    await repo.jobs.update({ ...job!, state: "SUCCEEDED" });
    await repo.audit.append({
      runId,
      agent: "updater",
      eventType: "article.updated",
      payload: {
        slug: plan.slug,
        trigger: trigger.kind,
        revisionId: decision.revisionId,
        replacedRevisionId: baseRevisionId,
        commit: outcome.publication.commitSha,
      },
      at: clock().toISOString(),
    });
    trace.info("article updated", { revision: decision.revisionId, commit: outcome.publication.commitSha });
    return {
      itemId: item.id,
      slug: plan.slug,
      trigger: trigger.kind,
      outcome: "updated",
      finalState: current.state,
      qaStatus: "PASS",
      revisionId: decision.revisionId,
      commitSha: outcome.publication.commitSha,
      reasons: [],
    };
  } catch (error) {
    // An unexpected failure is not swallowed: the cycle is retried later and the run fails loudly.
    await scheduleRetry(`error:${String(error)}`).catch(() => undefined);
    trace.error("update failed unexpectedly", { error });
    throw error;
  }
}

export interface PlanRunResult extends PipelineResult {
  action: "pipeline" | "update";
  update?: UpdateResult;
}

export interface RunPlanOptions {
  /** Names a generator change; every live article of the plans is regenerated once per revision. */
  templateRevision?: string;
}

/**
 * One plan, one daily run: a new article goes through the publishing pipeline,
 * a live article that is stale (UPDATE_CANDIDATE) or whose template revision
 * was named goes through the update path, any other live article is left alone.
 */
export async function runPlan(
  plan: ArticlePlan,
  services: PipelineServices,
  options: RunPlanOptions = {},
): Promise<PlanRunResult> {
  const item = await services.repo.content.getBySlug(plan.slug, plan.locale ?? "ja-JP");
  if (item && isLiveState(item.state)) {
    const trigger: UpdateTrigger | undefined = options.templateRevision
      ? { kind: "template", revision: options.templateRevision }
      : item.state === "UPDATE_CANDIDATE"
        ? { kind: "stale" }
        : undefined;
    if (trigger) {
      const update = await runArticleUpdate(plan, services, trigger);
      const qa = update.qaStatus ?? (await services.repo.content.getLatestQaReport(update.itemId))?.status ?? "UNKNOWN";
      return {
        itemId: update.itemId,
        slug: update.slug,
        finalState: update.finalState,
        qaStatus: qa,
        published: update.outcome === "updated" || update.outcome === "previewed",
        ...(update.outcome === "kept_previous" || update.outcome === "skipped"
          ? { publishReason: update.reasons[0] }
          : {}),
        ...(update.qaFailures ? { qaFailures: update.qaFailures } : {}),
        reasons: update.reasons,
        action: "update",
        update,
      };
    }
  }
  return { ...(await runArticlePipeline(plan, services)), action: "pipeline" };
}
