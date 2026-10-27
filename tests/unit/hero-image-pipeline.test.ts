import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { createLogger, parsePolicyText, type PolicyConfig } from "@aff/domain";
import { FetchError, type Fetcher } from "@aff/integrations";
import {
  FixtureFactExtractor,
  runArticlePipeline,
  runPlan,
  type ArticlePlan,
  type HeroImageResult,
  type HeroImageService,
  type PublisherIO,
} from "@aff/agents";
import { readFileSync } from "./helpers.js";

const T0 = new Date("2026-10-27T04:44:25.000Z");
const PAGE_URL = "https://sim-a.example.com/price";
const SLUG = "hero-sim-24month";
const PATH = `content/articles/${SLUG}.ja-JP.md`;
const HERO_PATH = `apps/site/public/images/articles/${SLUG}/hero.webp`;

const basePolicy = parsePolicyText(
  readFileSync(new URL("../../config/policy.dry-run.yaml", import.meta.url), "utf8"),
);
const livePolicy: PolicyConfig = { ...basePolicy, flags: { ...basePolicy.flags, publish_enabled: true } };
const previewPolicy: PolicyConfig = { ...basePolicy, flags: { ...basePolicy.flags, publish_enabled: false } };

function pageWith(monthlyJpy: number): string {
  return `<html><body><p>SIM A 20GB</p>
  <script type="application/x-aff-facts">[
    {"text":"SIM A 20GBの月額基本料は${monthlyJpy}円","claimType":"price"},
    {"text":"SIM Aの事務手数料は3300円","claimType":"price"}
  ]</script></body></html>`;
}

function planWith(monthlyJpy = 2980): ArticlePlan {
  return {
    slug: SLUG,
    title: "画像つき記事の確認",
    audience: "a",
    purpose: "p",
    verticalId: "mobile",
    keyword: "k",
    sourceUrls: [PAGE_URL],
    calculators: [
      {
        calculator: "sim",
        input: { offerId: "offer-x", title: "SIM A 20GB", monthlyJpy, dataGb: 20, initialFeeJpy: 3300, months: 24 },
        factEvidenceTerms: ["SIM A"],
      },
    ],
    offerIds: [],
  };
}

const HERO = {
  src: `/images/articles/${SLUG}/hero.webp`,
  alt: "格安SIMのイメージ（AI生成）",
  width: 1280,
  height: 720,
};
const HERO_BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

/** An in-memory stand-in for LivePublisherIO: article files, binary files, build and commits. */
class FakeSite implements PublisherIO {
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, Uint8Array>();
  readonly commits: { path: string; message: string; extraPaths: string[] }[] = [];
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
  async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    this.binaries.set(path, bytes);
  }
  async removeBinary(path: string): Promise<void> {
    this.binaries.delete(path);
  }
  async buildSite(): Promise<void> {
    if (this.failBuild) throw new Error("site build failed");
  }
  async commitArtifact(path: string, message: string, extraPaths: string[] = []): Promise<string> {
    this.commits.push({ path, message, extraPaths });
    return `sha${this.commits.length}`;
  }
}

class FakeHeroImages implements HeroImageService {
  readonly calls: { slug: string; verticalId: string }[] = [];
  constructor(private readonly outcome: () => Promise<HeroImageResult | undefined>) {}
  async prepare(input: { slug: string; verticalId: string }): Promise<HeroImageResult | undefined> {
    this.calls.push(input);
    return this.outcome();
  }
}

const newImage = async (): Promise<HeroImageResult> => ({ image: HERO, file: { path: HERO_PATH, bytes: HERO_BYTES } });

function setup(policy: PolicyConfig, heroImages?: HeroImageService, monthlyJpy = 2980) {
  const repo = createMemoryRepository();
  const site = new FakeSite();
  const logLines: string[] = [];
  const fetcher: Fetcher = {
    async fetch(url) {
      if (url !== PAGE_URL) throw new FetchError(url, 404, "not found");
      return { status: 200, body: pageWith(monthlyJpy), contentType: "text/html", finalUrl: url };
    },
  };
  const services = {
    repo,
    policy,
    logger: createLogger({ level: "warn", sink: (line) => logLines.push(line) }),
    fetcher,
    extractor: new FixtureFactExtractor(),
    publisherIO: site,
    clock: () => T0,
    ...(heroImages ? { heroImages } : {}),
  };
  return { repo, site, services, logLines };
}

function frontmatterOf(file: string | undefined): string {
  return /^---\n([\s\S]*?)\n---/.exec(file ?? "")?.[1] ?? "";
}

