ALTER TABLE pieces ADD COLUMN object_id TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_pieces_object ON pieces(object_id);
