-- Per-org datasets: look up by org instead of a single global row.
PRAGMA foreign_keys = ON;

ALTER TABLE datasets ADD COLUMN org TEXT;
UPDATE datasets SET org = 'filecoin-project' WHERE org IS NULL OR org = '';
CREATE INDEX IF NOT EXISTS idx_datasets_org ON datasets(org);
