-- The ad link an ASP issued for a program (docs/20). It is private, so it lives in its own
-- column and never in the offer or program records that traces and drafts read.
ALTER TABLE affiliate_programs ADD COLUMN IF NOT EXISTS tracking_url TEXT;
