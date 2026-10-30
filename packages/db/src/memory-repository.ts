import {
  assertJobTransition,
  type AffiliateOffer,
  type AffiliateProgram,
  type ContentItem,
  type ContentRevision,
  type ContentState,
  type Conversion,
  type DailyOutboundClicks,
  type DailyTraffic,
  type Fact,
  type JobState,
  type Payout,
  type Publication,
  type QualityDecision,
  type SerpObservation,
  type SourceRecord,
  type SpendRecord,
  newId,
  dayKeyInTz,
} from "@aff/domain";
import type {
  AgentEventRecord,
  AnalysisRecord,
  AuditRepository,
  AnalysisRepository,
  ContentRepository,
  ContentTransitionRecord,
  FactRepository,
  JobRunRepository,
  LockRepository,
  MetricsRepository,
  OfferRepository,
  Repository,
  SerpRepository,
  SourceRepository,
  SpendRepository,
} from "./repository.js";
import type { JobRunEnqueueInput, JobRunRecord } from "./records.js";

function nowIso(): string {
  return new Date().toISOString();
}

class MemoryJobRunRepository implements JobRunRepository {
  private readonly byKey = new Map<string, JobRunRecord>();
  private readonly byId = new Map<string, JobRunRecord>();

  async enqueue(input: JobRunEnqueueInput): Promise<{ record: JobRunRecord; created: boolean }> {
    const existing = this.byKey.get(input.jobKey);
    if (existing) {
      return { record: existing, created: false };
    }
    const ts = nowIso();
    const record: JobRunRecord = {
      id: newId("job"),
      jobKey: input.jobKey,
      jobType: input.jobType,
      state: "PENDING",
      attempt: 0,
      payload: input.payload ?? {},
      checkpoint: {},
      traceId: input.traceId,
      costJpy: 0,
      runAfter: input.runAfter ?? ts,
      createdAt: ts,
      updatedAt: ts,
    };
    this.byKey.set(record.jobKey, record);
    this.byId.set(record.id, record);
    return { record, created: true };
  }

  async getByJobKey(jobKey: string): Promise<JobRunRecord | undefined> {
    return this.byKey.get(jobKey);
  }

  async get(id: string): Promise<JobRunRecord | undefined> {
    return this.byId.get(id);
  }

  async update(record: JobRunRecord): Promise<JobRunRecord> {
    const current = this.byId.get(record.id);
    if (!current) throw new Error(`job run not found: ${record.id}`);
    if (current.state !== record.state) {
      assertJobTransition(current.state, record.state);
    }
    const updated: JobRunRecord = { ...record, updatedAt: nowIso() };
    this.byId.set(record.id, updated);
    this.byKey.set(record.jobKey, updated);
    return updated;
  }

  async listReady(nowIsoValue: string, limit: number): Promise<JobRunRecord[]> {
    const now = Date.parse(nowIsoValue);
    return [...this.byId.values()]
      .filter(
        (r) =>
          (r.state === "PENDING" || r.state === "RETRY_SCHEDULED") &&
          Date.parse(r.runAfter) <= now,
      )
      .sort((a, b) => Date.parse(a.runAfter) - Date.parse(b.runAfter))
      .slice(0, limit);
  }

  async countByState(): Promise<Record<JobState, number>> {
    const counts = {
      PENDING: 0,
      RUNNING: 0,
      SUCCEEDED: 0,
      RETRY_SCHEDULED: 0,
      DEAD_LETTER: 0,
      CANCELED: 0,
    } as Record<JobState, number>;
    for (const r of this.byId.values()) counts[r.state] += 1;
    return counts;
  }
}

class MemoryLockRepository implements LockRepository {
  private readonly held = new Map<string, { holder: string; expiresAt: number }>();

  async tryAcquire(lockKey: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.held.get(lockKey);
    const now = Date.now();
    if (existing && existing.expiresAt > now) {
      return existing.holder === holder;
    }
    this.held.set(lockKey, { holder, expiresAt: now + ttlSeconds * 1000 });
    return true;
  }

