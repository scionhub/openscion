-- Issue boards owned by one org; issues may come from any org/repo.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS boards (
  id           TEXT PRIMARY KEY,
  org          TEXT NOT NULL,                 -- owner org (where the board is listed)
  name         TEXT NOT NULL,
  tag_filter   TEXT,                          -- null = all tags
  state_filter TEXT NOT NULL DEFAULT 'open',  -- open|closed|all
  sources      TEXT,                          -- JSON allowlist: [{org, repo?}] ; null/[] = all visible
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(org, name)
);
CREATE INDEX IF NOT EXISTS idx_boards_org ON boards(org, name);
