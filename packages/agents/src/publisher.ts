import type { Repository } from "@aff/db";
import type {
  AffiliateOffer,
  ContentItem,
  Logger,
  PolicyConfig,
  Publication,
  QualityDecision,
} from "@aff/domain";
import { dayKeyInTz, isFresh, isLiveState, newId, newTraceId, sha256Hex } from "@aff/domain";
import type { HeroImage, HeroImageFile } from "./hero-image.js";

export interface PublishArtifact {
  itemId: string;
  revisionId: string;
  slug: string;
  locale: string;
  title: string;
  description: string;
  markdown: string;
  contentHash: string;
  qa: QualityDecision;
  offerIds: string[];
  /** Decorative image linked from the frontmatter; the text, not the image, is what QA approves. */
  hero?: HeroImage;
  /** The image file to write and commit with the article; absent when the existing one is reused. */
  heroFile?: HeroImageFile;
}

export interface PublishTarget {
  destination: "preview" | "git" | "pages";
  /** Directory the rendered artifact is written to (preview mode). */
  previewDir?: string;
}

export interface PublisherIO {
  /** Writes the artifact somewhere durable (FS in MVP). */
  writeArtifact(path: string, content: string): Promise<void>;
  /**
   * Current content of an artifact, or undefined when there is none. A failed
   * live publish uses it to put the previous version back.
   */
  readArtifact?(path: string): Promise<string | undefined>;
  /** Deletes an artifact; used to undo the write of a first publication that failed. */
  removeArtifact?(path: string): Promise<void>;
  /** Writes a binary file (a hero image) at a repository-relative path. */
  writeBinary?(path: string, bytes: Uint8Array): Promise<void>;
  /** Deletes a binary file written by `writeBinary`; used to undo a publish that failed. */
  removeBinary?(path: string): Promise<void>;
  /** Static site build used to verify the artifact; throw to trigger rollback. */
  buildSite?(): Promise<void>;
  /** Commits the artifact in the site repository (live destinations), plus any extra files. */
  commitArtifact?(path: string, message: string, extraPaths?: string[]): Promise<string>;
}

const HERO_SRC = /^\/images\/articles\/[a-z0-9]+(?:-[a-z0-9]+)*\/hero\.webp$/;

/** Frontmatter lines for the hero image; the site schema accepts only this exact shape. */
function heroFrontmatter(hero: HeroImage | undefined): string[] {
  if (!hero) return [];
  const sized = Number.isInteger(hero.width) && hero.width > 0 && Number.isInteger(hero.height) && hero.height > 0;
  if (!HERO_SRC.test(hero.src) || !sized || hero.alt.trim().length === 0) {
    throw new Error(`invalid hero image: ${JSON.stringify(hero)}`);
  }
  return [
    `heroImage: ${JSON.stringify(hero.src)}`,
    `heroImageAlt: ${JSON.stringify(hero.alt)}`,
    `heroImageWidth: ${hero.width}`,
    `heroImageHeight: ${hero.height}`,
  ];
}

/**
 * "new" is a first publication and counts against `limits.new_articles_per_day`.
 * "update" replaces an article that is already live and is not capped by it
 * (docs/04 "既存記事更新").
 */
export type PublishKind = "new" | "update";

/**
 * True once the day's cap of new articles (`limits.new_articles_per_day`) is used.
 * The publisher refuses a first publication with it, and the plan queue asks the
 * same question first so that a plan the cap would turn away is not researched.
 */
export async function newArticleCapReached(repo: Repository, policy: PolicyConfig, now: Date): Promise<boolean> {
  return (await repo.publications.countOnDay(dayKeyInTz(now))) >= policy.limits.new_articles_per_day;
}

export interface PublisherDeps {
  repo: Repository;
  policy: PolicyConfig;
  logger: Logger;
  io: PublisherIO;
  siteContentDir: string;
  clock?: () => Date;
}

export type PublishDenialReason =
  | "publish_disabled"
  | "qa_not_pass"
  | "hash_mismatch"
  | "daily_limit"
  | "budget_stopped"
  | "offer_not_approved"
  | "offer_terms_unverified"
  | "manual_offer_requirement"
  | "lock_unavailable"
  | "update_without_live_article"
  | "publish_failed";

