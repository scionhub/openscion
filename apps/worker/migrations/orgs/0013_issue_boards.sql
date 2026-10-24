-- Issue boards (per repo) with optional tag filter
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  org         TEXT NOT NULL,
  repo        TEXT NOT NULL,
  name        TEXT NOT NULL,
  tag_filter  TEXT,                 -- null = all tags, else filter by tag
  state_filter TEXT NOT NULL DEFAULT 'open', -- open|closed|all (default open)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(org, repo, name)
);
CREATE INDEX IF NOT EXISTS idx_boards_repo ON boards(org, repo, name);

