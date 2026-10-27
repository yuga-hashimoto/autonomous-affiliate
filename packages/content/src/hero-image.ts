import { VERTICAL_IDS, type VerticalId } from "@aff/domain";

/** Shown under every generated hero image; the site renders it, no article text can change it. */
export const HERO_IMAGE_DISCLOSURE = "イメージ画像（AI生成）。実際の商品・サービスとは異なります。";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLIC_DIR = "apps/site/public";

function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new Error(`invalid article slug for an image path: ${JSON.stringify(slug)}`);
}

/** URL the site serves the article's hero image from. */
export function heroImageSrc(slug: string): string {
  assertSlug(slug);
  return `/images/articles/${slug}/hero.webp`;
}

/** Where the hero image file lives in the repository, relative to the repository root. */
export function heroImageRepoPath(slug: string): string {
  return `${PUBLIC_DIR}${heroImageSrc(slug)}`;
}

export interface HeroImageRequest {
  prompt: string;
  aspectRatio: "16:9";
  resolution: "1K";
}

/**
 * One generic scene per vertical. The prompt is built from these constants only:
 * nothing from a fetched page, an LLM answer or an article plan reaches it, so
 * untrusted text cannot steer what is drawn.
 */
const SCENES: Readonly<Record<VerticalId, { label: string; scene: string }>> = {
  mobile: {
    label: "格安SIM・スマートフォン",
    scene: "a generic unbranded smartphone lying on a wooden desk next to a small plant and a cup of tea",
  },
  fiber: {
    label: "光回線・インターネット",
    scene: "a tidy living room with a generic white wifi router on a shelf and a laptop on a sofa",
  },
  buyback: {
    label: "宅配買取",
    scene: "a plain cardboard box with a few household items, ready to be shipped, on a floor by a bright window",
  },
  education: {
    label: "オンライン学習",
    scene: "a study desk with an open notebook, a laptop and a desk lamp in soft morning light",
  },
  career: {
    label: "転職・キャリア",
    scene: "a bright office desk with a laptop and a notebook in front of a window with a city skyline",
  },
  moving: {
    label: "引っ越し",
    scene: "stacked plain cardboard boxes in an empty bright room with a large window",
  },
  utilities: {
    label: "電気・ガス",
    scene: "a cozy home interior with a lit ceiling lamp and a kettle on a stove",
  },
  water_delivery: {
    label: "ウォーターサーバー",
    scene: "a generic unbranded countertop water dispenser with a glass of water in a bright minimalist apartment kitchen",
  },
  car_buyback: {
    label: "車買取",
    scene: "a generic unbranded compact car parked on a quiet street at sunset",
  },
  saas: {
    label: "業務ソフトウェア",
    scene: "a laptop on a clean desk showing abstract coloured blocks",
  },
};

const STYLE =
  "Clean flat vector illustration, soft pastel colours, calm and bright, wide composition with plenty of empty space. " +
  "No text, no letters, no numbers, no logos, no brand names, no watermark, no people.";

function sceneOf(verticalId: string): { label: string; scene: string } | undefined {
  return (VERTICAL_IDS as readonly string[]).includes(verticalId) ? SCENES[verticalId as VerticalId] : undefined;
}

/** The image request for a vertical, or undefined when there is no scene for it. */
export function heroImageRequest(verticalId: string): HeroImageRequest | undefined {
  const entry = sceneOf(verticalId);
  if (!entry) return undefined;
  return { prompt: `${STYLE} Scene: ${entry.scene}.`, aspectRatio: "16:9", resolution: "1K" };
}

export function heroImageAlt(verticalId: string): string {
  const label = sceneOf(verticalId)?.label;
  return label ? `${label}のイメージ（AI生成）` : "イメージ（AI生成）";
}
