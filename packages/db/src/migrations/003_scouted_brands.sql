-- Advertisers the daily run picked itself from the A8 console (docs/21). The names, the hosts and
-- the program ids are member-only, so they live here and never in the public repository.
CREATE TABLE IF NOT EXISTS scouted_brands (
  program_id   TEXT PRIMARY KEY,
  brand_slug   TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('vetted', 'active', 'rejected', 'retired')),
  keyword      TEXT NOT NULL,
  host         TEXT NOT NULL,
  brand_name   TEXT NOT NULL,
  terms_url    TEXT,
  terms_sha256 TEXT,
  list_urls    JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_urls  JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scouted_brands_state_idx ON scouted_brands (state);
