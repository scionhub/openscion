-- Shared org D1 (scionbase-orgs): repo, PR, dataset, and storage metadata
-- for every org. Identity (users/tokens/orgs/memberships/signup) stays on
-- scionhub-top. Column order matches the live top schema after migrations
-- 0001–0008 plus the runtime datasets.onchain_id ALTER, so a data-only
-- export can be imported with named INSERT lists (see tools/move-to-orgs-db.sh).
-- `org` is stored and indexed on every org-scoped table.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at INTEGER NOT NULL,
  created_by TEXT,
  org TEXT
);
CREATE INDEX IF NOT EXISTS idx_repos_created_by ON repos(created_by);
CREATE INDEX IF NOT EXISTS idx_repos_org ON repos(org);
CREATE INDEX IF NOT EXISTS idx_repos_org_name ON repos(org, name);

CREATE TABLE IF NOT EXISTS pulls (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  author_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  head_ref TEXT NOT NULL,
  head_target TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  merged_by TEXT,
  merged_at INTEGER,
  UNIQUE(org, repo, number)
);
CREATE INDEX IF NOT EXISTS idx_pulls_repo ON pulls(org, repo, number);
CREATE INDEX IF NOT EXISTS idx_pulls_author ON pulls(author_user_id);
CREATE INDEX IF NOT EXISTS idx_pulls_org ON pulls(org);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint_url TEXT,
  region TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  org TEXT
);
CREATE INDEX IF NOT EXISTS idx_providers_org ON providers(org);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  org TEXT,
  onchain_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_datasets_org ON datasets(org);

CREATE TABLE IF NOT EXISTS pieces (
  piece_cid TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  size_bytes INTEGER,
  provider_id TEXT REFERENCES providers(id),
  status TEXT NOT NULL DEFAULT 'registered',
  created_at INTEGER NOT NULL,
  org TEXT
);
CREATE INDEX IF NOT EXISTS idx_pieces_dataset ON pieces(dataset_id);
CREATE INDEX IF NOT EXISTS idx_pieces_org ON pieces(org);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  piece_cid TEXT REFERENCES pieces(piece_cid) ON DELETE SET NULL,
  source TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at INTEGER NOT NULL,
  org TEXT
);
CREATE INDEX IF NOT EXISTS idx_uploads_piece ON uploads(piece_cid);
CREATE INDEX IF NOT EXISTS idx_uploads_org ON uploads(org);
