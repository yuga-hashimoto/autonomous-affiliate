import { assertJobTransition, newId } from "@aff/domain";
import type {
  AffiliateOffer,
  ContentState,
  Fact,
  JobState,
  Publication,
} from "@aff/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { JobRunEnqueueInput, JobRunRecord } from "../records.js";
import type {
  AnalysisRepository,
  AuditRepository,
  ContentRepository,
  ContentTransitionRecord,
  FactRepository,
  JobRunRepository,
  LockRepository,
  MetricsRepository,
  OfferRepository,
  PublicationRepository,
  Repository,
  SerpRepository,
  SourceRepository,
  SpendRepository,
} from "../repository.js";

function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function requiredIso(value: Date | string | null | undefined): string {
  return iso(value) ?? new Date(0).toISOString();
}

function optionalNumber(value: string | number | null): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" ? value : Number(value);
}

function rowToJobRun(row: QueryResultRow): JobRunRecord {
  return {
    id: row.id as string,
    jobKey: row.job_key as string,
    jobType: row.job_type as string,
    state: row.state as JobState,
    attempt: row.attempt as number,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    checkpoint: (row.checkpoint ?? {}) as Record<string, unknown>,
    traceId: row.trace_id as string,
    costJpy: row.cost_jpy as number,
    lastError: (row.last_error as string | null) ?? undefined,
    runAfter: requiredIso(row.run_after as Date),
    createdAt: requiredIso(row.created_at as Date),
    updatedAt: requiredIso(row.updated_at as Date),
  };
}

class PgJobRunRepository implements JobRunRepository {
  constructor(private readonly client: () => Promise<PoolClient>) {}

  async enqueue(input: JobRunEnqueueInput): Promise<{ record: JobRunRecord; created: boolean }> {
    const c = await this.client();
    try {
      const result = await c.query(
        `INSERT INTO job_runs (id, job_key, job_type, state, attempt, payload, trace_id, run_after)
         VALUES ($1, $2, $3, 'PENDING', 0, $4, $5, COALESCE($6::timestamptz, now()))
         ON CONFLICT (job_key) DO NOTHING
         RETURNING *`,
        [
          newId("job"),
          input.jobKey,
          input.jobType,
          JSON.stringify(input.payload ?? {}),
          input.traceId,
          input.runAfter ?? null,
        ],
      );
      if (result.rows[0]) {
        return { record: rowToJobRun(result.rows[0]), created: true };
      }
      const existing = await c.query("SELECT * FROM job_runs WHERE job_key = $1", [input.jobKey]);
      if (!existing.rows[0]) throw new Error(`job run disappeared: ${input.jobKey}`);
      return { record: rowToJobRun(existing.rows[0]), created: false };
    } finally {
      c.release();
    }
  }

  async getByJobKey(jobKey: string): Promise<JobRunRecord | undefined> {
    const c = await this.client();
    try {
      const result = await c.query("SELECT * FROM job_runs WHERE job_key = $1", [jobKey]);
      return result.rows[0] ? rowToJobRun(result.rows[0]) : undefined;
    } finally {
      c.release();
    }
  }

  async get(id: string): Promise<JobRunRecord | undefined> {
    const c = await this.client();
    try {
      const result = await c.query("SELECT * FROM job_runs WHERE id = $1", [id]);
      return result.rows[0] ? rowToJobRun(result.rows[0]) : undefined;
    } finally {
      c.release();
    }
  }

