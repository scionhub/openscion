-- Durable staging for unsealed objects (persisted in D1)
PRAGMA foreign_keys = ON;

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

CREATE INDEX IF NOT EXISTS idx_staging_created ON staging_meta(created_at);

