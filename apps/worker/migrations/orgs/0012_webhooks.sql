-- Per-repo outbound webhooks: URL + secret + subscribed event types.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS webhooks (
  id         TEXT PRIMARY KEY,
  org        TEXT NOT NULL,
  repo       TEXT NOT NULL,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,
  events     TEXT NOT NULL, -- JSON array of strings
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_repo ON webhooks(org, repo);

