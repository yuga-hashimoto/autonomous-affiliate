import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { HeroImageResult, HeroImageService } from "@aff/agents";
import { heroImageAlt, heroImageRepoPath, heroImageRequest, heroImageSrc } from "@aff/content";
import type { Repository } from "@aff/db";
import { dayKeyInTz, type Logger, type PolicyConfig } from "@aff/domain";
import {
  ImageProviderError,
  OpenRouterImageProvider,
  type GeneratedImage,
  type ImageGenerationRequest,
} from "@aff/integrations";

const OUTPUT_WIDTH = 1280;
const WEBP_QUALITY = 80;
const MIN_WIDTH = 640;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const ASPECT_TOLERANCE = 0.05;
const ALLOWED_FORMATS = new Set(["png", "jpeg", "webp"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BACKOFF_MS = 2_000;

export const DEFAULT_IMAGE_MODEL = "qwen/qwen-image-2.1-turbo";
/** OpenRouter's listed price for the default model (USD per 1K or 2K image). */
const DEFAULT_IMAGE_COST_USD = 0.0184;
/** A ceiling for budgeting, not a market rate: over-counting spend is the safe side. */
const DEFAULT_USD_JPY = 200;
const DEFAULT_MAX_IMAGE_COST_JPY = 15;

export interface HeroImageStore {
  /** Size of the article's current hero image, or undefined when it has none. */
  existing(slug: string): Promise<{ width: number; height: number } | undefined>;
}

export interface HeroImageSpend {
  monthSpendJpy(): Promise<number>;
  record(entry: { costJpy: number; provider: string; model: string }): Promise<void>;
}

export interface HeroImageGeneratorOptions {
  provider: { generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<GeneratedImage> };
  store: HeroImageStore;
  spend: HeroImageSpend;
  limits: { monthlyLimitJpy: number; maxImageCostJpy: number; attempts: number };
  usdJpy: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Makes an article's hero image: reuses the one it has, otherwise generates one
 * from the fixed per-vertical prompt, checks it, and converts it to a 1280px
 * WebP. Whatever the model returns is treated as untrusted bytes: only
 * png/jpeg/webp of a sane size and 16:9-ish shape are accepted, and the file we
 * keep is our own re-encoding.
 */
export class HeroImageGenerator implements HeroImageService {
  constructor(private readonly options: HeroImageGeneratorOptions) {}

  async prepare(input: { slug: string; verticalId: string }): Promise<HeroImageResult> {
    const request = heroImageRequest(input.verticalId);
    if (!request) throw new Error(`no hero image scene for vertical ${JSON.stringify(input.verticalId)}`);
    const src = heroImageSrc(input.slug);
    const alt = heroImageAlt(input.verticalId);

    const existing = await this.options.store.existing(input.slug);
    if (existing) return { image: { src, alt, ...existing } };

    const spent = await this.options.spend.monthSpendJpy();
    const { monthlyLimitJpy, maxImageCostJpy } = this.options.limits;
    if (spent + maxImageCostJpy > monthlyLimitJpy) {
      throw new Error(`image skipped: the monthly budget (${monthlyLimitJpy} JPY) cannot cover one more image (spent ${spent})`);
    }

    const generated = await this.generateWithRetry(request);
    // The money is gone whatever happens to the file next.
    await this.options.spend.record({
      costJpy: Math.ceil(generated.costUsd * this.options.usdJpy),
      provider: "openrouter",
      model: generated.model,
    });
    const webp = await toHeroWebp(generated.bytes);
    return {
      image: { src, alt, width: webp.width, height: webp.height },
      file: { path: heroImageRepoPath(input.slug), bytes: webp.bytes },
    };
  }

  private async generateWithRetry(request: ImageGenerationRequest): Promise<GeneratedImage> {
    const { attempts } = this.options.limits;
    const sleep = this.options.sleep ?? defaultSleep;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.callOnce(request);
      } catch (error) {
        const retryable =
          error instanceof ImageProviderError &&
          (error.kind === "rate_limited" || error.kind === "transient" || error.kind === "timeout");
        if (!retryable || attempt >= attempts) throw error;
        await sleep(error.retryAfterMs ?? DEFAULT_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }

  private async callOnce(request: ImageGenerationRequest): Promise<GeneratedImage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      return await this.options.provider.generate(request, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function toHeroWebp(bytes: Uint8Array): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  if (bytes.length > MAX_INPUT_BYTES) throw new Error("unsupported image: the file is too large");
  const input = Buffer.from(bytes);
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new Error("unsupported image: the file is not a readable raster image");
  }
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
    throw new Error(`unsupported image format: ${meta.format ?? "unknown"}`);
  }
  const { width, height } = meta;
  if (!width || !height) throw new Error("unsupported image: its size is unknown");
  if (width < MIN_WIDTH) throw new Error(`image is too small (${width}x${height})`);
  if (Math.abs(width / height - 16 / 9) / (16 / 9) > ASPECT_TOLERANCE) {
    throw new Error(`image aspect ratio ${(width / height).toFixed(2)} is not close to 16:9`);
  }
  const outWidth = Math.min(width, OUTPUT_WIDTH);
  const outHeight = Math.round((outWidth * 9) / 16);
  const out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(outWidth, outHeight, { fit: "cover", position: "centre" })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { bytes: new Uint8Array(out.data), width: out.info.width, height: out.info.height };
}

/** Reads the hero image already committed for an article from the site's public folder. */
export function fsHeroImageStore(repoRoot: string): HeroImageStore {
  return {
    async existing(slug) {
      let data: Buffer;
      try {
        data = await readFile(join(repoRoot, heroImageRepoPath(slug)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      const meta = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      if (meta.format !== "webp" || !meta.width || !meta.height) {
        throw new Error(`existing hero image for ${slug} is not a readable WebP`);
      }
      return { width: meta.width, height: meta.height };
    },
  };
}

function positiveNumber(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!(parsed > 0)) throw new Error(`${name} must be a positive number`);
  return parsed;
}

/**
 * The OpenRouter-backed provider from environment variables, or null when
 * OPENROUTER_API_KEY is not set (articles are then published without an image).
 * A model other than the default needs its own IMAGE_ESTIMATED_COST_USD: a call
 * without a price estimate is not allowed.
 */
export function buildImageProviderFromEnv(env: NodeJS.ProcessEnv): OpenRouterImageProvider | null {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model = env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const customCost = env.IMAGE_ESTIMATED_COST_USD;
  if (model !== DEFAULT_IMAGE_MODEL && !customCost) {
    throw new Error(`IMAGE_ESTIMATED_COST_USD is required when IMAGE_MODEL is not ${DEFAULT_IMAGE_MODEL}`);
  }
  return new OpenRouterImageProvider({
    apiKey,
    model,
    estimatedCostUsd: positiveNumber(customCost, "IMAGE_ESTIMATED_COST_USD", DEFAULT_IMAGE_COST_USD),
  });
}

export function imageBudgetFromEnv(env: NodeJS.ProcessEnv): { usdJpy: number; maxImageCostJpy: number } {
  return {
    usdJpy: positiveNumber(env.IMAGE_USD_JPY, "IMAGE_USD_JPY", DEFAULT_USD_JPY),
    maxImageCostJpy: positiveNumber(env.IMAGE_MAX_COST_JPY, "IMAGE_MAX_COST_JPY", DEFAULT_MAX_IMAGE_COST_JPY),
  };
}

export interface HeroImageWiring {
  service: HeroImageService;
  /** What the images generated in this run cost so far, in JPY. */
  imageCostJpy(): number;
}

/**
 * The live pipeline's image service, or undefined when OPENROUTER_API_KEY is not
 * set. Spend is stored as "api" next to the LLM spend, so the monthly stop sees both.
 */
export function createHeroImageService(
  env: NodeJS.ProcessEnv,
  deps: { repo: Repository; policy: PolicyConfig; clock: () => Date; logger: Logger; repoRoot: string },
): HeroImageWiring | undefined {
  const provider = buildImageProviderFromEnv(env);
  if (!provider) {
    deps.logger.info("hero images are off: OPENROUTER_API_KEY is not set");
    return undefined;
  }
  const { usdJpy, maxImageCostJpy } = imageBudgetFromEnv(env);
  let spentJpy = 0;
  const service = new HeroImageGenerator({
    provider,
    store: fsHeroImageStore(deps.repoRoot),
    spend: {
      monthSpendJpy: () => deps.repo.spend.sumMonth(dayKeyInTz(deps.clock()).slice(0, 7)),
      record: async (entry) => {
        spentJpy += entry.costJpy;
        await deps.repo.spend.recordSpend({
          date: dayKeyInTz(deps.clock()),
          category: "api",
          provider: `${entry.provider}:${entry.model}`,
          costJpy: entry.costJpy,
          source: "pipeline",
          estimated: true,
        });
      },
    },
    limits: {
      monthlyLimitJpy: deps.policy.limits.monthly_operating_cost_jpy,
      maxImageCostJpy,
      attempts: deps.policy.limits.task_retry_attempts,
    },
    usdJpy,
  });
  return { service, imageCostJpy: () => spentJpy };
}

/**
 * One real image call for the owner to look at: generates a hero image for a
 * vertical and writes it to `outDir`. Nothing is published, committed or stored.
 */
export async function runImageSmoke(
  env: NodeJS.ProcessEnv,
  options: { verticalId: string; outDir: string },
): Promise<{ model: string; verticalId: string; width: number; height: number; bytes: number; costJpy: number; file: string }> {
  const provider = buildImageProviderFromEnv(env);
  if (!provider) throw new Error("image smoke needs OPENROUTER_API_KEY");
  const { usdJpy, maxImageCostJpy } = imageBudgetFromEnv(env);
  let costJpy = 0;
  let model = "";
  const generator = new HeroImageGenerator({
    provider,
    store: { existing: async () => undefined },
    spend: {
      monthSpendJpy: async () => 0,
      record: async (entry) => {
        costJpy += entry.costJpy;
        model = entry.model;
      },
    },
    limits: { monthlyLimitJpy: maxImageCostJpy * 2, maxImageCostJpy, attempts: 3 },
    usdJpy,
  });
  const result = await generator.prepare({ slug: "image-smoke", verticalId: options.verticalId });
  const file = join(options.outDir, "hero.webp");
  await mkdir(options.outDir, { recursive: true });
  await writeFile(file, result.file!.bytes);
  return {
    model,
    verticalId: options.verticalId,
    width: result.image.width,
    height: result.image.height,
    bytes: result.file!.bytes.length,
    costJpy,
    file,
  };
}
