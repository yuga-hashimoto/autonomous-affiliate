import type { SourceRepository } from "@aff/db";
import type { SourceRecord } from "@aff/domain";
import { newId, sha256Hex } from "@aff/domain";
import type { DomainAllowlist } from "./allowlist.js";
import { canonicalizeUrl } from "./canonical.js";
import { FetchError, type Fetcher } from "./fetcher.js";

export class SourceUnavailableError extends Error {
  constructor(
    public readonly url: string,
    detail: string,
  ) {
    super(`official source unavailable at ${url}: ${detail}`);
    this.name = "SourceUnavailableError";
  }
}

export interface CollectedSource {
  record: SourceRecord;
  body: string;
}

/**
 * B006: fetches official primary sources behind a strict domain allowlist,
 * stores them with canonical URL + fetch time + sha256 checksum.
 * Any failure surfaces as SourceUnavailableError so downstream claims can be
 * marked UNKNOWN instead of guessed (fail closed).
 */
export class SourceCollector {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly allowlist: DomainAllowlist,
    private readonly sources: SourceRepository,
    private readonly options: { timeoutMs?: number; provenance?: string; clock?: () => Date } = {},
  ) {}

  async collect(rawUrl: string): Promise<CollectedSource> {
    // Network access outside the allowlist is rejected before any request.
    this.allowlist.assertAllowed(rawUrl);
    const canonicalUrl = canonicalizeUrl(rawUrl);
    let result;
    try {
      result = await this.fetcher.fetch(canonicalUrl, { timeoutMs: this.options.timeoutMs });
    } catch (error) {
      if (error instanceof FetchError) throw new SourceUnavailableError(canonicalUrl, error.message);
      throw error;
    }
    if (result.status < 200 || result.status >= 300) {
      throw new SourceUnavailableError(canonicalUrl, `HTTP ${result.status}`);
    }
    // A redirect to another site is not the official page: the host the page came from must be allowed too.
    try {
      this.allowlist.assertAllowed(result.finalUrl || canonicalUrl);
    } catch {
      throw new SourceUnavailableError(canonicalUrl, "the page was served from a host that is not allowed");
    }
    const record: SourceRecord = {
      id: newId("src"),
      canonicalUrl,
      sourceType: "official",
      fetchedAt: (this.options.clock ?? (() => new Date()))().toISOString(),
      hash: sha256Hex(result.body),
      provenance: this.options.provenance ?? "direct fetch of official page",
      contentType: result.contentType,
    };
    await this.sources.save(record);
    return { record, body: result.body };
  }
}
