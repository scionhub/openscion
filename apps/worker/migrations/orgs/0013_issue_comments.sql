-- Comments on issues. Any authenticated user may post; only the comment
-- author (or a site admin) may edit or delete.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS issue_comments (
  id             TEXT PRIMARY KEY,
  org            TEXT NOT NULL,
  repo           TEXT NOT NULL,
  number         INTEGER NOT NULL,
  author_user_id TEXT NOT NULL,
  author         TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue
  ON issue_comments(org, repo, number, created_at);
