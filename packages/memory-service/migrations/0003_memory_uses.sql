-- 0003_memory_uses: what retrieval gave the agent, the project card cache, and memory settings.

-- Items given to the agent for one answer. `cited` = the answer referred to it ([m:...]).
-- Feeds the "used memories" list under answers and use_count.
CREATE TABLE memory_uses (
  message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ref_type          TEXT NOT NULL CHECK (ref_type IN ('memory', 'episode', 'doc')),
  ref_id            TEXT NOT NULL,
  text              TEXT NOT NULL,
  score             REAL NOT NULL,
  reasons_json      TEXT NOT NULL DEFAULT '[]',
  possibly_outdated INTEGER NOT NULL DEFAULT 0,
  tokens            INTEGER NOT NULL DEFAULT 0,
  cited             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, ref_type, ref_id)
);
CREATE INDEX memory_uses_ref ON memory_uses(ref_type, ref_id);

-- A deleted memory or episode leaves no trace in the "used" lists either (T7).
CREATE TRIGGER memories_ad_uses AFTER DELETE ON memories BEGIN
  DELETE FROM memory_uses WHERE ref_type = 'memory' AND ref_id = old.id;
END;
CREATE TRIGGER episodes_ad_uses AFTER DELETE ON episodes BEGIN
  DELETE FROM memory_uses WHERE ref_type = 'episode' AND ref_id = old.id;
END;

-- The scanner's project card (computed, not a memory). Rebuilt when the manifests change.
CREATE TABLE project_cards (
  project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  card_json     TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  scanned_at    INTEGER NOT NULL
);

-- Small key/value store for memory settings (project modes live on `projects`).
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
