-- Pieces whose removal was scheduled on-chain. Excluded from dataset usage
-- recomputes so the counter drops once, idempotently (INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS piece_removals (
  dataset_org TEXT NOT NULL,
  piece_id INTEGER NOT NULL,
  piece_cid TEXT NOT NULL,
  padded_bytes INTEGER NOT NULL,
  tx TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (dataset_org, piece_id)
);
