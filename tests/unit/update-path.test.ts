import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { createLogger, parsePolicyText, type PolicyConfig } from "@aff/domain";
import { FetchError, type Fetcher } from "@aff/integrations";
import {
  FixtureFactExtractor,
  PublisherAgent,
  refreshSweep,
  runArticlePipeline,
  runArticleUpdate,
  runPlan,
  updateJobKey,
  type ArticlePlan,
  type PublisherIO,
} from "@aff/agents";
import { readFileSync } from "./helpers.js";

const DAY_MS = 86_400_000;
const T0 = new Date("2026-10-27T04:44:25.000Z");
const PAGE_URL = "https://sim-a.example.com/price";
const SLUG = "update-sim-24month";
const PATH = `content/articles/${SLUG}.ja-JP.md`;

const basePolicy = parsePolicyText(
  readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"),
);
const livePolicy: PolicyConfig = { ...basePolicy, flags: { ...basePolicy.flags, publish_enabled: true } };

function pageWith(monthlyJpy: number): string {
  return `<html><body><p>SIM A 20GB</p>
  <script type="application/x-aff-facts">[
    {"text":"SIM A 20GBの月額基本料は${monthlyJpy}円","claimType":"price"},
    {"text":"SIM Aの事務手数料は3300円","claimType":"price"}
  ]</script></body></html>`;
}

function planOf(slug: string, title = "更新パス確認"): ArticlePlan {
  return {
    slug,
    title,
    audience: "a",
    purpose: "p",
    verticalId: "mobile",
    keyword: "k",
    sourceUrls: [PAGE_URL],
    calculators: [
      {
        calculator: "sim",
        input: { offerId: "offer-x", title: "SIM A 20GB", monthlyJpy: 2980, dataGb: 20, initialFeeJpy: 3300, months: 24 },
        factEvidenceTerms: ["SIM A"],
      },
    ],
    offerIds: [],
  };
}

const PLAN = planOf(SLUG);

