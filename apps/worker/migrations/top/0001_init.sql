-- Top-level D1 schema: users, tokens, orgs, memberships, repo registry,
-- and (POC carry-over) providers/datasets/pieces/object_locations/staging/uploads.
PRAGMA foreign_keys = ON;

-- Auth and registry
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS org_members (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  can_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id)
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at INTEGER NOT NULL
);

-- Providers/datasets (kept in top DB for POC continuity)
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

-- Pieces and object locations (POC continuity; to be moved to RepoDO later)
CREATE TABLE IF NOT EXISTS pieces (
  piece_cid TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  size_bytes INTEGER,
  provider_id TEXT REFERENCES providers(id),
  status TEXT NOT NULL DEFAULT 'registered',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS object_locations (
  object_id TEXT PRIMARY KEY,
  piece_cid TEXT NOT NULL REFERENCES pieces(piece_cid) ON DELETE CASCADE,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  provider_id TEXT REFERENCES providers(id),
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

-- Durable staging (POC continuity)
CREATE TABLE IF NOT EXISTS staging_meta (
  object_id TEXT PRIMARY KEY,
  total_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_objects (
  object_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(object_id, chunk_index),
  FOREIGN KEY(object_id) REFERENCES staging_meta(object_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pieces_dataset ON pieces(dataset_id);
CREATE INDEX IF NOT EXISTS idx_uploads_piece ON uploads(piece_cid);
CREATE INDEX IF NOT EXISTS idx_objloc_piece ON object_locations(piece_cid);
CREATE INDEX IF NOT EXISTS idx_objloc_provider ON object_locations(provider_id);
CREATE INDEX IF NOT EXISTS idx_staging_created ON staging_meta(created_at);

