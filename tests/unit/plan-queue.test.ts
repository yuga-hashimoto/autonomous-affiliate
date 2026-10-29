import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { createLogger, parsePolicyText, type PolicyConfig } from "@aff/domain";
import { type Fetcher } from "@aff/integrations";
import {
  FixtureFactExtractor,
  holdForDailyCap,
  newArticleCapReached,
  runArticlePipeline,
  runPlanQueue,
  splitByAllowlist,
  type ArticlePlan,
  type PublisherIO,
} from "@aff/agents";
import { readFileSync } from "./helpers.js";

const DAY_MS = 86_400_000;
const T0 = new Date("2026-10-27T04:44:25.000Z");
const ALLOWED = "sim-a.example.com";
const PAGE_URL = `https://${ALLOWED}/price`;

const basePolicy = parsePolicyText(
  readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"),
);
const livePolicy: PolicyConfig = { ...basePolicy, flags: { ...basePolicy.flags, publish_enabled: true } };
const previewPolicy: PolicyConfig = { ...livePolicy, flags: { ...livePolicy.flags, publish_enabled: false } };

const PAGE = `<html><body><p>SIM A 20GB</p>
  <script type="application/x-aff-facts">[
    {"text":"SIM A 20GBの月額基本料は2980円","claimType":"price"},
    {"text":"SIM Aの事務手数料は3300円","claimType":"price"}
  ]</script></body></html>`;

