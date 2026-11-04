-- Commit statuses and webhook delivery log.
-- Changeset ids are blake3 object ids. This migration does not store PieceCIDs.
CREATE TABLE IF NOT EXISTS commit_statuses (
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  changeset TEXT NOT NULL,
  context TEXT NOT NULL,
  state TEXT NOT NULL,
  target_url TEXT,
  description TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org, repo, changeset, context)
);
CREATE INDEX IF NOT EXISTS idx_commit_statuses_cs ON commit_statuses(org, repo, changeset);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  event TEXT NOT NULL,
  status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(hook_id, created_at);

ALTER TABLE repo_settings ADD COLUMN required_status_contexts TEXT NOT NULL DEFAULT '[]';