/** An in-memory stand-in for LivePublisherIO: files, build and git commits. */
class FakeSite implements PublisherIO {
  readonly files = new Map<string, string>();
  readonly commits: { path: string; message: string }[] = [];
  failBuild = false;
  async writeArtifact(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async readArtifact(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async removeArtifact(path: string): Promise<void> {
    this.files.delete(path);
  }
  async buildSite(): Promise<void> {
    if (this.failBuild) throw new Error("site build failed");
  }
  async commitArtifact(path: string, message: string): Promise<string> {
    this.commits.push({ path, message });
    return `sha${this.commits.length}`;
  }
}

function setup(policy: PolicyConfig = livePolicy) {
  const repo = createMemoryRepository();
  const site = new FakeSite();
  const page = { monthlyJpy: 2980, unavailable: false };
  const calls = { fetch: 0, extract: 0 };
  const clock = { now: T0 };
  const fetcher: Fetcher = {
    async fetch(url) {
      calls.fetch += 1;
      if (page.unavailable) throw new FetchError(url, 503, "service unavailable");
      return { status: 200, body: pageWith(page.monthlyJpy), contentType: "text/html", finalUrl: url };
    },
  };
  const fixture = new FixtureFactExtractor();
  const extractor = {
    async extract(body: string, contentType: string) {
      calls.extract += 1;
      return fixture.extract(body, contentType);
    },
  };
  const services = {
    repo,
    policy,
    logger: createLogger({ level: "error", sink: () => undefined }),
    fetcher,
    extractor,
    publisherIO: site,
    clock: () => clock.now,
  };
  return { repo, site, page, calls, clock, services };
}

/** Publishes the plan once, as the daily run does for a new article. */
async function publishFirst(env: ReturnType<typeof setup>, plan: ArticlePlan = PLAN) {
  const first = await runArticlePipeline(plan, env.services);
  expect(first.finalState).toBe("PUBLISHED");
  expect(first.published).toBe(true);
}

async function statesOf(env: ReturnType<typeof setup>): Promise<string[]> {
  const item = await env.repo.content.getBySlug(SLUG, "ja-JP");
  return (await env.repo.content.listTransitions(item!.id)).map((t) => t.toState);
}

describe("published articles are never re-run by the new-article pipeline", () => {
  it("returns already_published under a new policy version instead of throwing", async () => {
    const env = setup();
    await publishFirst(env);
    const before = env.site.files.get(PATH);
    const fetches = env.calls.fetch;

    const again = await runArticlePipeline(PLAN, {
      ...env.services,
      policy: { ...livePolicy, version: "v2-after-template-change" },
    });

    expect(again.published).toBe(true);
    expect(again.finalState).toBe("PUBLISHED");
    expect(again.reasons).toContain("already_published");
    expect(env.site.files.get(PATH)).toBe(before);
    expect(env.calls.fetch).toBe(fetches);
  });
});

describe("refresh sweep reaches UPDATE_CANDIDATE through legal transitions", () => {
  it("records PUBLISHED -> MEASURING -> UPDATE_CANDIDATE when facts expire", async () => {
    const env = setup();
    await publishFirst(env);
    env.clock.now = new Date(T0.getTime() + 8 * DAY_MS);

    const sweep = await refreshSweep(env.repo, livePolicy, env.clock.now);

    expect(sweep.updateCandidates).toEqual([SLUG]);
    expect((await env.repo.content.getBySlug(SLUG, "ja-JP"))?.state).toBe("UPDATE_CANDIDATE");
    expect((await statesOf(env)).slice(-2)).toEqual(["MEASURING", "UPDATE_CANDIDATE"]);
  });

  it("judges staleness from the live revision, not from a candidate that never went live", async () => {
    const env = setup();
    await publishFirst(env);
    const item = (await env.repo.content.getBySlug(SLUG, "ja-JP"))!;
    // A later QA-passed revision that was never deployed must not hide the stale live one.
    await env.repo.content.saveRevision({
      id: "rev_orphan",
      itemId: item.id,
      contentHash: "orphan",
      markdownPath: PATH,
      sourceIds: ["src_not_stale"],
    });
    await env.repo.sources.save({
      id: "src_not_stale",
      canonicalUrl: PAGE_URL,
      sourceType: "official",
      fetchedAt: new Date(T0.getTime() + 8 * DAY_MS).toISOString(),
      hash: "h",
      provenance: "t",
      contentType: "text/html",
    });
    await env.repo.facts.save({
      id: "fact_not_stale",
      text: "fresh",
      claimType: "price",
      sourceIds: ["src_not_stale"],
      verifiedAt: new Date(T0.getTime() + 8 * DAY_MS).toISOString(),
      confidence: 1,
      verificationStatus: "VERIFIED",
    });

    const sweep = await refreshSweep(env.repo, livePolicy, new Date(T0.getTime() + 8 * DAY_MS));

    expect(sweep.updateCandidates).toEqual([SLUG]);
  });

  it("revokes an item waiting for an update when one of its facts is INVALID", async () => {
    const env = setup();
    await publishFirst(env);
    env.clock.now = new Date(T0.getTime() + 8 * DAY_MS);
    await refreshSweep(env.repo, livePolicy, env.clock.now);
    const facts = await env.repo.facts.listAll();
    await env.repo.facts.save({ ...facts[0]!, verificationStatus: "INVALID" });

    const sweep = await refreshSweep(env.repo, livePolicy, env.clock.now);

    expect(sweep.revoked).toEqual([SLUG]);
    expect((await env.repo.content.getBySlug(SLUG, "ja-JP"))?.state).toBe("REVOKED");
  });
});

describe("stale facts: UPDATE_CANDIDATE is regenerated and replaced", () => {
  it("re-runs research, analysis, draft and QA, overwrites the file and commits 'update: <slug>'", async () => {
    const env = setup();
    await publishFirst(env);
    const published = env.site.files.get(PATH)!;
    env.clock.now = new Date(T0.getTime() + 8 * DAY_MS);
    await refreshSweep(env.repo, livePolicy, env.clock.now);
    const fetchesBefore = env.calls.fetch;

    const result = await runPlan(PLAN, env.services);

    expect(result.action).toBe("update");
    expect(result.update?.outcome).toBe("updated");
    expect(result.update?.trigger).toBe("stale");
    expect(result.qaStatus).toBe("PASS");
    expect(result.published).toBe(true);
    expect(env.calls.fetch).toBe(fetchesBefore + 1);

    const updated = env.site.files.get(PATH)!;
    expect(updated).not.toBe(published);
    expect(updated).toContain("最終確認日: 2026-11-04");
    expect(updated).toContain("```chart");
    // the 出典 section lists the new snapshot only, not the expired one
    expect(updated.match(/^- \[公式\]/gm)).toHaveLength(1);
    expect(updated).toContain("確認日時: 2026-11-04T04:44:25.000Z");

    const message = env.site.commits.at(-1)!.message;
    expect(message).toMatch(new RegExp(`^update: ${SLUG}\\b`));
    expect(env.site.commits.at(-1)!.path).toBe(PATH);

    const item = (await env.repo.content.getBySlug(SLUG, "ja-JP"))!;
    expect(item.state).toBe("PUBLISHED");
    expect(item.currentRevision).toBe(result.update?.revisionId);
    expect((await statesOf(env)).slice(-9)).toEqual([
      "MEASURING",
      "UPDATE_CANDIDATE",
      "RESEARCHED",
      "ANALYZED",
      "DRAFTED",
      "QA_PENDING",
      "APPROVED_AUTOMATICALLY",
      "DEPLOYING",
      "PUBLISHED",
    ]);

    // once refreshed, the next sweep finds nothing stale
    const sweep = await refreshSweep(env.repo, livePolicy, env.clock.now);
    expect(sweep.updateCandidates).toEqual([]);
  });

  it("a repeated trigger while the item is already refreshed does nothing", async () => {
    const env = setup();
    await publishFirst(env);
    env.clock.now = new Date(T0.getTime() + 8 * DAY_MS);
    await refreshSweep(env.repo, livePolicy, env.clock.now);
    await runPlan(PLAN, env.services);
    const commits = env.site.commits.length;
    const fetches = env.calls.fetch;

    const again = await runPlan(PLAN, env.services);

    expect(again.action).toBe("pipeline");
    expect(again.reasons).toContain("already_published");
    expect(env.site.commits).toHaveLength(commits);
    expect(env.calls.fetch).toBe(fetches);
  });

  it("an explicit stale update on an item that is not UPDATE_CANDIDATE is skipped", async () => {
    const env = setup();
    await publishFirst(env);

    const result = await runArticleUpdate(PLAN, env.services, { kind: "stale" });

    expect(result.outcome).toBe("skipped");
    expect(result.reasons).toContain("not_update_candidate");
  });
});

describe("template change: operator input regenerates a published article", () => {
  it("adds the figures to an article published before the chart blocks existed", async () => {
    const env = setup();
    await publishFirst(env);
    // the live file as it was before figures: same article, no chart blocks
    env.site.files.set(PATH, env.site.files.get(PATH)!.replace(/```chart[\s\S]*?```\n?/g, ""));
    expect(env.site.files.get(PATH)).not.toContain("```chart");

    const result = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });

    expect(result.update?.outcome).toBe("updated");
    expect(result.update?.trigger).toBe("template");
    expect(env.site.files.get(PATH)).toContain("```chart");
    expect(env.site.commits.at(-1)!.message).toMatch(new RegExp(`^update: ${SLUG}\\b`));
    expect((await statesOf(env)).slice(-9, -7)).toEqual(["MEASURING", "UPDATE_CANDIDATE"]);
    expect((await env.repo.content.getBySlug(SLUG, "ja-JP"))?.state).toBe("PUBLISHED");
  });

  it("repeating the same revision is idempotent; a new revision runs a new cycle", async () => {
    const env = setup();
    await publishFirst(env);
    await runPlan(PLAN, env.services, { templateRevision: "figures-1" });
    const commits = env.site.commits.length;
    const fetches = env.calls.fetch;

    const repeat = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });
    expect(repeat.update?.outcome).toBe("skipped");
    expect(repeat.reasons).toContain("already_completed");
    expect(env.site.commits).toHaveLength(commits);
    expect(env.calls.fetch).toBe(fetches);

    const next = await runPlan(PLAN, env.services, { templateRevision: "figures-2" });
    expect(next.update?.outcome).toBe("updated");
    expect(env.site.commits).toHaveLength(commits + 1);
  });

  it("job keys separate cycles by trigger, revision and policy version", () => {
    const a = updateJobKey(SLUG, "ja-JP", { kind: "template", revision: "r1" }, "v1");
    expect(a).toBe(updateJobKey(SLUG, "ja-JP", { kind: "template", revision: "r1" }, "v1"));
    expect(a).not.toBe(updateJobKey(SLUG, "ja-JP", { kind: "template", revision: "r2" }, "v1"));
    expect(a).not.toBe(updateJobKey(SLUG, "ja-JP", { kind: "template", revision: "r1" }, "v2"));
    expect(a).not.toBe(updateJobKey(SLUG, "ja-JP", { kind: "stale", baseRevisionId: "r1" }, "v1"));
    expect(a).not.toBe(updateJobKey("other", "ja-JP", { kind: "template", revision: "r1" }, "v1"));
  });

  it("only compares against evidence collected in this cycle, not older still-fresh facts", async () => {
    const env = setup();
    await publishFirst(env);
    // the page changed the next day; the old 2980 fact is still within 7 days
    env.clock.now = new Date(T0.getTime() + DAY_MS);
    env.page.monthlyJpy = 3280;
    const before = env.site.files.get(PATH);

    const result = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });

    expect(result.update?.outcome).toBe("kept_previous");
    expect(result.update?.qaFailures?.map((c) => c.id)).toContain("plan_numbers_match_facts");
    expect(env.site.files.get(PATH)).toBe(before);
  });
});

