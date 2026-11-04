-- User-created repositories: track owner for the non-admin quota.
PRAGMA foreign_keys = ON;

ALTER TABLE repos ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_repos_created_by ON repos(created_by);
