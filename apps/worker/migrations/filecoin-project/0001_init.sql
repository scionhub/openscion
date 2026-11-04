-- D1 schema for the filecoin-project org (one DB per org)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint_url TEXT,
  region TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pieces (
  piece_cid TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  size_bytes INTEGER,
  provider_id TEXT REFERENCES providers(id),
  status TEXT NOT NULL DEFAULT 'registered',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  piece_cid TEXT REFERENCES pieces(piece_cid) ON DELETE SET NULL,
  source TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pieces_dataset ON pieces(dataset_id);
CREATE INDEX IF NOT EXISTS idx_uploads_piece ON uploads(piece_cid);
