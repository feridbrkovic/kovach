-- 0001_init: history, long-term memory, docs, jobs and search cache.
-- Schema from MASTER_PLAN.md › Data model. Never edit after it is committed;
-- add a new numbered migration instead.

-- ---------------------------------------------------------------------------
-- History
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  path        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  memory_mode TEXT NOT NULL DEFAULT 'on' CHECK (memory_mode IN ('on', 'read_only', 'off')),
  is_client   INTEGER NOT NULL DEFAULT 0,  -- client work defaults to read_only
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title      TEXT,
  summary    TEXT,
  model      TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_project_updated ON sessions(project_id, updated_at DESC);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content    TEXT NOT NULL,
  model      TEXT,
  tokens     INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_session_created ON messages(session_id, created_at);

CREATE TABLE tool_calls (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  args_json      TEXT,
  command        TEXT,
  exit_code      INTEGER,
  output_excerpt TEXT CHECK (output_excerpt IS NULL OR length(CAST(output_excerpt AS BLOB)) <= 8192),
  output_path    TEXT,          -- full output in a blob file
  duration_ms    INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX tool_calls_message ON tool_calls(message_id);

-- ---------------------------------------------------------------------------
-- Long-term memory
-- ---------------------------------------------------------------------------
CREATE TABLE memories (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('preference', 'decision', 'convention', 'open_issue', 'lesson', 'research')),
  scope            TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,   -- normalized subject, e.g. 'style.semicolons'
  body             TEXT NOT NULL,
  trust            TEXT NOT NULL CHECK (trust IN ('user', 'verified', 'official', 'inferred')),
  status           TEXT NOT NULL CHECK (status IN ('active', 'pending_review', 'superseded', 'stale', 'rejected')),
  pinned           INTEGER NOT NULL DEFAULT 0,
  applies_to_json  TEXT,            -- e.g. {"react-native":"0.76"}
  supersedes_id    TEXT REFERENCES memories(id) ON DELETE SET NULL,
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  use_count        INTEGER NOT NULL DEFAULT 0,
  last_used_at     INTEGER,
  review_after     INTEGER,         -- revalidation time; for candidates: expiry
  seen_in_sessions INTEGER NOT NULL DEFAULT 1,  -- candidates: recurrence count
  conflicts_with   TEXT REFERENCES memories(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX memories_lookup ON memories(scope, project_id, key, status);
-- At most one active memory per subject in a scope.
CREATE UNIQUE INDEX memories_one_active
  ON memories(scope, COALESCE(project_id, ''), key)
  WHERE status = 'active';

CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  problem         TEXT NOT NULL,
  error_signature TEXT,             -- paths, line numbers, timestamps, hashes stripped
  env_json        TEXT NOT NULL DEFAULT '{}',
  attempts_json   TEXT NOT NULL DEFAULT '[]',
  fix_summary     TEXT NOT NULL,
  files_json      TEXT NOT NULL DEFAULT '[]',
  verified_by     TEXT NOT NULL CHECK (verified_by IN ('test', 'build', 'typecheck', 'run', 'user')),
  lesson          TEXT,             -- project-neutral; the only part shown cross-project
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'rejected')),
  created_at      INTEGER NOT NULL
);
CREATE INDEX episodes_signature ON episodes(error_signature);

CREATE TABLE sources (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  title        TEXT,
  is_official  INTEGER NOT NULL DEFAULT 0,
  library      TEXT,
  version      TEXT,
  published_at INTEGER,
  retrieved_at INTEGER NOT NULL,
  content_hash TEXT,
  excerpt      TEXT                 -- short excerpt only, never the full page
);

CREATE TABLE memory_events (
  id         INTEGER PRIMARY KEY,
  memory_id  TEXT,
  episode_id TEXT,
  action     TEXT NOT NULL CHECK (action IN ('created', 'accepted', 'edited', 'superseded', 'injected', 'deleted')),
  actor      TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  session_id TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX memory_events_memory ON memory_events(memory_id, at);

-- ---------------------------------------------------------------------------
-- Docs packs (official documentation per library version)
-- ---------------------------------------------------------------------------
CREATE TABLE doc_packs (
  id           TEXT PRIMARY KEY,
  library      TEXT NOT NULL,
  version      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('building', 'ready', 'stale', 'failed')),
  source_url   TEXT NOT NULL,
  retrieved_at INTEGER,
  UNIQUE (library, version)
);

CREATE TABLE doc_chunks (
  id      TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES doc_packs(id) ON DELETE CASCADE,
  heading TEXT NOT NULL,
  text    TEXT NOT NULL
);
CREATE INDEX doc_chunks_pack ON doc_chunks(pack_id);

-- ---------------------------------------------------------------------------
-- Background jobs and web search cache
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('extraction', 'embedding', 'doc_pack', 'reindex', 'skill_research')),
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  run_after    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX jobs_ready ON jobs(status, run_after);

CREATE TABLE search_cache (
  key          TEXT PRIMARY KEY,    -- normalized query or page URL
  kind         TEXT NOT NULL CHECK (kind IN ('query', 'page')),
  provider     TEXT NOT NULL,       -- searxng | exa | fetch
  payload_json TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Keyword search (FTS5) and triggers that keep it in sync
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- One index over memories and episodes; ref_type tells them apart.
CREATE VIRTUAL TABLE memory_fts USING fts5(ref_id UNINDEXED, ref_type UNINDEXED, text);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(ref_id, ref_type, text) VALUES (new.id, 'memory', new.key || ' ' || new.body);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF key, body ON memories BEGIN
  DELETE FROM memory_fts WHERE ref_type = 'memory' AND ref_id = old.id;
  INSERT INTO memory_fts(ref_id, ref_type, text) VALUES (new.id, 'memory', new.key || ' ' || new.body);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memory_fts WHERE ref_type = 'memory' AND ref_id = old.id;
END;

CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO memory_fts(ref_id, ref_type, text) VALUES (
    new.id, 'episode',
    new.problem || ' ' || COALESCE(new.error_signature, '') || ' ' || new.fix_summary || ' ' || COALESCE(new.lesson, '')
  );
END;
CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
  DELETE FROM memory_fts WHERE ref_type = 'episode' AND ref_id = old.id;
END;

CREATE VIRTUAL TABLE doc_fts USING fts5(chunk_id UNINDEXED, heading, text);

CREATE TRIGGER doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
  INSERT INTO doc_fts(chunk_id, heading, text) VALUES (new.id, new.heading, new.text);
END;
CREATE TRIGGER doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
  DELETE FROM doc_fts WHERE chunk_id = old.id;
END;
