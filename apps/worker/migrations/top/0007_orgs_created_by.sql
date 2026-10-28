-- Track who created each org so we can enforce a per-user cap.
PRAGMA foreign_keys = ON;

ALTER TABLE orgs ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_orgs_created_by ON orgs(created_by);
