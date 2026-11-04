-- Issues and a shared per-repo number counter used by both issues and pulls.
PRAGMA foreign_keys = ON;

-- Monotonically increasing counter per repo. Allocators must update atomically
-- (UPDATE ... SET next = next + 1 RETURNING).
CREATE TABLE IF NOT EXISTS repo_counters (
  org   TEXT NOT NULL,
  repo  TEXT NOT NULL,
  next  INTEGER NOT NULL,
  PRIMARY KEY (org, repo)
);
CREATE INDEX IF NOT EXISTS idx_repo_counters_org_repo ON repo_counters(org, repo);

-- Minimal issues table. Labels and assignees are JSON-encoded string arrays.
CREATE TABLE IF NOT EXISTS issues (
  id             TEXT PRIMARY KEY,
  org            TEXT NOT NULL,
  repo           TEXT NOT NULL,
  number         INTEGER NOT NULL,
  author_user_id TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'open', -- open|closed
  labels         TEXT,                         -- JSON array of strings
  assignees      TEXT,                         -- JSON array of strings
  created_at     INTEGER NOT NULL,
  closed_at      INTEGER,
  UNIQUE(org, repo, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(org, repo, number);
CREATE INDEX IF NOT EXISTS idx_issues_author ON issues(author_user_id);

