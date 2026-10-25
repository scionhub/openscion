-- ScionBase-native CI: check runs and registered runners, per-changeset scans.
CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  changeset TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', -- queued|running|success|failure|error|cancelled
  summary TEXT,
  log TEXT,
  log_bytes INTEGER NOT NULL DEFAULT 0,
  target_url TEXT,
  ref_name TEXT,
  job_spec TEXT, -- JSON when the run is enqueued by the platform (docker tests)
  runs_on TEXT,  -- JSON array of labels
  source TEXT NOT NULL DEFAULT 'docker', -- docker|report
  runner_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  reported_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (org, repo, changeset, name)
);
CREATE INDEX IF NOT EXISTS check_runs_queue ON check_runs (org, repo, state, created_at);

CREATE TABLE IF NOT EXISTS ci_runners (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  labels TEXT NOT NULL, -- JSON array
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS ci_runners_repo ON ci_runners (org, repo);

CREATE TABLE IF NOT EXISTS ci_scans (
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  changeset TEXT NOT NULL,
  status TEXT NOT NULL, -- queued|none|invalid
  detail TEXT,
  scanned_at INTEGER NOT NULL,
  PRIMARY KEY (org, repo, changeset)
);

ALTER TABLE repo_settings ADD COLUMN required_checks TEXT NOT NULL DEFAULT '[]';
