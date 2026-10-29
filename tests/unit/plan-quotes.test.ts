import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { createLogger, parsePolicyText, type PolicyConfig } from "@aff/domain";
import { FetchError, type CollectedSource, type Fetcher } from "@aff/integrations";
import {
  FixtureFactExtractor,
  checkPlanEvidence,
  draftPlanFromPages,
  runArticlePipeline,
  runPlan,
  verifyQuotes,
  type ArticlePlan,
  type PlanDraft,
  type PublisherIO,
  type QuoteRequest,
  type QuoteSelector,
} from "@aff/agents";
import { readFileSync } from "./helpers.js";

const NOW = new Date("2026-10-29T00:00:00.000Z");
const PAGE = "https://water-a.example.com/price";

/** A price page shaped like the real one: cards whose label, figure and server name sit on separate lines. */
function pageHtml(opts: { monthly?: string; included?: string; omit?: string[] } = {}): string {
  const monthly = opts.monthly ?? "3,880円/月";
  const included = opts.included ?? "(税込4,190円)";
  const parts: Record<string, string> = {
    card: `<div>省エネ機能でエコに</div><div>サーバーを使いたい方</div><div>月12.5L×2本ご利用の場合</div><div>${monthly}</div><div>${included}</div><div>サーバーレンタル料</div><div>無料</div><div>選べるウォーターサーバー</div><div>モデルX</div><div>詳しく見る このサーバーで申し込む</div><div>モデルY</div>`,
    other: `<div>デザイン性を重視</div><div>月12.5L×2本ご利用の場合</div><div>4,080円/月</div><div>(税込4,410円)</div><div>選べるウォーターサーバー</div><div>モデルZ</div>`,
    term: `<div>プランP お水代がお得なプラン</div><div>最低利用期間：5年</div><div>プランQ</div><div>最低利用期間：3年</div>`,
    shipping: `<div>送料</div><div>以下記載の地域を除き、</div><div>採水工場より送料無料で配送いたします。</div><div>※エリアにより送料が発生します。</div><div>追加送料</div><div>【離島の場合】</div><div>715円（税込）/1セット</div>`,
    initial: `<div>初回登録事務手数料：3,300円（税込）</div><div>休止事務手数料：880円（税込）</div>`,
    electricity: `<div>モデルX</div><div>月額電気料金</div><div>通常使用時 約669円</div><div>エコモード使用時 約583円</div><div>※ 温水・冷水ともに、各600cc/日、36L/月使用時、27円/kwhとして算出。</div>`,
  };
  const body = Object.entries(parts)
    .filter(([key]) => !(opts.omit ?? []).includes(key))
    .map(([, html]) => html)
    .join("");
  return `<html><head><title>ウォーターA ご利用料金</title></head><body><div>ご利用料金</div>${body}</body></html>`;
}

/** The passages a competent model would copy out of the window, found by pattern rather than by a network call. */
const QUOTE_PATTERNS: RegExp[] = [
  /月12\.5L×2本ご利用の場合\s*[^\n]*\s*\(税込[\d,]+円\)\s*サーバーレンタル料\s*無料\s*選べるウォーターサーバー\s*モデルX/,
  /以下記載の地域を除き、\s*採水工場より送料無料で配送いたします。/,
  /初回登録事務手数料：[\d,]+円（税込）/,
  /プランP お水代がお得なプラン\s*最低利用期間：\d年/,
  /モデルX\s*月額電気料金\s*通常使用時 約[\d,]+円\s*エコモード使用時 約[\d,]+円/,
  /※ 温水・冷水ともに、各600cc\/日、36L\/月使用時、27円\/kwhとして算出。/,
];

class PatternSelector implements QuoteSelector {
  calls: QuoteRequest[] = [];
  async select(request: QuoteRequest): Promise<string[]> {
    this.calls.push(request);
    return QUOTE_PATTERNS.flatMap((pattern) => {
      const match = request.window.match(pattern);
      return match ? [match[0]] : [];
    });
  }
}

const DRAFT: PlanDraft = {
  calculator: "water",
  offerId: "offer-water-a",
  title: "ウォーターA モデルX（プランP）",
  evidenceTerms: ["モデルX", "ウォーターA"],
  priceTerms: ["モデルX"],
  planTerms: ["プランP"],
  months: 24,
  monthlyLiters: 25,
};

function planOf(draft: Partial<PlanDraft> = {}, slug = "quoted-water-a"): ArticlePlan {
  return {
    slug,
    title: "ウォーターAの24ヶ月総額",
    audience: "家庭でウォーターサーバーを検討している人",
    purpose: "公式の料金ページの金額から24ヶ月の総額を試算します。",
    verticalId: "water_delivery",
    keyword: "ウォーターサーバー 総額",
    sourceUrls: [PAGE],
    calculators: [],
    offerIds: [],
    draft: { ...DRAFT, ...draft },
  };
}