describe("failures keep the previous version live", () => {
  it("QA failure: file untouched, no commit, item stays UPDATE_CANDIDATE, retry waits for tomorrow", async () => {
    const env = setup();
    await publishFirst(env);
    const published = env.site.files.get(PATH)!;
    const commits = env.site.commits.length;
    const liveRevision = (await env.repo.content.getBySlug(SLUG, "ja-JP"))!.currentRevision;
    env.clock.now = new Date(T0.getTime() + 8 * DAY_MS);
    env.page.monthlyJpy = 3280; // the plan still says 2980 -> numbers no longer match the page
    await refreshSweep(env.repo, livePolicy, env.clock.now);

    const result = await runPlan(PLAN, env.services);

    expect(result.update?.outcome).toBe("kept_previous");
    expect(result.qaStatus).toBe("FAIL");
    expect(result.update?.qaFailures?.map((c) => c.id)).toContain("plan_numbers_match_facts");
    expect(result.published).toBe(false);
    expect(env.site.files.get(PATH)).toBe(published);
    expect(env.site.commits).toHaveLength(commits);
    const item = (await env.repo.content.getBySlug(SLUG, "ja-JP"))!;
    expect(item.state).toBe("UPDATE_CANDIDATE");
    // the revision that is live is still the current one; the failed candidate never replaced it
    expect(item.currentRevision).toBe(liveRevision);
    const job = await env.repo.jobs.getByJobKey(
      updateJobKey(SLUG, "ja-JP", { kind: "stale", baseRevisionId: item.currentRevision! }, livePolicy.version),
    );
    expect(job?.state).toBe("RETRY_SCHEDULED");

    // the same day: nothing is fetched again
    const fetches = env.calls.fetch;
    env.clock.now = new Date(env.clock.now.getTime() + 3_600_000);
    const sameDay = await runPlan(PLAN, env.services);
    expect(sameDay.update?.outcome).toBe("skipped");
    expect(sameDay.reasons).toContain("retry_not_due");
    expect(env.calls.fetch).toBe(fetches);

    // the next day, with the page matching the plan again, the same cycle completes
    env.clock.now = new Date(T0.getTime() + 9 * DAY_MS);
    env.page.monthlyJpy = 2980;
    const nextDay = await runPlan(PLAN, env.services);
    expect(nextDay.update?.outcome).toBe("updated");
    expect(env.site.commits).toHaveLength(commits + 1);
    expect(
      (await env.repo.jobs.getByJobKey(
        updateJobKey(SLUG, "ja-JP", { kind: "stale", baseRevisionId: item.currentRevision! }, livePolicy.version),
      ))?.state,
    ).toBe("SUCCEEDED");
  });

  it("gives up after task_retry_attempts failed days and stops spending", async () => {
    const env = setup();
    await publishFirst(env);
    env.clock.now = new Date(T0.getTime() + 8 * DAY_MS);
    env.page.monthlyJpy = 3280;
    await refreshSweep(env.repo, livePolicy, env.clock.now);
    const item = (await env.repo.content.getBySlug(SLUG, "ja-JP"))!;
    const key = updateJobKey(SLUG, "ja-JP", { kind: "stale", baseRevisionId: item.currentRevision! }, livePolicy.version);

    for (let attempt = 1; attempt <= livePolicy.limits.task_retry_attempts; attempt += 1) {
      const result = await runPlan(PLAN, env.services);
      expect(result.update?.outcome).toBe("kept_previous");
      env.clock.now = new Date(env.clock.now.getTime() + DAY_MS);
    }
    expect((await env.repo.jobs.getByJobKey(key))?.state).toBe("DEAD_LETTER");

    const fetches = env.calls.fetch;
    const after = await runPlan(PLAN, env.services);
    expect(after.update?.outcome).toBe("skipped");
    expect(after.reasons).toContain("dead_lettered");
    expect(env.calls.fetch).toBe(fetches);
    expect((await env.repo.content.getBySlug(SLUG, "ja-JP"))?.state).toBe("UPDATE_CANDIDATE");
  });

  it("unavailable source: nothing is extracted (no LLM spend) and the old file stays", async () => {
    const env = setup();
    await publishFirst(env);
    const published = env.site.files.get(PATH)!;
    const extracts = env.calls.extract;
    env.page.unavailable = true;

    const result = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });

    expect(result.update?.outcome).toBe("kept_previous");
    expect(result.update?.reasons).toContain(`source_unavailable:${PAGE_URL}`);
    expect(env.calls.extract).toBe(extracts);
    expect(env.site.files.get(PATH)).toBe(published);
  });

  it("build failure: the previous file content is restored and nothing is committed", async () => {
    const env = setup();
    await publishFirst(env);
    const published = env.site.files.get(PATH)!;
    const commits = env.site.commits.length;
    env.site.failBuild = true;

    const result = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });

    expect(result.update?.outcome).toBe("kept_previous");
    expect(result.update?.reasons).toContain("publish_failed");
    expect(env.site.files.get(PATH)).toBe(published);
    expect(env.site.commits).toHaveLength(commits);
    const item = (await env.repo.content.getBySlug(SLUG, "ja-JP"))!;
    expect(item.state).toBe("UPDATE_CANDIDATE");
  });

  it("budget gate: over the monthly limit nothing is fetched or generated", async () => {
    const env = setup();
    await publishFirst(env);
    await env.repo.spend.recordSpend({
      date: "2026-10-27",
      category: "llm",
      provider: "test",
      costJpy: livePolicy.limits.monthly_operating_cost_jpy + 1,
      source: "test",
      estimated: true,
    });
    const fetches = env.calls.fetch;

    const result = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });

    expect(result.update?.outcome).toBe("kept_previous");
    expect(result.update?.reasons).toContain("budget_stopped");
    expect(env.calls.fetch).toBe(fetches);
  });

  it("a revoked article is never updated back to life by this path", async () => {
    const env = setup();
    await publishFirst(env);
    const item = (await env.repo.content.getBySlug(SLUG, "ja-JP"))!;
    await env.repo.content.updateState(item.id, "REVOKED");
    const fetches = env.calls.fetch;

    const result = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });

    expect(result.finalState).toBe("REVOKED");
    expect(result.published).toBe(false);
    expect(env.calls.fetch).toBe(fetches);
  });

  it("a job still running is not started twice; a long-dead one is taken over", async () => {
    const env = setup();
    await publishFirst(env);
    const key = updateJobKey(SLUG, "ja-JP", { kind: "template", revision: "figures-1" }, livePolicy.version);
    const { record } = await env.repo.jobs.enqueue({ jobKey: key, jobType: "article_update", traceId: "trace" });
    await env.repo.jobs.update({ ...record, state: "RUNNING" });
    env.clock.now = new Date();

    const busy = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });
    expect(busy.update?.outcome).toBe("skipped");
    expect(busy.reasons).toContain("in_progress");

    env.clock.now = new Date(Date.now() + (livePolicy.limits.max_job_duration_seconds + 60) * 1000);
    const takeover = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });
    expect(takeover.update?.outcome).toBe("updated");
  });
});