/**
 * B012: deterministic publication gate (docs/04 can_publish) + idempotent
 * publishing + rollback on build failure. Dry-run mode only ever writes
 * previews — `publish_enabled=false` blocks git/pages destinations entirely.
 */
export class PublisherAgent {
  constructor(private readonly deps: PublisherDeps) {}

  async canPublish(
    input: { artifact: PublishArtifact; target: PublishTarget },
    offers: AffiliateOffer[],
  ): Promise<{ ok: true } | { ok: false; reason: PublishDenialReason }> {
    const { artifact, target } = input;
    const policy = this.deps.policy;
    if (target.destination !== "preview" && !policy.flags.publish_enabled) {
      return { ok: false, reason: "publish_disabled" };
    }
    if (artifact.qa.status !== "PASS") return { ok: false, reason: "qa_not_pass" };
    if (
      artifact.contentHash !== artifact.qa.artifactHash ||
      artifact.contentHash !== sha256Hex(artifact.markdown)
    ) {
      return { ok: false, reason: "hash_mismatch" };
    }
    const monetized = offers.filter((o) => artifact.offerIds.includes(o.id));
    for (const offer of monetized) {
      const offerUsable =
        offer.active &&
        offer.status === "APPROVED" &&
        offer.channelPermissions.includes("site");
      const program = await this.deps.repo.offers.getProgram(offer.programId);
      const programUsable =
        !policy.affiliate.require_program_approved || program?.status === "APPROVED";
      if (!offerUsable || !programUsable) {
        return { ok: false, reason: "offer_not_approved" };
      }
      if (policy.affiliate.require_program_approved) {
        const termsCurrent =
          Boolean(program?.termsUrl) &&
          Boolean(program?.termsCheckedAt) &&
          isFresh(
            program!.termsCheckedAt!,
            (this.deps.clock ?? (() => new Date()))(),
            policy.content.price_source_max_age_days,
          );
        if (!termsCurrent) return { ok: false, reason: "offer_terms_unverified" };
      }
      const requiresManualSubmission = offer.constraints.requires_manual_post_url_submission === true;
      const manualSubmissionAutomated = offer.constraints.manual_post_url_submission_automated === true;
      if (requiresManualSubmission && !manualSubmissionAutomated) {
        return { ok: false, reason: "manual_offer_requirement" };
      }
    }
    if (target.destination !== "preview" && policy.operations.stop_on_budget_limit) {
      const month = dayKeyInTz((this.deps.clock ?? (() => new Date()))()).slice(0, 7);
      const spend = await this.deps.repo.spend.sumMonth(month);
      if (spend > policy.limits.monthly_operating_cost_jpy) {
        return { ok: false, reason: "budget_stopped" };
      }
    }
    return { ok: true };
  }