  async release(lockKey: string, holder: string): Promise<boolean> {
    const existing = this.held.get(lockKey);
    if (!existing || existing.holder !== holder) return false;
    this.held.delete(lockKey);
    return true;
  }
}

class MemoryContentRepository implements ContentRepository {
  private readonly items = new Map<string, ContentItem>();
  private readonly revisions = new Map<string, ContentRevision>();
  private readonly qaReports = new Map<string, QualityDecision>();
  private readonly transitions = new Map<string, ContentTransitionRecord[]>();

  async createIfNotExists(input: {
    slug: string;
    locale: string;
    topic: string;
    offerIds?: string[];
  }): Promise<ContentItem> {
    const existing = [...this.items.values()].find(
      (i) => i.slug === input.slug && i.locale === input.locale,
    );
    if (existing) return existing;
    const item: ContentItem = {
      id: newId("item"),
      slug: input.slug,
      locale: input.locale,
      topic: input.topic,
      state: "DISCOVERED",
      offerIds: input.offerIds ?? [],
    };
    this.items.set(item.id, item);
    return item;
  }

  async get(itemId: string): Promise<ContentItem | undefined> {
    return this.items.get(itemId);
  }

  async getBySlug(slug: string, locale: string): Promise<ContentItem | undefined> {
    return [...this.items.values()].find((i) => i.slug === slug && i.locale === locale);
  }

  async listAll(): Promise<ContentItem[]> {
    return [...this.items.values()];
  }

  async updateState(itemId: string, state: ContentState): Promise<ContentItem> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`content item not found: ${itemId}`);
    const updated = { ...item, state, updatedAt: nowIso() };
    this.items.set(itemId, updated);
    return updated;
  }

  async setCurrentRevision(itemId: string, revisionId: string): Promise<ContentItem> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`content item not found: ${itemId}`);
    const updated = { ...item, currentRevision: revisionId };
    this.items.set(itemId, updated);
    return updated;
  }

  async saveRevision(revision: ContentRevision): Promise<ContentRevision> {
    this.revisions.set(revision.id, revision);
    return revision;
  }

  async getRevision(revisionId: string): Promise<ContentRevision | undefined> {
    return this.revisions.get(revisionId);
  }

  async getLatestRevision(itemId: string): Promise<ContentRevision | undefined> {
    let latest: ContentRevision | undefined;
    for (const rev of this.revisions.values()) {
      if (rev.itemId === itemId) latest = rev; // Map preserves insertion order
    }
    return latest;
  }

  async saveQaReport(decision: QualityDecision): Promise<QualityDecision> {
    this.qaReports.set(decision.id, decision);
    return decision;
  }

  async getLatestQaReport(itemId: string): Promise<QualityDecision | undefined> {
    return [...this.qaReports.values()]
      .filter((r) => r.itemId === itemId)
      .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt))
      .at(-1);
  }

  async recordTransition(transition: ContentTransitionRecord): Promise<void> {
    const list = this.transitions.get(transition.itemId) ?? [];
    list.push(transition);
    this.transitions.set(transition.itemId, list);
  }

  async listTransitions(itemId: string): Promise<ContentTransitionRecord[]> {
    return [...(this.transitions.get(itemId) ?? [])];
  }
}

class MemorySourceRepository implements SourceRepository {
  private readonly sources = new Map<string, SourceRecord>();

  async save(source: SourceRecord): Promise<SourceRecord> {
    this.sources.set(source.id, source);
    return source;
  }

  async getLatestByUrl(canonicalUrl: string): Promise<SourceRecord | undefined> {
    return [...this.sources.values()]
      .filter((s) => s.canonicalUrl === canonicalUrl)
      .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
      .at(-1);
  }