describe("new_articles_per_day counts new articles, not updates", () => {
  it("an update on the day of a new article is allowed, and the new-article cap still holds", async () => {
    const env = setup();
    await publishFirst(env); // the one new article of the day (cap: 1)

    const update = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });
    expect(update.update?.outcome).toBe("updated");

    const second = await runPlan(planOf("second-new-article", "別の記事"), env.services);
    expect(second.published).toBe(false);
    expect(second.publishReason).toBe("daily_limit");
  });

  it("an update does not use up the day's slot for a new article", async () => {
    const env = setup();
    await publishFirst(env);
    env.clock.now = new Date(T0.getTime() + DAY_MS);

    const update = await runPlan(PLAN, env.services, { templateRevision: "figures-1" });
    expect(update.update?.outcome).toBe("updated");

    const fresh = await runPlan(planOf("second-new-article", "別の記事"), env.services);
    expect(fresh.published).toBe(true);
    expect(fresh.finalState).toBe("PUBLISHED");
  });
});

describe("first publication: a failed build leaves no file and no PUBLISHED state", () => {
  it("quarantines the item and removes the file it wrote", async () => {
    const env = setup();
    env.site.failBuild = true;

    const result = await runArticlePipeline(PLAN, env.services);

    expect(result.published).toBe(false);
    expect(result.finalState).toBe("QUARANTINED");
    expect(result.publishReason).toBe("publish_failed");
    expect(env.site.files.has(PATH)).toBe(false);
    expect(env.site.commits).toHaveLength(0);
  });
});

