import { isLiveState } from "@aff/domain";
import type { ArticlePlan, PipelineServices } from "./pipeline.js";
import { newArticleCapReached } from "./publisher.js";
import { runPlan, type PlanRunResult } from "./update.js";

/**
 * Plans are a stock: more can be kept than the policy lets out today. A plan that
 * cannot run yet is held, never failed, and nothing about it is recorded, so it
 * is picked up by a later run without any action on the plan.
 */
export type HoldReason =
  /** A source host is not in `security.allowed_source_domains`: the owner has not cleared that company's terms. */
  | "domain_not_allowlisted"
  /** A source URL cannot be parsed. */
  | "invalid_source_url"
  /** Today's cap of new articles is already used. */
  | "daily_limit";

export interface HeldPlan {
  slug: string;
  reason: HoldReason;
  detail: string;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isAllowedHost(host: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some((domain) => {
    const allowed = domain.toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

/**
 * Separates the plans that may read their sources from those waiting for a domain
 * to be allowed. Order is kept: the stock is worked in file order. A plan needs
 * every one of its sources allowed; one unreadable URL holds only that plan.
 */
export function splitByAllowlist(
  plans: readonly ArticlePlan[],
  allowedDomains: readonly string[],
): { runnable: ArticlePlan[]; held: HeldPlan[] } {
  const runnable: ArticlePlan[] = [];
  const held: HeldPlan[] = [];
  for (const plan of plans) {
    const hosts = plan.sourceUrls.map(hostOf);
    if (hosts.some((host) => host === undefined)) {
      held.push({ slug: plan.slug, reason: "invalid_source_url", detail: "a source URL cannot be parsed" });
      continue;
    }
    const blocked = [...new Set(hosts as string[])].filter((host) => !isAllowedHost(host, allowedDomains));
    if (blocked.length > 0) {
      held.push({
        slug: plan.slug,
        reason: "domain_not_allowlisted",
        detail: `not in the allowlist: ${blocked.join(", ")}`,
      });
      continue;
    }
    runnable.push(plan);
  }
  return { runnable, held };
}

/**
 * Defers a new article when today's cap is already used. Without this a plan the
 * cap turns away at the publish step has already been researched and checked at
 * the model's cost, and is then quarantined with its job marked done, so no later
 * day would publish it. A live article is never deferred: updates are not capped.
 * With publishing off (preview, dry-run) there is no cap to wait for.
 */
export async function holdForDailyCap(plan: ArticlePlan, services: PipelineServices): Promise<HeldPlan | undefined> {
  if (!services.policy.flags.publish_enabled) return undefined;
  const item = await services.repo.content.getBySlug(plan.slug, plan.locale ?? "ja-JP");
  if (item && isLiveState(item.state)) return undefined;
  const now = (services.clock ?? (() => new Date()))();
  if (!(await newArticleCapReached(services.repo, services.policy, now))) return undefined;
  return {
    slug: plan.slug,
    reason: "daily_limit",
    detail: `limits.new_articles_per_day (${services.policy.limits.new_articles_per_day}) is used today`,
  };
}

export interface PlanQueueOptions {
  /** `security.allowed_source_domains`; a plan reading any other host is held. */
  allowedDomains: readonly string[];
  templateRevision?: string;
  /** Results to add straight after a plan's own (the preview of its update). */
  afterPlan?: (plan: ArticlePlan, outcome: PlanRunResult) => Promise<PlanRunResult[]>;
}

export interface PlanQueueResult {
  results: PlanRunResult[];
  held: HeldPlan[];
}

/**
 * One daily run over the stock, in file order. Live articles are updated or left
 * alone, new ones are published up to the day's cap, and every plan that has to
 * wait is reported in `held` instead of stopping the run.
 */
export async function runPlanQueue(
  plans: readonly ArticlePlan[],
  services: PipelineServices,
  options: PlanQueueOptions,
): Promise<PlanQueueResult> {
  const { runnable, held } = splitByAllowlist(plans, options.allowedDomains);
  const results: PlanRunResult[] = [];
  for (const plan of runnable) {
    const deferred = await holdForDailyCap(plan, services);
    if (deferred) {
      held.push(deferred);
      continue;
    }
    const outcome = await runPlan(plan, services, { templateRevision: options.templateRevision });
    results.push(outcome);
    if (options.afterPlan) results.push(...(await options.afterPlan(plan, outcome)));
  }
  return { results, held };
}
