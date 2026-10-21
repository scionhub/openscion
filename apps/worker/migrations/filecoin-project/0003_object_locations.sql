-- Map BLAKE3 ObjectId -> (PieceCID, offset, length, provider)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS object_locations (
  object_id TEXT PRIMARY KEY,
  piece_cid TEXT NOT NULL REFERENCES pieces(piece_cid) ON DELETE CASCADE,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  provider_id TEXT REFERENCES providers(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_objloc_piece ON object_locations(piece_cid);
CREATE INDEX IF NOT EXISTS idx_objloc_provider ON object_locations(provider_id);