  async list(): Promise<SourceRecord[]> {
    return [...this.sources.values()];
  }
}

class MemoryFactRepository implements FactRepository {
  private readonly facts = new Map<string, Fact>();

  async save(fact: Fact): Promise<Fact> {
    this.facts.set(fact.id, fact);
    return fact;
  }

  async get(id: string): Promise<Fact | undefined> {
    return this.facts.get(id);
  }

  async listAll(): Promise<Fact[]> {
    return [...this.facts.values()];
  }
}

class MemoryAnalysisRepository implements AnalysisRepository {
  private readonly analyses = new Map<string, AnalysisRecord>();

  async save(analysis: AnalysisRecord): Promise<AnalysisRecord> {
    this.analyses.set(analysis.id, analysis);
    return analysis;
  }

  async listAll(): Promise<AnalysisRecord[]> {
    return [...this.analyses.values()];
  }
}

class MemoryOfferRepository implements OfferRepository {
  private readonly programs = new Map<string, AffiliateProgram>();
  private readonly offers = new Map<string, AffiliateOffer>();
  private readonly conversions = new Map<string, Conversion>();
  private readonly payouts = new Map<string, Payout>();
  private readonly conversionKeys = new Set<string>();

  async upsertProgram(program: AffiliateProgram): Promise<AffiliateProgram> {
    this.programs.set(program.id, program);
    return program;
  }

  async getProgram(id: string): Promise<AffiliateProgram | undefined> {
    return this.programs.get(id);
  }

  async upsertOffer(offer: AffiliateOffer): Promise<AffiliateOffer> {
    this.offers.set(offer.id, offer);
    return offer;
  }

  async getOffer(id: string): Promise<AffiliateOffer | undefined> {
    return this.offers.get(id);
  }

  async listOffers(): Promise<AffiliateOffer[]> {
    return [...this.offers.values()];
  }

  async listApprovedActiveOffers(): Promise<AffiliateOffer[]> {
    return [...this.offers.values()].filter((o) => o.active && o.status === "APPROVED");
  }

  private readonly trackingUrls = new Map<string, string>();

  async setProgramTrackingUrl(programId: string, url: string | undefined): Promise<void> {
    if (url === undefined) this.trackingUrls.delete(programId);
    else this.trackingUrls.set(programId, url);
  }

  async hasProgramTrackingUrl(programId: string): Promise<boolean> {
    return this.trackingUrls.has(programId);
  }

  async listOfferTrackingUrls(): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const offer of this.offers.values()) {
      const url = this.trackingUrls.get(offer.programId);
      if (!url || !offer.active || offer.status !== "APPROVED" || !offer.channelPermissions.includes("site")) continue;
      if (this.programs.get(offer.programId)?.status !== "APPROVED") continue;
      resolved[offer.id] = url;
    }
    return resolved;
  }

  async importConversion(conversion: Conversion): Promise<{ conversion: Conversion; created: boolean }> {
    if (conversion.externalEventId) {
      const key = `${conversion.programId}:${conversion.externalEventId}`;
      if (this.conversionKeys.has(key)) {
        return { conversion: conversion, created: false };
      }
      this.conversionKeys.add(key);
    }
    this.conversions.set(conversion.id, conversion);
    return { conversion, created: true };
  }

  async listConversions(): Promise<Conversion[]> {
    return [...this.conversions.values()];
  }

  async importPayout(payout: Payout): Promise<Payout> {
    this.payouts.set(payout.id, payout);
    return payout;
  }

  async listPayouts(): Promise<Payout[]> {
    return [...this.payouts.values()];
  }
}

class MemoryMetricsRepository implements MetricsRepository {
  private readonly traffic = new Map<string, DailyTraffic>();
  private readonly clicks = new Map<string, DailyOutboundClicks>();

  async upsertTrafficDaily(row: DailyTraffic): Promise<DailyTraffic> {
    const key = `${row.date}:${row.pageId}:${row.channel}`;
    this.traffic.set(key, row);
    return row;
  }

