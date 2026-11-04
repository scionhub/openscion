-- Thread resolution on pull-request comments. Unresolved comments block merge.
PRAGMA foreign_keys = ON;

ALTER TABLE pr_comments ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pr_comments ADD COLUMN resolved_by TEXT;
ALTER TABLE pr_comments ADD COLUMN resolved_at INTEGER;
