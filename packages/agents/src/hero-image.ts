/**
 * A decorative hero image for an article. It carries no claim: the text is what
 * QA checks, so an image that cannot be made never blocks publishing.
 */
export interface HeroImage {
  /** URL the site serves the image from (/images/articles/<slug>/hero.webp). */
  src: string;
  alt: string;
  width: number;
  height: number;
}

/** A new image file to commit together with the article. */
export interface HeroImageFile {
  /** Repository-relative path. */
  path: string;
  bytes: Uint8Array;
}

export interface HeroImageResult {
  image: HeroImage;
  /** Absent when the article's existing image is reused. */
  file?: HeroImageFile;
}

export interface HeroImageService {
  /**
   * The hero image for an article: the one it already has, else a newly
   * generated one. Throws when none can be made; the caller publishes without.
   */
  prepare(input: { slug: string; verticalId: string }): Promise<HeroImageResult | undefined>;
}