  async upsertOutboundClicks(row: DailyOutboundClicks): Promise<DailyOutboundClicks> {
    const key = `${row.date}:${row.pageId}:${row.offerId}:${row.ctaId}:${row.channel}`;
    this.clicks.set(key, row);
    return row;
  }

  async listTraffic(): Promise<DailyTraffic[]> {
    return [...this.traffic.values()];
  }

  async listOutboundClicks(): Promise<DailyOutboundClicks[]> {
    return [...this.clicks.values()];
  }
}

class MemorySpendRepository implements SpendRepository {
  private readonly rows = new Map<string, SpendRecord>();

  async recordSpend(record: SpendRecord): Promise<SpendRecord> {
    const key = `${record.date}:${record.category}:${record.provider}:${record.source}`;
    const existing = this.rows.get(key);
    if (existing) {
      const merged = { ...existing, costJpy: existing.costJpy + record.costJpy };
      this.rows.set(key, merged);
      return merged;
    }
    this.rows.set(key, record);
    return record;
  }

  async sumMonth(yearMonth: string): Promise<number> {
    return [...this.rows.values()]
      .filter((r) => r.date.startsWith(yearMonth))
      .reduce((sum, r) => sum + r.costJpy, 0);
  }
}

class MemoryAuditRepository implements AuditRepository {
  private readonly events: AgentEventRecord[] = [];

  async append(event: AgentEventRecord): Promise<AgentEventRecord> {
    const record = { ...event, at: event.at ?? nowIso() };
    this.events.push(record);
    return record;
  }

  async listByRun(runId: string): Promise<AgentEventRecord[]> {
    return this.events.filter((e) => e.runId === runId);
  }
}

class MemoryPublicationRepository {
  private readonly byKey = new Map<string, Publication>();

  async save(publication: Publication): Promise<{ publication: Publication; created: boolean }> {
    const key = `${publication.revisionId}:${publication.destination}`;
    const existing = this.byKey.get(key);
    if (existing) return { publication: existing, created: false };
    this.byKey.set(key, publication);
    return { publication, created: true };
  }

  async get(revisionId: string, destination: Publication["destination"]): Promise<Publication | undefined> {
    return this.byKey.get(`${revisionId}:${destination}`);
  }

  /** New articles only: an article counts on the day of its first successful publication. */
  async countOnDay(dayKey: string): Promise<number> {
    const firstPublishedAt = new Map<string, number>();
    for (const p of this.byKey.values()) {
      if (p.destination === "preview" || p.status !== "SUCCEEDED") continue;
      const at = Date.parse(p.publishedAt);
      const known = firstPublishedAt.get(p.itemId);
      if (known === undefined || at < known) firstPublishedAt.set(p.itemId, at);
    }
    return [...firstPublishedAt.values()].filter((at) => dayKeyInTz(new Date(at)) === dayKey).length;
  }
}

class MemorySerpRepository implements SerpRepository {
  private readonly rows: SerpObservation[] = [];

  async saveObservations(observations: SerpObservation[]): Promise<void> {
    this.rows.push(...observations);
  }

  async listByKeyword(keyword: string): Promise<SerpObservation[]> {
    return this.rows.filter((r) => r.keyword === keyword);
  }
}

export function createMemoryRepository(): Repository {
  return {
    jobs: new MemoryJobRunRepository(),
    locks: new MemoryLockRepository(),
    content: new MemoryContentRepository(),
    sources: new MemorySourceRepository(),
    facts: new MemoryFactRepository(),
    analyses: new MemoryAnalysisRepository(),
    offers: new MemoryOfferRepository(),
    metrics: new MemoryMetricsRepository(),
    spend: new MemorySpendRepository(),
    audit: new MemoryAuditRepository(),
    serp: new MemorySerpRepository(),
    publications: new MemoryPublicationRepository(),
  };
}
