-- 0002_vectors: semantic search with sqlite-vec.
-- Requires the sqlite-vec extension to be loaded before migrating.
-- Dimension 768 = embeddinggemma. A model change re-indexes in the background
-- (see embedding_meta); retrieval falls back to FTS until it finishes.

CREATE TABLE embedding_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE memory_vec USING vec0(
  ref_key   TEXT PRIMARY KEY,   -- '<ref_type>:<ref_id>', e.g. 'memory:m1', 'episode:e1'
  embedding float[768] distance_metric=cosine
);

CREATE VIRTUAL TABLE doc_vec USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding float[768] distance_metric=cosine
);

-- Deletes must leave no trace in any index (acceptance test T7).
CREATE TRIGGER memories_ad_vec AFTER DELETE ON memories BEGIN
  DELETE FROM memory_vec WHERE ref_key = 'memory:' || old.id;
END;
CREATE TRIGGER episodes_ad_vec AFTER DELETE ON episodes BEGIN
  DELETE FROM memory_vec WHERE ref_key = 'episode:' || old.id;
END;
CREATE TRIGGER doc_chunks_ad_vec AFTER DELETE ON doc_chunks BEGIN
  DELETE FROM doc_vec WHERE chunk_id = old.id;
END;