  async update(record: JobRunRecord): Promise<JobRunRecord> {
    const c = await this.client();
    try {
      const current = await c.query("SELECT state FROM job_runs WHERE id = $1", [record.id]);
      if (!current.rows[0]) throw new Error(`job run not found: ${record.id}`);
      const currentState = current.rows[0]!.state as JobState;
      if (currentState !== record.state) {
        assertJobTransition(currentState, record.state);
      }
      const result = await c.query(
        `UPDATE job_runs SET state = $2, attempt = $3, checkpoint = $4, cost_jpy = $5,
           last_error = $6, run_after = $7, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          record.id,
          record.state,
          record.attempt,
          JSON.stringify(record.checkpoint),
          record.costJpy,
          record.lastError ?? null,
          record.runAfter,
        ],
      );
      return rowToJobRun(result.rows[0]!);
    } finally {
      c.release();
    }
  }

  async listReady(nowIsoValue: string, limit: number): Promise<JobRunRecord[]> {
    const c = await this.client();
    try {
      const result = await c.query(
        `SELECT * FROM job_runs
         WHERE state IN ('PENDING','RETRY_SCHEDULED') AND run_after <= $1::timestamptz
         ORDER BY run_after
         LIMIT $2`,
        [nowIsoValue, limit],
      );
      return result.rows.map(rowToJobRun);
    } finally {
      c.release();
    }
  }

  async countByState(): Promise<Record<JobState, number>> {
    const c = await this.client();
    try {
      const result = await c.query<{ state: JobState; count: string }>(
        "SELECT state, count(*)::text AS count FROM job_runs GROUP BY state",
      );
      const counts = {
        PENDING: 0,
        RUNNING: 0,
        SUCCEEDED: 0,
        RETRY_SCHEDULED: 0,
        DEAD_LETTER: 0,
        CANCELED: 0,
      } as Record<JobState, number>;
      for (const row of result.rows) counts[row.state] = Number(row.count);
      return counts;
    } finally {
      c.release();
    }
  }
}

class PgLockRepository implements LockRepository {
  constructor(private readonly client: () => Promise<PoolClient>) {}

  async tryAcquire(lockKey: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const c = await this.client();
    try {
      const result = await c.query(
        `INSERT INTO locks (lock_key, holder, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
         ON CONFLICT (lock_key) DO UPDATE
           SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
         WHERE locks.expires_at <= now() OR locks.holder = EXCLUDED.holder
         RETURNING holder`,
        [lockKey, holder, String(ttlSeconds)],
      );
      return result.rows.length > 0;
    } finally {
      c.release();
    }
  }

  async release(lockKey: string, holder: string): Promise<boolean> {
    const c = await this.client();
    try {
      const result = await c.query(
        "DELETE FROM locks WHERE lock_key = $1 AND holder = $2 RETURNING lock_key",
        [lockKey, holder],
      );
      return result.rows.length > 0;
    } finally {
      c.release();
    }
  }
}

export function createPgRepository(pool: Pool): Repository {
  const client = async (): Promise<PoolClient> => pool.connect();

  const jobs = new PgJobRunRepository(client);
  const locks = new PgLockRepository(client);

  const content: ContentRepository = {
    async createIfNotExists(input) {
      const c = await client();
      try {
        const inserted = await c.query(
          `INSERT INTO content_items (id, slug, locale, topic, state, offer_ids)
           VALUES ($1, $2, $3, $4, 'DISCOVERED', $5)
           ON CONFLICT (slug, locale) DO NOTHING
           RETURNING *`,
          [newId("item"), input.slug, input.locale, input.topic, JSON.stringify(input.offerIds ?? [])],
        );
        if (inserted.rows[0]) return rowToItem(inserted.rows[0]);
        const existing = await c.query(
          "SELECT * FROM content_items WHERE slug = $1 AND locale = $2",
          [input.slug, input.locale],
        );
        return rowToItem(existing.rows[0]!);
      } finally {
        c.release();
      }
    },
    async get(itemId) {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM content_items WHERE id = $1", [itemId]);
        return r.rows[0] ? rowToItem(r.rows[0]) : undefined;
      } finally {
        c.release();
      }
    },
    async getBySlug(slug, locale) {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM content_items WHERE slug = $1 AND locale = $2", [
          slug,
          locale,
        ]);
        return r.rows[0] ? rowToItem(r.rows[0]) : undefined;
      } finally {
        c.release();
      }
    },
    async listAll() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM content_items ORDER BY created_at");
        return r.rows.map(rowToItem);
      } finally {
        c.release();
      }
    },
    async updateState(itemId, state) {
      const c = await client();
      try {
        const r = await c.query(
          "UPDATE content_items SET state = $2, updated_at = now() WHERE id = $1 RETURNING *",
          [itemId, state],
        );
        if (!r.rows[0]) throw new Error(`content item not found: ${itemId}`);
        return rowToItem(r.rows[0]);
      } finally {
        c.release();
      }
    },
    async setCurrentRevision(itemId, revisionId) {
      const c = await client();
      try {
        const r = await c.query(
          "UPDATE content_items SET current_revision = $2, updated_at = now() WHERE id = $1 RETURNING *",
          [itemId, revisionId],
        );
        if (!r.rows[0]) throw new Error(`content item not found: ${itemId}`);
        return rowToItem(r.rows[0]);
      } finally {
        c.release();
      }
    },
    async saveRevision(revision) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO content_revisions (id, item_id, content_hash, markdown_path, qa_report_id, published_at, source_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash,
             markdown_path = EXCLUDED.markdown_path, qa_report_id = EXCLUDED.qa_report_id,
             published_at = EXCLUDED.published_at, source_ids = EXCLUDED.source_ids`,
          [
            revision.id,
            revision.itemId,
            revision.contentHash,
            revision.markdownPath,
            revision.qaReportId ?? null,
            revision.publishedAt ?? null,
            JSON.stringify(revision.sourceIds),
          ],
        );
        return revision;
      } finally {
        c.release();
      }
    },
    async getRevision(revisionId) {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM content_revisions WHERE id = $1", [revisionId]);
        return r.rows[0] ? rowToRevision(r.rows[0]) : undefined;
      } finally {
        c.release();
      }
    },
    async getLatestRevision(itemId) {
      const c = await client();
      try {
        const r = await c.query(
          "SELECT * FROM content_revisions WHERE item_id = $1 ORDER BY created_at DESC LIMIT 1",
          [itemId],
        );
        return r.rows[0] ? rowToRevision(r.rows[0]) : undefined;
      } finally {
        c.release();
      }
    },
    async saveQaReport(decision) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO qa_reports (id, item_id, revision_id, artifact_hash, policy_version, status, checks, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, checks = EXCLUDED.checks`,
          [
            decision.id,
            decision.itemId,
            decision.revisionId,
            decision.artifactHash,
            decision.policyVersion,
            decision.status,
            JSON.stringify(decision.checks),
            decision.decidedAt,
          ],
        );
        return decision;
      } finally {
        c.release();
      }
    },
    async getLatestQaReport(itemId) {
      const c = await client();
      try {
        const r = await c.query(
          "SELECT * FROM qa_reports WHERE item_id = $1 ORDER BY decided_at DESC LIMIT 1",
          [itemId],
        );
        if (!r.rows[0]) return undefined;
        const row = r.rows[0];
        return {
          itemId: row.item_id as string,
          revisionId: row.revision_id as string,
          artifactHash: row.artifact_hash as string,
          status: row.status as "PASS" | "FAIL" | "UNKNOWN",
          checks: (row.checks ?? []) as never[],
          policyVersion: row.policy_version as string,
          decidedAt: requiredIso(row.decided_at as Date),
        } as never;
      } finally {
        c.release();
      }
    },
    async recordTransition(transition) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO content_transitions (item_id, run_id, from_state, to_state, policy_version, evidence_ids)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            transition.itemId,
            transition.runId,
            transition.fromState,
            transition.toState,
            transition.policyVersion,
            JSON.stringify(transition.evidenceIds),
          ],
        );
      } finally {
        c.release();
      }
    },
    async listTransitions(itemId) {
      const c = await client();
      try {
        const r = await c.query(
          "SELECT * FROM content_transitions WHERE item_id = $1 ORDER BY at",
          [itemId],
        );
        return r.rows.map((row) => ({
          itemId: row.item_id as string,
          runId: row.run_id as string,
          fromState: (row.from_state as string | null) as ContentTransitionRecord["fromState"],
          toState: row.to_state as ContentTransitionRecord["toState"],
          policyVersion: row.policy_version as string,
          evidenceIds: (row.evidence_ids ?? []) as string[],
          at: requiredIso(row.at as Date),
        }));
      } finally {
        c.release();
      }
    },
  };

  const sources: SourceRepository = {
    async save(source) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO sources (id, canonical_url, source_type, fetched_at, hash, provenance, content_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            source.id,
            source.canonicalUrl,
            source.sourceType,
            source.fetchedAt,
            source.hash,
            source.provenance,
            source.contentType,
          ],
        );
        return source;
      } finally {
        c.release();
      }
    },
    async getLatestByUrl(canonicalUrl) {
      const c = await client();
      try {
        const r = await c.query(
          "SELECT * FROM sources WHERE canonical_url = $1 ORDER BY fetched_at DESC LIMIT 1",
          [canonicalUrl],
        );
        if (!r.rows[0]) return undefined;
        const row = r.rows[0];
        return {
          id: row.id as string,
          canonicalUrl: row.canonical_url as string,
          sourceType: row.source_type as never,
          fetchedAt: requiredIso(row.fetched_at as Date),
          hash: row.hash as string,
          provenance: row.provenance as string,
          contentType: row.content_type as string,
        };
      } finally {
        c.release();
      }
    },
    async list() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM sources ORDER BY fetched_at");
        return r.rows.map((row) => ({
          id: row.id as string,
          canonicalUrl: row.canonical_url as string,
          sourceType: row.source_type as never,
          fetchedAt: requiredIso(row.fetched_at as Date),
          hash: row.hash as string,
          provenance: row.provenance as string,
          contentType: row.content_type as string,
        }));
      } finally {
        c.release();
      }
    },
  };

  const facts: FactRepository = {
    async save(fact) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO claims (id, text, claim_type, source_ids, verified_at, confidence, verification_status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text,
             verification_status = EXCLUDED.verification_status, expires_at = EXCLUDED.expires_at`,
          [
            fact.id,
            fact.text,
            fact.claimType,
            JSON.stringify(fact.sourceIds),
            fact.verifiedAt,
            fact.confidence,
            fact.verificationStatus,
            fact.expiresAt ?? null,
          ],
        );
        return fact;
      } finally {
        c.release();
      }
    },
    async get(id) {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM claims WHERE id = $1", [id]);
        return r.rows[0] ? rowToFact(r.rows[0]) : undefined;
      } finally {
        c.release();
      }
    },
    async listAll() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM claims");
        return r.rows.map(rowToFact);
      } finally {
        c.release();
      }
    },
  };

  const analyses: AnalysisRepository = {
    async save(analysis) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO analyses (id, opportunity_id, source_ids, assumptions, formula_version, result_json, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET result_json = EXCLUDED.result_json`,
          [
            analysis.id,
            analysis.opportunityId ?? null,
            JSON.stringify(analysis.sourceIds),
            JSON.stringify(analysis.assumptions),
            analysis.formulaVersion,
            JSON.stringify(analysis.result),
            analysis.checkedAt,
          ],
        );
        return analysis;
      } finally {
        c.release();
      }
    },
    async listAll() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM analyses ORDER BY checked_at");
        return r.rows.map((row) => ({
          id: row.id as string,
          opportunityId: (row.opportunity_id as string | null) ?? undefined,
          sourceIds: (row.source_ids ?? []) as string[],
          assumptions: (row.assumptions ?? {}) as Record<string, unknown>,
          formulaVersion: row.formula_version as string,
          result: (row.result_json ?? {}) as Record<string, unknown>,
          checkedAt: requiredIso(row.checked_at as Date),
        }));
      } finally {
        c.release();
      }
    },
  };

  const offers: OfferRepository = {
    async upsertProgram(program) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO affiliate_programs (id, provider, status, terms_url, terms_checked_at, payout_currency)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, status = EXCLUDED.status,
             terms_url = EXCLUDED.terms_url, terms_checked_at = EXCLUDED.terms_checked_at,
             payout_currency = EXCLUDED.payout_currency, updated_at = now()`,
          [
            program.id,
            program.provider,
            program.status,
            program.termsUrl ?? null,
            program.termsCheckedAt ?? null,
            program.payoutCurrency,
          ],
        );
        return program;
      } finally {
        c.release();
      }
    },
    async getProgram(id) {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM affiliate_programs WHERE id = $1", [id]);
        if (!r.rows[0]) return undefined;
        const row = r.rows[0];
        return {
          id: row.id as string,
          provider: row.provider as string,
          status: row.status as never,
          termsUrl: (row.terms_url as string | null) ?? undefined,
          termsCheckedAt: iso(row.terms_checked_at as Date),
          payoutCurrency: row.payout_currency as string,
        };
      } finally {
        c.release();
      }
    },
    async upsertOffer(offer) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO affiliate_offers (id, program_id, vertical_id, title, landing_url,
             tracking_url_secret_ref, reward_model, reward_amount_jpy, conversion_event,
             channel_permissions, active, status, constraints)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO UPDATE SET program_id = EXCLUDED.program_id,
             vertical_id = EXCLUDED.vertical_id, title = EXCLUDED.title,
             landing_url = EXCLUDED.landing_url, tracking_url_secret_ref = EXCLUDED.tracking_url_secret_ref,
             reward_model = EXCLUDED.reward_model, reward_amount_jpy = EXCLUDED.reward_amount_jpy,
             conversion_event = EXCLUDED.conversion_event, channel_permissions = EXCLUDED.channel_permissions,
             active = EXCLUDED.active, status = EXCLUDED.status, constraints = EXCLUDED.constraints,
             updated_at = now()`,
          [
            offer.id,
            offer.programId,
            offer.verticalId,
            offer.title,
            offer.landingUrl ?? null,
            offer.trackingUrlSecretRef ?? null,
            offer.rewardModel,
            offer.rewardAmountJpy ?? null,
            offer.conversionEvent ?? null,
            JSON.stringify(offer.channelPermissions),
            offer.active,
            offer.status,
            JSON.stringify(offer.constraints),
          ],
        );
        return offer;
      } finally {
        c.release();
      }
    },
    async getOffer(id) {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM affiliate_offers WHERE id = $1", [id]);
        return r.rows[0] ? rowToOffer(r.rows[0]) : undefined;
      } finally {
        c.release();
      }
    },
    async listOffers() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM affiliate_offers ORDER BY id");
        return r.rows.map(rowToOffer);
      } finally {
        c.release();
      }
    },
    async listApprovedActiveOffers() {
      const c = await client();
      try {
        const r = await c.query(
          "SELECT * FROM affiliate_offers WHERE active = true AND status = 'APPROVED' ORDER BY id",
        );
        return r.rows.map(rowToOffer);
      } finally {
        c.release();
      }
    },
    async importConversion(conversion) {
      const c = await client();
      try {
        const inserted = await c.query(
          `INSERT INTO conversions (id, program_id, external_event_id, offer_id, occurred_at, status, amount, currency, amount_jpy)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (program_id, external_event_id) DO NOTHING
           RETURNING id`,
          [
            conversion.id,
            conversion.programId,
            conversion.externalEventId ?? null,
            conversion.offerId ?? null,
            conversion.occurredAt,
            conversion.status,
            conversion.amount ?? null,
            conversion.currency ?? null,
            conversion.amountJpy ?? null,
          ],
        );
        return { conversion, created: inserted.rows.length > 0 };
      } finally {
        c.release();
      }
    },
    async listConversions() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM conversions ORDER BY occurred_at");
        return r.rows.map((row) => ({
          id: row.id as string,
          programId: row.program_id as string,
          externalEventId: (row.external_event_id as string | null) ?? undefined,
          offerId: (row.offer_id as string | null) ?? undefined,
          occurredAt: requiredIso(row.occurred_at as Date),
          status: row.status as never,
          amount: optionalNumber(row.amount as string | null),
          currency: (row.currency as string | null) ?? undefined,
          amountJpy: (row.amount_jpy as number | null) ?? undefined,
        }));
      } finally {
        c.release();
      }
    },
    async importPayout(payout) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO payouts (id, program_id, paid_at, currency, amount, amount_jpy, reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO NOTHING`,
          [
            payout.id,
            payout.programId,
            payout.paidAt,
            payout.currency,
            payout.amount,
            payout.amountJpy ?? null,
            payout.reference ?? null,
          ],
        );
        return payout;
      } finally {
        c.release();
      }
    },
    async listPayouts() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM payouts ORDER BY paid_at");
        return r.rows.map((row) => ({
          id: row.id as string,
          programId: row.program_id as string,
          paidAt: requiredIso(row.paid_at as Date),
          currency: row.currency as string,
          amount: optionalNumber(row.amount as string) ?? 0,
          amountJpy: (row.amount_jpy as number | null) ?? undefined,
          reference: (row.reference as string | null) ?? undefined,
        }));
      } finally {
        c.release();
      }
    },
  };

  const metrics: MetricsRepository = {
    async upsertTrafficDaily(row) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO traffic_daily (date, page_id, channel, sessions, search_clicks, impressions)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (date, page_id, channel) DO UPDATE SET sessions = EXCLUDED.sessions,
             search_clicks = EXCLUDED.search_clicks, impressions = EXCLUDED.impressions`,
          [
            row.date,
            row.pageId,
            row.channel,
            row.sessions === "UNKNOWN" ? null : row.sessions,
            row.searchClicks === "UNKNOWN" ? null : row.searchClicks,
            row.impressions === "UNKNOWN" ? null : row.impressions,
          ],
        );
        return row;
      } finally {
        c.release();
      }
    },
    async upsertOutboundClicks(row) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO outbound_clicks_daily (date, page_id, offer_id, cta_id, channel, clicks)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (date, page_id, offer_id, cta_id, channel) DO UPDATE SET clicks = EXCLUDED.clicks`,
          [
            row.date,
            row.pageId,
            row.offerId,
            row.ctaId,
            row.channel,
            row.clicks === "UNKNOWN" ? 0 : row.clicks,
          ],
        );
        return row;
      } finally {
        c.release();
      }
    },
    async listTraffic() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM traffic_daily ORDER BY date");
        return r.rows.map((row) => ({
          date: String(row.date),
          pageId: row.page_id as string,
          channel: row.channel as string,
          sessions: (row.sessions as number | null) ?? "UNKNOWN",
          searchClicks: (row.search_clicks as number | null) ?? "UNKNOWN",
          impressions: (row.impressions as number | null) ?? "UNKNOWN",
        }));
      } finally {
        c.release();
      }
    },
    async listOutboundClicks() {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM outbound_clicks_daily ORDER BY date");
        return r.rows.map((row) => ({
          date: String(row.date),
          pageId: row.page_id as string,
          offerId: row.offer_id as string,
          ctaId: row.cta_id as string,
          channel: row.channel as string,
          clicks: row.clicks as number,
        }));
      } finally {
        c.release();
      }
    },
  };

  const spend: SpendRepository = {
    async recordSpend(record) {
      const c = await client();
      try {
        await c.query(
          `INSERT INTO spend_daily (date, category, provider, cost_jpy, source, estimated)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (date, category, provider, source)
           DO UPDATE SET cost_jpy = spend_daily.cost_jpy + EXCLUDED.cost_jpy`,
          [record.date, record.category, record.provider, record.costJpy, record.source, record.estimated],
        );
        return record;
      } finally {
        c.release();
      }
    },
    async sumMonth(yearMonth) {
      const c = await client();
      try {
        const r = await c.query<{ total: string }>(
          "SELECT COALESCE(SUM(cost_jpy), 0)::text AS total FROM spend_daily WHERE to_char(date, 'YYYY-MM') = $1",
          [yearMonth],
        );
        return Number(r.rows[0]?.total ?? "0");
      } finally {
        c.release();
      }
    },
  };

  const audit: AuditRepository = {
    async append(event) {
      const c = await client();
      try {
        const r = await c.query(
          `INSERT INTO agent_events (run_id, agent, event_type, payload_redacted, at)
           VALUES ($1,$2,$3,$4,$5) RETURNING at`,
          [event.runId, event.agent, event.eventType, JSON.stringify(event.payload), event.at],
        );
        return { ...event, at: requiredIso(r.rows[0]!.at as Date) };
      } finally {
        c.release();
      }
    },
    async listByRun(runId) {
      const c = await client();
      try {
        const r = await c.query("SELECT * FROM agent_events WHERE run_id = $1 ORDER BY at", [runId]);
        return r.rows.map((row) => ({
          runId: row.run_id as string,
          agent: row.agent as string,
          eventType: row.event_type as string,
          payload: (row.payload_redacted ?? {}) as Record<string, unknown>,
          at: requiredIso(row.at as Date),
        }));
      } finally {
        c.release();
      }
    },
  };

  const serp: SerpRepository = {
    async saveObservations(observations) {
      const c = await client();
      try {
        for (const obs of observations) {
          await c.query(
            `INSERT INTO serp_observations (id, keyword, captured_at, country, language, device, position, url, page_type, serp_features, access_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              obs.id,
              obs.keyword,
              obs.capturedAt,
              obs.country,
              obs.language,
              obs.device,
              obs.position,
              obs.url,
              obs.pageType,
              JSON.stringify(obs.serpFeatures),
              obs.accessStatus,
            ],
          );
        }
      } finally {
        c.release();
      }
    },
    async listByKeyword(keyword) {
      const c = await client();
      try {
        const r = await c.query(
          "SELECT * FROM serp_observations WHERE keyword = $1 ORDER BY captured_at, position",
          [keyword],
        );
        return r.rows.map((row) => ({
          id: row.id as string,
          keyword: row.keyword as string,
          capturedAt: requiredIso(row.captured_at as Date),
          country: row.country as "JP",
          language: row.language as "ja",
          device: row.device as "desktop" | "mobile",
          position: row.position as number,
          url: row.url as string,
          pageType: row.page_type as never,
          serpFeatures: (row.serp_features ?? []) as string[],
          accessStatus: row.access_status as "OK" | "UNKNOWN",
        }));
      } finally {
        c.release();
      }
    },
  };

  const publications = {
    async save(publication: Publication) {
      const c = await client();
      try {
        const inserted = await c.query(
          `INSERT INTO publications (id, item_id, revision_id, destination, public_url, commit_sha, status, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (revision_id, destination) DO NOTHING
           RETURNING id`,
          [
            publication.id,
            publication.itemId,
            publication.revisionId,
            publication.destination,
            publication.publicUrl ?? null,
            publication.commitSha ?? null,
            publication.status,
            publication.publishedAt,
          ],
        );
        return { publication, created: inserted.rows.length > 0 };
      } finally {
        c.release();
      }
    },
    async get(revisionId: string, destination: Publication["destination"]) {
      const c = await client();
      try {
        const r = await c.query(
          "SELECT * FROM publications WHERE revision_id = $1 AND destination = $2",
          [revisionId, destination],
        );
        if (!r.rows[0]) return undefined;
        const row = r.rows[0];
        return {
          id: row.id as string,
          itemId: row.item_id as string,
          revisionId: row.revision_id as string,
          destination: row.destination as Publication["destination"],
          publicUrl: (row.public_url as string | null) ?? undefined,
          commitSha: (row.commit_sha as string | null) ?? undefined,
          status: row.status as Publication["status"],
          publishedAt: requiredIso(row.published_at as Date),
        };
      } finally {
        c.release();
      }
    },
    async countOnDay(dayKey: string) {
      const c = await client();
      try {
        // New articles only: an article counts on the day of its first successful
        // publication, so replacing a live article (update) never uses up the slot.
        const r = await c.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM (
             SELECT item_id, min(published_at) AS first_published_at FROM publications
             WHERE destination <> 'preview' AND status = 'SUCCEEDED'
             GROUP BY item_id
           ) first_publications
           WHERE to_char(first_published_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') = $1`,
          [dayKey],
        );
        return Number(r.rows[0]?.count ?? "0");
      } finally {
        c.release();
      }
    },
  } satisfies PublicationRepository;

  return { jobs, locks, content, sources, facts, analyses, offers, metrics, spend, audit, serp, publications };
}

function rowToItem(row: QueryResultRow): {
  id: string;
  slug: string;
  locale: string;
  topic: string;
  state: ContentState;
  currentRevision?: string;
  offerIds: string[];
} {
  return {
    id: row.id as string,
    slug: row.slug as string,
    locale: row.locale as string,
    topic: row.topic as string,
    state: row.state as never,
    currentRevision: (row.current_revision as string | null) ?? undefined,
    offerIds: (row.offer_ids ?? []) as string[],
  };
}

function rowToRevision(row: QueryResultRow): {
  id: string;
  itemId: string;
  contentHash: string;
  markdownPath: string;
  qaReportId?: string;
  publishedAt?: string;
  sourceIds: string[];
} {
  return {
    id: row.id as string,
    itemId: row.item_id as string,
    contentHash: row.content_hash as string,
    markdownPath: row.markdown_path as string,
    qaReportId: (row.qa_report_id as string | null) ?? undefined,
    publishedAt: iso(row.published_at as Date),
    sourceIds: (row.source_ids ?? []) as string[],
  };
}

function rowToFact(row: QueryResultRow): Fact {
  return {
    id: row.id as string,
    text: row.text as string,
    claimType: row.claim_type as never,
    sourceIds: (row.source_ids ?? []) as string[],
    verifiedAt: requiredIso(row.verified_at as Date),
    confidence: row.confidence as number,
    verificationStatus: row.verification_status as never,
    expiresAt: iso(row.expires_at as Date),
  };
}

function rowToOffer(row: QueryResultRow): AffiliateOffer {
  return {
    id: row.id as string,
    programId: row.program_id as string,
    verticalId: row.vertical_id as string,
    title: row.title as string,
    landingUrl: (row.landing_url as string | null) ?? undefined,
    trackingUrlSecretRef: (row.tracking_url_secret_ref as string | null) ?? undefined,
    rewardModel: row.reward_model as never,
    rewardAmountJpy: (row.reward_amount_jpy as number | null) ?? undefined,
    conversionEvent: (row.conversion_event as string | null) ?? undefined,
    channelPermissions: (row.channel_permissions ?? []) as never[],
    active: row.active as boolean,
    status: row.status as never,
    constraints: (row.constraints ?? {}) as Record<string, string | number | boolean>,
  };
}
