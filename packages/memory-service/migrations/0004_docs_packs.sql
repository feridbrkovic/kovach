-- 0004_docs_packs: version-bound docs packs per project, and project seeding.

-- Where a chunk came from: the file path in the docs repo and a link to read it.
ALTER TABLE doc_chunks ADD COLUMN path TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_chunks ADD COLUMN url TEXT NOT NULL DEFAULT '';

-- What a build resolved to (e.g. "nearest docs: 0.77 for 0.76") and why a build failed.
ALTER TABLE doc_packs ADD COLUMN note TEXT;
ALTER TABLE doc_packs ADD COLUMN last_error TEXT;
ALTER TABLE doc_packs ADD COLUMN ref TEXT;           -- git tag or branch the docs were read at
ALTER TABLE doc_packs ADD COLUMN docs_version TEXT;  -- the docs version used, e.g. 0.77 for a 0.76 project
ALTER TABLE doc_packs ADD COLUMN repo TEXT;          -- owner/name of the docs repository

-- Vectors are searched per pack (partition key), so other projects' packs can
-- never crowd a project's own docs out of the nearest neighbours.
DROP TABLE doc_vec;
CREATE VIRTUAL TABLE doc_vec USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  pack_id   TEXT partition key,
  embedding float[768] distance_metric=cosine
);

-- A pack is shared by every project on that library version; whether it is
-- current is per project. An upgrade marks the old link 'stale' (T9).
CREATE TABLE project_doc_packs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pack_id    TEXT NOT NULL REFERENCES doc_packs(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale')),
  linked_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, pack_id)
);
CREATE INDEX project_doc_packs_pack ON project_doc_packs(pack_id);

-- Seeding (importing conventions from AGENTS.md, CLAUDE.md, ...) runs once per project.
ALTER TABLE projects ADD COLUMN seeded_at INTEGER;

-- A rebuilt or deleted pack leaves no rows in the "used" lists.
CREATE TRIGGER doc_chunks_ad_uses AFTER DELETE ON doc_chunks BEGIN
  DELETE FROM memory_uses WHERE ref_type = 'doc' AND ref_id = old.id;
END;