  async publish(
    input: { artifact: PublishArtifact; target: PublishTarget; item: ContentItem; kind?: PublishKind },
    offers: AffiliateOffer[],
  ): Promise<{ published: true; publication: Publication } | { published: false; reason: PublishDenialReason }> {
    const { artifact, target, item } = input;
    const kind = input.kind ?? "new";
    // An update bypasses the new-article cap, so it must really replace a live article.
    if (kind === "update" && !isLiveState(item.state)) {
      this.deps.logger.warn("publish denied", { slug: artifact.slug, reason: "update_without_live_article" });
      return { published: false, reason: "update_without_live_article" };
    }
    const decision = await this.canPublish({ artifact, target }, offers);
    if (!decision.ok) {
      this.deps.logger.warn("publish denied", { slug: artifact.slug, reason: decision.reason });
      return { published: false, reason: decision.reason };
    }

    const clock = this.deps.clock ?? (() => new Date());
    const traceId = newTraceId();

    // Concurrency lock: duplicated workflow triggers must not double-publish (B013).
    const holder = `publish:${traceId}`;
    const locked = await this.deps.repo.locks.tryAcquire("publisher", holder, 300);
    if (!locked) return { published: false, reason: "lock_unavailable" };
    try {
      // Idempotency: same revision + destination publishes once (docs/04).
      const existing = await this.deps.repo.publications.get(artifact.revisionId, target.destination);
      if (existing) {
        if (existing.status !== "SUCCEEDED") {
          return { published: false, reason: "publish_failed" };
        }
        this.deps.logger.info("publish skipped (already published)", {
          revisionId: artifact.revisionId,
          destination: target.destination,
        });
        return { published: true, publication: existing };
      }

      if (target.destination !== "preview" && kind === "new") {
        if (await newArticleCapReached(this.deps.repo, this.deps.policy, clock())) {
          return { published: false, reason: "daily_limit" };
        }
      }

      const path = `${this.deps.siteContentDir}/${artifact.slug}.${artifact.locale}.md`;
      let commitSha: string | undefined;
      let previous: string | undefined;
      let written = false;
      let heroWritten = false;
      try {
        if (target.destination !== "preview") {
          previous = await this.deps.io.readArtifact?.(path);
        }
        // QA hashed the body; frontmatter carries only QA-approved metadata.
        const file = [
          "---",
          `title: ${JSON.stringify(artifact.title)}`,
          `description: ${JSON.stringify(artifact.description)}`,
          `pubDate: ${JSON.stringify(artifact.qa.decidedAt)}`,
          `disclosure: ${JSON.stringify(artifact.qa.checks.some((c) => c.id === "ad_disclosure_present") ? artifact.markdown.split("\n")[0] ?? "" : "")}`,
          `offerIds: [${artifact.offerIds.map((id) => JSON.stringify(id)).join(", ")}]`,
          ...heroFrontmatter(artifact.hero),
          "---",
          "",
          artifact.markdown,
          "",
        ].join("\n");
        await this.deps.io.writeArtifact(path, file);
        written = true;
        if (artifact.heroFile) {
          // The frontmatter links the image, so it must exist before the build and the commit.
          if (!this.deps.io.writeBinary) throw new Error("this publisher cannot write the hero image file");
          await this.deps.io.writeBinary(artifact.heroFile.path, artifact.heroFile.bytes);
          heroWritten = true;
        }
        if (target.destination !== "preview") {
          await this.deps.io.buildSite?.();
          commitSha = await this.deps.io.commitArtifact?.(
            path,
            `${kind === "update" ? "update" : "publish"}: ${artifact.slug} (${artifact.revisionId})`,
            artifact.heroFile ? [artifact.heroFile.path] : [],
          );
        }
      } catch (error) {
        // Rollback: keep the previous version (docs/04). Nothing may stay in the
        // working tree that the site build rejected or that was never committed.
        this.deps.logger.error("publish failed; keeping previous version", {
          slug: artifact.slug,
          error,
        });
        if (heroWritten && artifact.heroFile) await this.removeHero(artifact.heroFile.path);
        if (written) await this.restore(path, previous);
        await this.recordPublication(artifact, item, target.destination, "FAILED", undefined);
        return { published: false, reason: "publish_failed" };
      }

      const publication = await this.recordPublication(artifact, item, target.destination, "SUCCEEDED", commitSha);
      this.deps.logger.info("published", { slug: artifact.slug, destination: target.destination, commit: commitSha });
      return { published: true, publication };
    } finally {
      await this.deps.repo.locks.release("publisher", holder);
    }
  }

  private async removeHero(path: string): Promise<void> {
    try {
      await this.deps.io.removeBinary?.(path);
    } catch (error) {
      this.deps.logger.error("rollback failed; the hero image needs a manual check", { path, error });
    }
  }

  private async restore(path: string, previous: string | undefined): Promise<void> {
    try {
      if (previous !== undefined) {
        await this.deps.io.writeArtifact(path, previous);
      } else {
        await this.deps.io.removeArtifact?.(path);
      }
    } catch (error) {
      this.deps.logger.error("rollback failed; the article store needs a manual check", { path, error });
    }
  }

  private async recordPublication(
    artifact: PublishArtifact,
    item: ContentItem,
    destination: Publication["destination"],
    status: Publication["status"],
    commitSha: string | undefined,
  ): Promise<Publication> {
    const publication: Publication = {
      id: newId("pub"),
      itemId: item.id,
      revisionId: artifact.revisionId,
      destination,
      commitSha,
      status,
      publishedAt: (this.deps.clock ?? (() => new Date()))().toISOString(),
    };
    const { publication: saved } = await this.deps.repo.publications.save(publication);
    await this.deps.repo.audit.append({
      runId: `publish:${artifact.revisionId}`,
      agent: "publisher",
      eventType: "publication.recorded",
      payload: { slug: artifact.slug, destination, status, commit: commitSha },
      at: saved.publishedAt,
    });
    return saved;
  }
}
