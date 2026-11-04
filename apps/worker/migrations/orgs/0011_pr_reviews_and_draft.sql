-- Review states beyond binary approve, and PR draft flag.
PRAGMA foreign_keys = ON;

-- Review events: approved | changes_requested | commented
CREATE TABLE IF NOT EXISTS pr_reviews (
  id         TEXT PRIMARY KEY,
  org        TEXT NOT NULL,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  user_id    TEXT NOT NULL,
  user_name  TEXT NOT NULL,
  state      TEXT NOT NULL,
  body       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_repo ON pr_reviews(org, repo, number, user_id, created_at);

-- Draft flag on pulls; default false.
ALTER TABLE pulls ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;

