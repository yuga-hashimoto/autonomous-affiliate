import type { JobState } from "@aff/domain";
import type {
  AffiliateOffer,
  AffiliateProgram,
  ContentItem,
  ContentRevision,
  ContentState,
  Conversion,
  DailyOutboundClicks,
  DailyTraffic,
  Fact,
  Payout,
  Publication,
  QualityDecision,
  SerpObservation,
  SourceRecord,
  SpendRecord,
} from "@aff/domain";
import type { JobRunEnqueueInput, JobRunRecord } from "./records.js";

export interface AnalysisRecord {
  id: string;
  opportunityId?: string;
  sourceIds: string[];
  assumptions: Record<string, unknown>;
  formulaVersion: string;
  result: Record<string, unknown>;
  checkedAt: string;
}

export interface AgentEventRecord {
  runId: string;
  agent: string;
  eventType: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface ContentTransitionRecord {
  itemId: string;
  runId: string;
  /** Always a real state: the table (and every caller) records a move from one state to another. */
  fromState: ContentState;
  toState: ContentState;
  policyVersion: string;
  evidenceIds: string[];
  at: string;
}

export interface JobRunRepository {
  enqueue(input: JobRunEnqueueInput): Promise<{ record: JobRunRecord; created: boolean }>;
  getByJobKey(jobKey: string): Promise<JobRunRecord | undefined>;
  get(id: string): Promise<JobRunRecord | undefined>;
  /** Persists the record; validates the state transition via the domain state machine. */
  update(record: JobRunRecord): Promise<JobRunRecord>;
  listReady(nowIso: string, limit: number): Promise<JobRunRecord[]>;
  countByState(): Promise<Record<JobState, number>>;
}

export interface LockRepository {
  tryAcquire(lockKey: string, holder: string, ttlSeconds: number): Promise<boolean>;
  release(lockKey: string, holder: string): Promise<boolean>;
}

export interface ContentRepository {
  createIfNotExists(input: { slug: string; locale: string; topic: string; offerIds?: string[] }): Promise<ContentItem>;
  get(itemId: string): Promise<ContentItem | undefined>;
  getBySlug(slug: string, locale: string): Promise<ContentItem | undefined>;
  listAll(): Promise<ContentItem[]>;
  updateState(itemId: string, state: ContentState): Promise<ContentItem>;
  setCurrentRevision(itemId: string, revisionId: string): Promise<ContentItem>;
  saveRevision(revision: ContentRevision): Promise<ContentRevision>;
  getRevision(revisionId: string): Promise<ContentRevision | undefined>;
  getLatestRevision(itemId: string): Promise<ContentRevision | undefined>;
  saveQaReport(decision: QualityDecision): Promise<QualityDecision>;
  getLatestQaReport(itemId: string): Promise<QualityDecision | undefined>;
  recordTransition(transition: ContentTransitionRecord): Promise<void>;
  listTransitions(itemId: string): Promise<ContentTransitionRecord[]>;
}

export interface SourceRepository {
  save(source: SourceRecord): Promise<SourceRecord>;
  getLatestByUrl(canonicalUrl: string): Promise<SourceRecord | undefined>;
  list(): Promise<SourceRecord[]>;
}

export interface FactRepository {
  save(fact: Fact): Promise<Fact>;
  get(id: string): Promise<Fact | undefined>;
  listAll(): Promise<Fact[]>;
}

export interface AnalysisRepository {
  save(analysis: AnalysisRecord): Promise<AnalysisRecord>;
  listAll(): Promise<AnalysisRecord[]>;
}

export interface OfferRepository {
  upsertProgram(program: AffiliateProgram): Promise<AffiliateProgram>;
  getProgram(id: string): Promise<AffiliateProgram | undefined>;
  upsertOffer(offer: AffiliateOffer): Promise<AffiliateOffer>;
  getOffer(id: string): Promise<AffiliateOffer | undefined>;
  listOffers(): Promise<AffiliateOffer[]>;
  listApprovedActiveOffers(): Promise<AffiliateOffer[]>;
  /**
   * The ad link the ASP issued for a program. Kept apart from programs and offers so it
   * cannot travel with them into a trace, a log or a draft; `undefined` clears it.
   */
  setProgramTrackingUrl(programId: string, url: string | undefined): Promise<void>;
  /** Whether a link is stored, without handing the link to the caller. */
  hasProgramTrackingUrl(programId: string): Promise<boolean>;
  /**
   * Offer id -> ad link, for the offers that may be monetized right now (active, approved,
   * site channel, on an approved program that has a link). The site builds /go/ from this.
   */
  listOfferTrackingUrls(): Promise<Record<string, string>>;
  importConversion(conversion: Conversion): Promise<{ conversion: Conversion; created: boolean }>;
  listConversions(): Promise<Conversion[]>;
  importPayout(payout: Payout): Promise<Payout>;
  listPayouts(): Promise<Payout[]>;
}

export type ScoutedState = "vetted" | "active" | "rejected" | "retired";

/** An advertiser the daily run picked from the A8 console (docs/21). Private: never in a log, a trace or the repository. */
export interface ScoutedBrand {
  /** The A8 program id. */
  programId: string;
  brandSlug: string;
  state: ScoutedState;
  /** The advertiser's name as the console card shows it. */
  keyword: string;
  /** The advertiser's site (its own name, no www). */
  host: string;
  /** The company as its own pages name it. */
  brandName: string;
  termsUrl?: string | undefined;
  termsSha256?: string | undefined;
  listUrls: string[];
  sourceUrls: string[];
  /** Why the candidate was refused (empty otherwise). */
  reasons: string[];
  checkedAt: string;
}

export interface ScoutRepository {
  get(programId: string): Promise<ScoutedBrand | undefined>;
  list(): Promise<ScoutedBrand[]>;
  upsert(brand: ScoutedBrand): Promise<void>;
}

export interface MetricsRepository {
  upsertTrafficDaily(row: DailyTraffic): Promise<DailyTraffic>;
  upsertOutboundClicks(row: DailyOutboundClicks): Promise<DailyOutboundClicks>;
  listTraffic(): Promise<DailyTraffic[]>;
  listOutboundClicks(): Promise<DailyOutboundClicks[]>;
}

export interface SpendRepository {
  recordSpend(record: SpendRecord): Promise<SpendRecord>;
  sumMonth(yearMonth: string): Promise<number>;
}

export interface AuditRepository {
  append(event: AgentEventRecord): Promise<AgentEventRecord>;
  listByRun(runId: string): Promise<AgentEventRecord[]>;
}

export interface SerpRepository {
  saveObservations(observations: SerpObservation[]): Promise<void>;
  listByKeyword(keyword: string): Promise<SerpObservation[]>;
}

export interface PublicationRepository {
  /** Idempotent on (revisionId, destination): returns the existing publication. */
  save(publication: Publication): Promise<{ publication: Publication; created: boolean }>;
  get(revisionId: string, destination: Publication["destination"]): Promise<Publication | undefined>;
  /**
   * Number of articles whose first successful non-preview publication falls on
   * the day key (YYYY-MM-DD, Asia/Tokyo). Later revisions of an article (updates)
   * do not count: the daily limit caps new articles only.
   */
  countOnDay(dayKey: string): Promise<number>;
}

export interface Repository {
  jobs: JobRunRepository;
  locks: LockRepository;
  content: ContentRepository;
  sources: SourceRepository;
  facts: FactRepository;
  analyses: AnalysisRepository;
  offers: OfferRepository;
  metrics: MetricsRepository;
  spend: SpendRepository;
  audit: AuditRepository;
  serp: SerpRepository;
  publications: PublicationRepository;
  scout: ScoutRepository;
}