describe("publishing an article with a hero image", () => {
  it("puts the image in the frontmatter, writes the file and commits both together", async () => {
    const heroImages = new FakeHeroImages(newImage);
    const env = setup(livePolicy, heroImages);

    const result = await runArticlePipeline(planWith(), env.services);

    expect(result.published).toBe(true);
    expect(heroImages.calls).toEqual([{ slug: SLUG, verticalId: "mobile" }]);
    const front = frontmatterOf(env.site.files.get(PATH));
    expect(front).toContain(`heroImage: "${HERO.src}"`);
    expect(front).toContain(`heroImageAlt: ${JSON.stringify(HERO.alt)}`);
    expect(front).toContain("heroImageWidth: 1280");
    expect(front).toContain("heroImageHeight: 720");
    expect(env.site.binaries.get(HERO_PATH)).toEqual(HERO_BYTES);
    expect(env.site.commits).toHaveLength(1);
    expect(env.site.commits[0]!.extraPaths).toEqual([HERO_PATH]);
  });

  it("publishes the article without an image when the image step fails", async () => {
    const heroImages = new FakeHeroImages(async () => {
      throw new Error("OpenRouter is down");
    });
    const env = setup(livePolicy, heroImages);

    const result = await runArticlePipeline(planWith(), env.services);

    expect(result.published).toBe(true);
    expect(frontmatterOf(env.site.files.get(PATH))).not.toContain("heroImage");
    expect(env.site.binaries.size).toBe(0);
    expect(env.site.commits[0]!.extraPaths).toEqual([]);
    expect(env.logLines.join("\n")).toContain("hero image skipped");
    expect(env.logLines.join("\n")).toContain("OpenRouter is down");
  });

  it("publishes without an image when there is nothing to attach", async () => {
    const env = setup(livePolicy, new FakeHeroImages(async () => undefined));

    const result = await runArticlePipeline(planWith(), env.services);

    expect(result.published).toBe(true);
    expect(frontmatterOf(env.site.files.get(PATH))).not.toContain("heroImage");
  });

  it("publishes as before when no image service is configured", async () => {
    const env = setup(livePolicy);

    const result = await runArticlePipeline(planWith(), env.services);

    expect(result.published).toBe(true);
    expect(frontmatterOf(env.site.files.get(PATH))).not.toContain("heroImage");
  });

  it("does not generate an image for a preview run, which never publishes", async () => {
    const heroImages = new FakeHeroImages(newImage);
    const env = setup(previewPolicy, heroImages);

    await runArticlePipeline(planWith(), env.services);

    expect(heroImages.calls).toHaveLength(0);
    expect(env.site.binaries.size).toBe(0);
  });

  it("does not pay for an image when QA blocks the article", async () => {
    const heroImages = new FakeHeroImages(newImage);
    // 9,999 yen is not what the official page says, so the numbers check fails.
    const env = setup(livePolicy, heroImages);

    const result = await runArticlePipeline(planWith(9999), env.services);

    expect(result.published).toBe(false);
    expect(heroImages.calls).toHaveLength(0);
  });

  it("removes the image again when the site build rejects the publish", async () => {
    const env = setup(livePolicy, new FakeHeroImages(newImage));
    env.site.failBuild = true;

    const result = await runArticlePipeline(planWith(), env.services);

    expect(result.published).toBe(false);
    expect(env.site.files.has(PATH)).toBe(false);
    expect(env.site.binaries.size).toBe(0);
    expect(env.site.commits).toHaveLength(0);
  });

  it("fails closed when the image cannot be written, instead of linking a missing file", async () => {
    const env = setup(livePolicy, new FakeHeroImages(newImage));
    env.site.writeBinary = async () => {
      throw new Error("disk full");
    };

    const result = await runArticlePipeline(planWith(), env.services);

    expect(result.published).toBe(false);
    expect(env.site.files.has(PATH)).toBe(false);
    expect(env.site.commits).toHaveLength(0);
  });
});

describe("updating a published article keeps its image", () => {
  it("links the existing image again without writing or paying for a new one", async () => {
    const first = new FakeHeroImages(newImage);
    const env = setup(livePolicy, first);
    await runArticlePipeline(planWith(), env.services);
    expect(env.site.binaries.size).toBe(1);

    const reuse = new FakeHeroImages(async () => ({ image: HERO }));
    const result = await runPlan(planWith(), { ...env.services, heroImages: reuse }, { templateRevision: "figures-2" });

    expect(result.action).toBe("update");
    expect(result.published).toBe(true);
    expect(reuse.calls).toEqual([{ slug: SLUG, verticalId: "mobile" }]);
    const front = frontmatterOf(env.site.files.get(PATH));
    expect(front).toContain(`heroImage: "${HERO.src}"`);
    expect(env.site.binaries.size).toBe(1);
    const update = env.site.commits.at(-1)!;
    expect(update.message).toMatch(/^update:/);
    expect(update.extraPaths).toEqual([]);
  });

  it("keeps the article updating even when the image service fails", async () => {
    const env = setup(livePolicy, new FakeHeroImages(newImage));
    await runArticlePipeline(planWith(), env.services);
    const broken = new FakeHeroImages(async () => {
      throw new Error("boom");
    });

    const result = await runPlan(planWith(), { ...env.services, heroImages: broken }, { templateRevision: "figures-2" });

    expect(result.action).toBe("update");
    expect(result.published).toBe(true);
    expect(env.site.commits).toHaveLength(2);
  });
});
