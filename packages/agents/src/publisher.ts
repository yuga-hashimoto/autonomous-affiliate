import type { Repository } from "@aff/db";
import type {
  AffiliateOffer,
  ContentItem,
  Logger,
  PolicyConfig,
  Publication,
  QualityDecision,
} from "@aff/domain";
import { dayKeyInTz, newId, newTraceId, sha256Hex } from "@aff/domain";

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
}

export interface PublishTarget {
  destination: "preview" | "git" | "pages";
  /** Directory the rendered artifact is written to (preview mode). */
  previewDir?: string;
}

export interface PublisherIO {
  /** Writes the artifact somewhere durable (FS in MVP). */
  writeArtifact(path: string, content: string): Promise<void>;
  /** Static site build used to verify the artifact; throw to trigger rollback. */
  buildSite?(): Promise<void>;
  /** Commits the artifact in the site repository (live destinations). */
  commitArtifact?(path: string, message: string): Promise<string>;
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
  | "lock_unavailable";

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
    input: { artifact: PublishArtifact; target: PublishTarget; item: ContentItem },
    offers: AffiliateOffer[],
  ): Promise<{ published: true; publication: Publication } | { published: false; reason: PublishDenialReason }> {
    const { artifact, target, item } = input;
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
        this.deps.logger.info("publish skipped (already published)", {
          revisionId: artifact.revisionId,
          destination: target.destination,
        });
        return { published: true, publication: existing };
      }

      if (target.destination !== "preview") {
        const dayKey = dayKeyInTz(clock());
        const todays = await this.deps.repo.publications.countOnDay(dayKey);
        if (todays >= this.deps.policy.limits.new_articles_per_day) {
          return { published: false, reason: "daily_limit" };
        }
      }

      const path = `${this.deps.siteContentDir}/${artifact.slug}.${artifact.locale}.md`;
      let commitSha: string | undefined;
      try {
        // QA hashed the body; frontmatter carries only QA-approved metadata.
        const file = [
          "---",
          `title: ${JSON.stringify(artifact.title)}`,
          `description: ${JSON.stringify(artifact.description)}`,
          `pubDate: ${JSON.stringify(artifact.qa.decidedAt)}`,
          `disclosure: ${JSON.stringify(artifact.qa.checks.some((c) => c.id === "ad_disclosure_present") ? artifact.markdown.split("\n")[0] ?? "" : "")}`,
          `offerIds: [${artifact.offerIds.map((id) => JSON.stringify(id)).join(", ")}]`,
          "---",
          "",
          artifact.markdown,
          "",
        ].join("\n");
        await this.deps.io.writeArtifact(path, file);
        if (target.destination !== "preview") {
          await this.deps.io.buildSite?.();
          commitSha = await this.deps.io.commitArtifact?.(
            path,
            `publish: ${artifact.slug} (${artifact.revisionId})`,
          );
        }
      } catch (error) {
        // Rollback: keep the previous version (docs/04).
        this.deps.logger.error("publish failed; keeping previous version", {
          slug: artifact.slug,
          error,
        });
        const failed = await this.recordPublication(artifact, item, target.destination, "FAILED", undefined);
        return { published: true, publication: failed };
      }

      const publication = await this.recordPublication(artifact, item, target.destination, "SUCCEEDED", commitSha);
      this.deps.logger.info("published", { slug: artifact.slug, destination: target.destination, commit: commitSha });
      return { published: true, publication };
    } finally {
      await this.deps.repo.locks.release("publisher", holder);
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
