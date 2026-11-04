-- Self-serve signup (optional email, abuse counters) and pull requests.
PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN email TEXT;

CREATE TABLE IF NOT EXISTS signup_attempts (
  ip TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_ip_time
  ON signup_attempts(ip, attempted_at);

CREATE TABLE IF NOT EXISTS pulls (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  head_ref TEXT NOT NULL,
  head_target TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  merged_by TEXT,
  merged_at INTEGER,
  UNIQUE(org, repo, number)
);
CREATE INDEX IF NOT EXISTS idx_pulls_repo ON pulls(org, repo, number);
CREATE INDEX IF NOT EXISTS idx_pulls_author ON pulls(author_user_id);