const EXPECTED_INPUT = {
  offerId: "offer-water-a",
  title: "ウォーターA モデルX（プランP）",
  waterChargeJpy: 4190,
  shippingFeeJpy: 0,
  electricityFeeJpy: 669,
  electricityIsEstimate: true,
  electricityBasisLiters: 36,
  serverRentalFeeJpy: 0,
  months: 24,
  initialFeeJpy: 3300,
  cancellationFeeJpy: "UNKNOWN",
  monthlyLiters: 25,
  minimumTermMonths: 60,
};

const basePolicy = parsePolicyText(readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"));
const policy: PolicyConfig = {
  ...basePolicy,
  flags: { ...basePolicy.flags, publish_enabled: true },
  security: { ...basePolicy.security, allowed_source_domains: ["water-a.example.com"] },
};

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

function setup(html: string, selector: QuoteSelector | null = new PatternSelector()) {
  const page = { html, unavailable: false };
  const fetcher: Fetcher = {
    async fetch(url) {
      if (page.unavailable) throw new FetchError(url, 503, "service unavailable");
      return { status: 200, body: page.html, contentType: "text/html", finalUrl: url };
    },
  };
  const site = new FakeSite();
  const repo = createMemoryRepository();
  const services = {
    repo,
    policy,
    logger: createLogger({ level: "error", sink: () => undefined }),
    fetcher,
    extractor: new FixtureFactExtractor(),
    publisherIO: site,
    clock: () => NOW,
    ...(selector ? { quoteSelector: selector } : {}),
  };
  return { page, site, repo, services };
}

describe("verifyQuotes: a quote counts only if it is in the page text", () => {
  const TEXT = "ご利用料金\n月12.5L×2本ご利用の場合 | 3,880円/月\n(税込4,190円)\n初回登録事務手数料：3,300円（税込）";

  it("accepts a quote however its line breaks and spacing differ from the page's", () => {
    const { verified, rejected } = verifyQuotes(["月12.5L×2本ご利用の場合 3,880円/月 (税込4,190円)", "初回登録事務手数料： 3,300円 （税込）"], TEXT);

    expect(verified).toHaveLength(2);
    expect(rejected).toBe(0);
  });

  it("rejects a quote whose figure was changed, one that is not on the page, an empty one and an over-long one", () => {
    const { verified, rejected } = verifyQuotes(
      ["月12.5L×2本ご利用の場合 3,880円/月 (税込4,290円)", "送料は常に無料です", "   ", `初回${"あ".repeat(1300)}`],
      TEXT,
    );

    expect(verified).toEqual([]);
    expect(rejected).toBe(4);
  });

  it("rejects a passage that really is on the page but is too long to be one price statement", () => {
    const long = `料金のご案内${"あ".repeat(1300)}3,880円`;

    const { verified, rejected } = verifyQuotes([long], `${TEXT}\n${long}`);

    expect(verified).toEqual([]);
    expect(rejected).toBe(1);
  });

  it("accepts a long passage that starts at a product's name and runs to its figure", () => {
    const passage = `famfit2 ${"ボトルは下置きでかんたん交換。".repeat(50)} 月額電気料金 約669円`;

    const { verified } = verifyQuotes([passage], `${TEXT}\n${passage}`);

    expect(verified).toHaveLength(1);
  });

  it("keeps each distinct quote once", () => {
    const { verified } = verifyQuotes(["初回登録事務手数料：3,300円（税込）", "初回登録事務手数料：3,300円（税込）"], TEXT);

    expect(verified).toHaveLength(1);
  });
});

describe("draftPlanFromPages: the amounts come from quotes of the page text", () => {
  /** This cycle's page, as the collector hands it over. */
  const collectedOf = async (html: string) => {
    const env = setup(html);
    const collected: CollectedSource[] = [
      {
        body: html,
        record: {
          id: "src-1",
          canonicalUrl: PAGE,
          sourceType: "official",
          fetchedAt: NOW.toISOString(),
          hash: "h",
          provenance: "test",
          contentType: "text/html",
        },
      },
    ];
    return { env, collected };
  };

  it("draws the calculator input and saves the quotes as the evidence the QA number check reads", async () => {
    const { env, collected } = await collectedOf(pageHtml());

    const result = await draftPlanFromPages(planOf(), { ...env.services, collected, selector: new PatternSelector() });

    expect(result.ok ? [] : result.issues).toEqual([]);
    if (!result.ok) return;
    expect(result.plan.calculators[0]?.input).toEqual(EXPECTED_INPUT);
    const saved = await env.repo.facts.listAll();
    expect(saved.length).toBeGreaterThanOrEqual(5);
    expect(checkPlanEvidence(result.plan, saved, collected.map((c) => c.record))).toEqual([]);
  });

  it("reaches the same input whichever passages the model happens to copy", async () => {
    const { env, collected } = await collectedOf(pageHtml());
    const wider: QuoteSelector = {
      async select({ window }) {
        // a longer span for the water card, a different span for the term, and the fee passages as one block
        const card = window.match(/省エネ機能でエコに[\s\S]*?選べるウォーターサーバー\s*モデルX/)?.[0] ?? "";
        const term = window.match(/最低利用期間：5年/)?.[0] ?? "";
        const prelude = window.match(/プランP お水代がお得なプラン\s*最低利用期間：5年/)?.[0] ?? "";
        const rest = new PatternSelector();
        const others = (await rest.select({ brief: {} as never, window })).slice(1);
        return [card, term, prelude, ...others];
      },
    };

    const result = await draftPlanFromPages(planOf(), { ...env.services, collected, selector: wider });

    expect(result.ok && result.plan.calculators[0]?.input).toEqual(EXPECTED_INPUT);
  });

  it("drops a made-up figure and says how many quotes it dropped", async () => {
    const { env, collected } = await collectedOf(pageHtml());
    const lying: QuoteSelector = {
      async select({ window }) {
        const real = await new PatternSelector().select({ brief: {} as never, window });
        return real.map((quote) => quote.replace("3,300円", "3,000円"));
      },
    };

    const result = await draftPlanFromPages(planOf(), { ...env.services, collected, selector: lying });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toContain("初回費用");
    expect(result.issues.join("\n")).toMatch(/本文に無い引用.*1件/);
  });

  it("makes no plan when the page is missing what the brief needs", async () => {
    const { env, collected } = await collectedOf(pageHtml({ omit: ["electricity"] }));

    const result = await draftPlanFromPages(planOf(), { ...env.services, collected, selector: new PatternSelector() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toContain("電気代");
  });

  it("fails closed, with the reason, when there is no selector or the selector fails", async () => {
    const { env, collected } = await collectedOf(pageHtml());

    const none = await draftPlanFromPages(planOf(), { ...env.services, collected, selector: undefined });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.issues.join("\n")).toContain("引用を選ぶ仕組み");

    const broken: QuoteSelector = {
      async select() {
        throw new Error("model timed out");
      },
    };
    const failed = await draftPlanFromPages(planOf(), { ...env.services, collected, selector: broken });
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.issues.join("\n")).toContain("model timed out");
  });

  it("does nothing for a plan that has no draft or already has calculators, and never calls the selector", async () => {
    const selector = new PatternSelector();
    const env = setup(pageHtml());
    const hand = { ...planOf(), draft: undefined };

    const result = await draftPlanFromPages(hand, { ...env.services, selector });

    expect(result).toMatchObject({ ok: true, plan: hand });
    expect(selector.calls).toHaveLength(0);
  });

  it("passes the brief to the selector, never anything a page could write", async () => {
    const { env, collected } = await collectedOf(pageHtml());
    const selector = new PatternSelector();

    await draftPlanFromPages(planOf(), { ...env.services, collected, selector });

    expect(selector.calls[0]?.brief).toEqual({
      title: DRAFT.title,
      evidenceTerms: DRAFT.evidenceTerms,
      priceTerms: DRAFT.priceTerms,
      planTerms: DRAFT.planTerms,
      monthlyLiters: 25,
    });
  });
});

describe("a quote-drafted plan in the pipeline", () => {
  const PATH = "content/articles/quoted-water-a.ja-JP.md";

  it("publishes an article whose figures were never typed in, from quotes of the page", async () => {
    const env = setup(pageHtml());

    const result = await runArticlePipeline(planOf(), env.services);

    expect(result).toMatchObject({ finalState: "PUBLISHED", qaStatus: "PASS", published: true });
    expect(env.site.files.get(PATH)).toContain("119,916"); // (4,190 + 0 + 669) × 24 + 3,300
  });

  it("quarantines with the reasons when the page does not support the plan", async () => {
    const env = setup(pageHtml({ omit: ["electricity"] }));

    const result = await runArticlePipeline(planOf(), env.services);

    expect(result).toMatchObject({ finalState: "QUARANTINED", published: false, publishReason: "plan_draft_failed" });
    expect(result.reasons.join("\n")).toContain("電気代");
    expect(env.site.files.size).toBe(0);
  });

  it("follows the page on update: a new price becomes the new article with no plan edit", async () => {
    const env = setup(pageHtml());
    await runArticlePipeline(planOf(), env.services);

    env.page.html = pageHtml({ monthly: "3,980円/月", included: "(税込4,298円)" });
    const update = await runPlan(planOf(), env.services, { templateRevision: "price-follow-1" });

    expect(update.update?.outcome).toBe("updated");
    const text = env.site.files.get(PATH) ?? "";
    expect(text).toContain("122,508"); // (4,298 + 669) × 24 + 3,300
    expect(text).not.toContain("119,916");
  });

  it("keeps the live article when an update can no longer be drafted", async () => {
    const env = setup(pageHtml());
    await runArticlePipeline(planOf(), env.services);
    const live = env.site.files.get(PATH);

    env.page.html = pageHtml({ omit: ["electricity"] });
    const update = await runPlan(planOf(), env.services, { templateRevision: "price-follow-2" });

    expect(update.update?.outcome).toBe("kept_previous");
    expect(update.reasons.join("\n")).toContain("plan_draft_failed");
    expect(env.site.files.get(PATH)).toBe(live);
  });

  it("quarantines a drafted plan when the worker gave no selector", async () => {
    const env = setup(pageHtml(), null);

    const result = await runArticlePipeline(planOf(), env.services);

    expect(result).toMatchObject({ finalState: "QUARANTINED", publishReason: "plan_draft_failed" });
  });
});
