-- 001_init.sql — initial schema per docs/05-data-model.md
-- Applied by packages/db (see pg/migrate.ts). Timestamps are timestamptz (UTC).

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','SUCCEEDED','RETRY_SCHEDULED','DEAD_LETTER','CANCELED')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  payload JSONB NOT NULL DEFAULT '{}',
  checkpoint JSONB NOT NULL DEFAULT '{}',
  trace_id TEXT NOT NULL,
  cost_jpy INTEGER NOT NULL DEFAULT 0 CHECK (cost_jpy >= 0),
  last_error TEXT,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_runs_state_run_after ON job_runs (state, run_after);

CREATE TABLE IF NOT EXISTS locks (
  lock_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS affiliate_programs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','TERMINATED')),
  terms_url TEXT,
  terms_checked_at TIMESTAMPTZ,
  payout_currency TEXT NOT NULL DEFAULT 'JPY',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS affiliate_offers (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES affiliate_programs(id),
  vertical_id TEXT NOT NULL,
  title TEXT NOT NULL,
  landing_url TEXT,
  tracking_url_secret_ref TEXT,
  reward_model TEXT NOT NULL CHECK (reward_model IN ('fixed_jpy','rate_percent','unknown')),
  reward_amount_jpy INTEGER CHECK (reward_amount_jpy IS NULL OR reward_amount_jpy >= 0),
  conversion_event TEXT,
  channel_permissions JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  constraints JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  intent TEXT NOT NULL,
  audience TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  source_ids JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'DISCOVERED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS serp_observations (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  country TEXT NOT NULL CHECK (country = 'JP'),
  language TEXT NOT NULL CHECK (language = 'ja'),
  device TEXT NOT NULL CHECK (device IN ('desktop','mobile')),
  position INTEGER NOT NULL CHECK (position >= 1),
  url TEXT NOT NULL,
  page_type TEXT NOT NULL,
  serp_features JSONB NOT NULL DEFAULT '[]',
  access_status TEXT NOT NULL CHECK (access_status IN ('OK','UNKNOWN'))
);
CREATE INDEX IF NOT EXISTS idx_serp_keyword ON serp_observations (keyword, captured_at);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('official','asp_report','regulatory','other')),
  fetched_at TIMESTAMPTZ NOT NULL,
  hash TEXT NOT NULL,
  provenance TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/html'
);
CREATE INDEX IF NOT EXISTS idx_sources_url ON sources (canonical_url, fetched_at DESC);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  source_ids JSONB NOT NULL DEFAULT '[]',
  verified_at TIMESTAMPTZ,
  confidence REAL NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('VERIFIED','UNKNOWN','INVALID')),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT,
  source_ids JSONB NOT NULL DEFAULT '[]',
  assumptions JSONB NOT NULL DEFAULT '{}',
  formula_version TEXT NOT NULL,
  result_json JSONB NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  redaction_status TEXT NOT NULL DEFAULT 'PENDING',
  retention_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS content_items (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ja-JP',
  topic TEXT NOT NULL,
  state TEXT NOT NULL,
  current_revision TEXT,
  offer_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (slug, locale)
);

CREATE TABLE IF NOT EXISTS content_revisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES content_items(id),
  content_hash TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  qa_report_id TEXT,
  published_at TIMESTAMPTZ,
  source_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qa_reports (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASS','FAIL','UNKNOWN')),
  checks JSONB NOT NULL DEFAULT '[]',
  reasons JSONB NOT NULL DEFAULT '[]',
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('preview','git','pages')),
  public_url TEXT,
  commit_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','ROLLED_BACK')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (revision_id, destination)
);

CREATE TABLE IF NOT EXISTS content_transitions (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbound_clicks_daily (
  date DATE NOT NULL,
  page_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  cta_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  PRIMARY KEY (date, page_id, offer_id, cta_id, channel)
);

CREATE TABLE IF NOT EXISTS traffic_daily (
  date DATE NOT NULL,
  page_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sessions INTEGER,
  search_clicks INTEGER,
  impressions INTEGER,
  PRIMARY KEY (date, page_id, channel)
);

CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  external_event_id TEXT,
  offer_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELED','PAID')),
  amount NUMERIC(12,2),
  currency TEXT,
  amount_jpy INTEGER,
  UNIQUE (program_id, external_event_id)
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  amount_jpy INTEGER,
  reference TEXT
);

CREATE TABLE IF NOT EXISTS spend_daily (
  date DATE NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('llm','api','infra','other')),
  provider TEXT NOT NULL,
  cost_jpy INTEGER NOT NULL CHECK (cost_jpy >= 0),
  source TEXT NOT NULL,
  estimated BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (date, category, provider, source)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_redacted JSONB NOT NULL DEFAULT '{}',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_versions (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  active_from TIMESTAMPTZ NOT NULL,
  policy_json JSONB NOT NULL
);