describe("publishing disabled: the update is a preview only", () => {
  it("writes the preview, keeps the live file, item state and jobs untouched", async () => {
    const env = setup();
    await publishFirst(env);
    const live = env.site.files.get(PATH)!;
    const preview = new FakeSite();
    const previewPolicy: PolicyConfig = { ...livePolicy, flags: { ...livePolicy.flags, publish_enabled: false } };

    const result = await runPlan(
      PLAN,
      { ...env.services, policy: previewPolicy, publisherIO: preview, previewDir: "/tmp/preview" },
      { templateRevision: "figures-1" },
    );

    expect(result.update?.outcome).toBe("previewed");
    expect(result.qaStatus).toBe("PASS");
    expect(preview.files.get(PATH)).toContain("```chart");
    expect(preview.commits).toHaveLength(0);
    expect(env.site.files.get(PATH)).toBe(live);
    expect((await env.repo.content.getBySlug(SLUG, "ja-JP"))?.state).toBe("PUBLISHED");
    const key = updateJobKey(SLUG, "ja-JP", { kind: "template", revision: "figures-1" }, previewPolicy.version);
    expect(await env.repo.jobs.getByJobKey(key)).toBeUndefined();
  });
});

describe("the update publish kind cannot be used to dodge the new-article cap", () => {
  it("is refused for an item that is not live", async () => {
    const env = setup();
    const publisher = new PublisherAgent({
      repo: env.repo,
      policy: livePolicy,
      logger: createLogger({ level: "error", sink: () => undefined }),
      io: env.site,
      siteContentDir: "content/articles",
    });
    const item = await env.repo.content.createIfNotExists({ slug: "never-published", locale: "ja-JP", topic: "mobile" });

    const outcome = await publisher.publish(
      { artifact: { slug: "never-published" } as never, target: { destination: "git" }, item, kind: "update" },
      [],
    );

    expect(outcome).toEqual({ published: false, reason: "update_without_live_article" });
    expect(env.site.files.size).toBe(0);
  });
});
