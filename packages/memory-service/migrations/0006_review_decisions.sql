-- 0006_review_decisions: what the user did with each proposal in the review
-- inbox, for the precision shown in the app (accepted / all decided).
-- Kept separately from the memories, which can later be edited or deleted.

CREATE TABLE review_decisions (
  id           INTEGER PRIMARY KEY,
  -- 1: proposed from a session (the extraction job); 0: imported from a project file.
  from_session INTEGER NOT NULL CHECK (from_session IN (0, 1)),
  outcome      TEXT NOT NULL CHECK (outcome IN ('accepted', 'edited', 'rejected')),
  at           INTEGER NOT NULL
);
CREATE INDEX review_decisions_at ON review_decisions(at);