function planOf(slug: string, sourceUrls: string[] = [PAGE_URL]): ArticlePlan {
  return {
    slug,
    title: `在庫の記事 ${slug}`,
    audience: "a",
    purpose: "p",
    verticalId: "mobile",
    keyword: "k",
    sourceUrls,
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

class FakeSite implements PublisherIO {
  readonly files = new Map<string, string>();
  async writeArtifact(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async readArtifact(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async removeArtifact(path: string): Promise<void> {
    this.files.delete(path);
  }
  async buildSite(): Promise<void> {}
  async commitArtifact(path: string): Promise<string> {
    return `sha-${path}`;
  }
}

function setup(policy: PolicyConfig = livePolicy) {
  const repo = createMemoryRepository();
  const clock = { now: T0 };
  const fetched: string[] = [];
  const fetcher: Fetcher = {
    async fetch(url) {
      fetched.push(url);
      return { status: 200, body: PAGE, contentType: "text/html", finalUrl: url };
    },
  };
  const services = {
    repo,
    policy,
    logger: createLogger({ level: "error", sink: () => undefined }),
    fetcher,
    extractor: new FixtureFactExtractor(),
    publisherIO: new FakeSite(),
    clock: () => clock.now,
  };
  return { repo, clock, fetched, services };
}

describe("splitByAllowlist: a plan waits for its domains instead of stopping the run", () => {
  it("runs plans whose every source is on the allowlist, in file order, and holds the rest", () => {
    const plans = [
      planOf("first"),
      planOf("other-company", ["https://other.example.org/price"]),
      planOf("third"),
    ];

    const { runnable, held } = splitByAllowlist(plans, [ALLOWED]);

    expect(runnable.map((p) => p.slug)).toEqual(["first", "third"]);
    expect(held).toEqual([
      expect.objectContaining({ slug: "other-company", reason: "domain_not_allowlisted" }),
    ]);
    expect(held[0]?.detail).toContain("other.example.org");
  });

  it("accepts subdomains and ignores case, but never a look-alike domain", () => {
    const { runnable, held } = splitByAllowlist(
      [
        planOf("sub", [`https://WWW.${ALLOWED}/price`]),
        planOf("lookalike", [`https://not-${ALLOWED}/price`]),
        planOf("suffix-trick", [`https://${ALLOWED}.evil.example.org/price`]),
      ],
      [ALLOWED.toUpperCase()],
    );

    expect(runnable.map((p) => p.slug)).toEqual(["sub"]);
    expect(held.map((h) => h.slug)).toEqual(["lookalike", "suffix-trick"]);
  });

  it("holds a plan when any one of its sources is not allowed", () => {
    const { runnable, held } = splitByAllowlist(
      [planOf("mixed", [PAGE_URL, "https://other.example.org/price"])],
      [ALLOWED],
    );

    expect(runnable).toEqual([]);
    expect(held[0]).toMatchObject({ slug: "mixed", reason: "domain_not_allowlisted" });
  });

  it("holds a plan with an unreadable source URL rather than failing every other plan", () => {
    const { runnable, held } = splitByAllowlist([planOf("typo", ["not a url"]), planOf("fine")], [ALLOWED]);

    expect(runnable.map((p) => p.slug)).toEqual(["fine"]);
    expect(held[0]).toMatchObject({ slug: "typo", reason: "invalid_source_url" });
  });
});

describe("newArticleCapReached / holdForDailyCap", () => {
  it("is false until the day's cap of new articles is used, then true", async () => {
    const env = setup();
    expect(await newArticleCapReached(env.repo, livePolicy, T0)).toBe(false);

    await runArticlePipeline(planOf("a"), env.services);

    expect(await newArticleCapReached(env.repo, livePolicy, T0)).toBe(true);
    expect(await newArticleCapReached(env.repo, livePolicy, new Date(T0.getTime() + DAY_MS))).toBe(false);
  });

  it("defers a new plan once the cap is used, but never a plan that is already live", async () => {
    const env = setup();
    await runArticlePipeline(planOf("live"), env.services);

    expect(await holdForDailyCap(planOf("next"), env.services)).toMatchObject({ slug: "next", reason: "daily_limit" });
    expect(await holdForDailyCap(planOf("live"), env.services)).toBeUndefined();
  });

  it("does not apply when nothing is published (dry-run and preview have no cap)", async () => {
    const env = setup(previewPolicy);
    await runArticlePipeline(planOf("a"), env.services);

    expect(await holdForDailyCap(planOf("b"), env.services)).toBeUndefined();
  });
});

describe("runPlanQueue: a stock of plans publishes one new article a day", () => {
  it("publishes the first plan, defers the others without researching them, and carries on the next day", async () => {
    const env = setup();
    const stock = [planOf("a"), planOf("b"), planOf("c")];
    const options = { allowedDomains: [ALLOWED] };

    const day1 = await runPlanQueue(stock, env.services, options);
    expect(day1.results.map((r) => [r.slug, r.published])).toEqual([["a", true]]);
    expect(day1.held.map((h) => [h.slug, h.reason])).toEqual([
      ["b", "daily_limit"],
      ["c", "daily_limit"],
    ]);
    // Deferred plans leave no trace: no item, no job, no page read, so nothing is quarantined for good.
    expect(env.fetched).toHaveLength(1);
    expect(await env.repo.content.getBySlug("b", "ja-JP")).toBeUndefined();
    expect(await env.repo.jobs.getByJobKey(`pipeline|b|${livePolicy.version}`)).toBeUndefined();

    env.clock.now = new Date(T0.getTime() + DAY_MS);
    const day2 = await runPlanQueue(stock, env.services, options);
    expect(day2.results.filter((r) => r.published && r.finalState === "PUBLISHED").map((r) => r.slug)).toContain("b");
    expect(day2.held.map((h) => h.slug)).toEqual(["c"]);

    env.clock.now = new Date(T0.getTime() + 2 * DAY_MS);
    const day3 = await runPlanQueue(stock, env.services, options);
    expect(day3.held).toEqual([]);
    for (const slug of ["a", "b", "c"]) {
      expect((await env.repo.content.getBySlug(slug, "ja-JP"))?.state).toBe("PUBLISHED");
    }
  });

  it("never reads a page of a company whose domain is not allowed yet", async () => {
    const env = setup();
    const stock = [planOf("held-company", ["https://other.example.org/price"]), planOf("ok")];

    const result = await runPlanQueue(stock, env.services, { allowedDomains: [ALLOWED] });

    expect(result.results.map((r) => r.slug)).toEqual(["ok"]);
    expect(result.held).toEqual([expect.objectContaining({ slug: "held-company", reason: "domain_not_allowlisted" })]);
    expect(env.fetched.every((url) => url.startsWith(`https://${ALLOWED}/`))).toBe(true);
  });

  it("still updates a live article on the day its cap is used", async () => {
    const env = setup();
    const stock = [planOf("a"), planOf("b")];
    await runPlanQueue(stock, env.services, { allowedDomains: [ALLOWED] });

    const again = await runPlanQueue(stock, env.services, { allowedDomains: [ALLOWED], templateRevision: "figures-1" });

    expect(again.results.map((r) => [r.slug, r.action, r.update?.outcome ?? null])).toEqual([["a", "update", "updated"]]);
    expect(again.held.map((h) => h.slug)).toEqual(["b"]);
  });

  it("runs every plan when publishing is off, because a preview has no daily cap", async () => {
    const env = setup(previewPolicy);

    const result = await runPlanQueue([planOf("a"), planOf("b"), planOf("c")], env.services, { allowedDomains: [ALLOWED] });

    expect(result.results.map((r) => r.slug)).toEqual(["a", "b", "c"]);
    expect(result.held).toEqual([]);
  });

  it("lets the caller follow a plan with more results (the preview of its update)", async () => {
    const env = setup(previewPolicy);

    const result = await runPlanQueue([planOf("a")], env.services, {
      allowedDomains: [ALLOWED],
      afterPlan: async (plan) => [
        { itemId: "i", slug: `${plan.slug}-after`, finalState: "PUBLISHED", qaStatus: "PASS", published: true, reasons: [], action: "update" },
      ],
    });

    expect(result.results.map((r) => r.slug)).toEqual(["a", "a-after"]);
  });
});
