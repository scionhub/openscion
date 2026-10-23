-- Pull-request review: conversation/inline comments and per-user approvals.
-- Author names are stored at write time so list endpoints do not join TOP.users.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pr_comments (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  path TEXT,
  line INTEGER,
  side TEXT,
  author_user_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_comments_pull ON pr_comments(org, repo, number);

CREATE TABLE IF NOT EXISTS pr_approvals (
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org, repo, number, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_approvals_pull ON pr_approvals(org, repo, number);
