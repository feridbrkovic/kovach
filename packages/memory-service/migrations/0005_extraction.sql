-- 0005_extraction: proposed memories from finished sessions (Phase 5).

-- Messages up to this time have been read by the extraction job, so a session
-- that continues later is only read from where it left off.
ALTER TABLE sessions ADD COLUMN extracted_at INTEGER;
