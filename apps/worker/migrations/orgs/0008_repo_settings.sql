-- Per-repo settings. protect_main: refuse direct pushes to refs/heads/main.
-- required_approvals: owner approvals needed to merge (always >= 1).
CREATE TABLE IF NOT EXISTS repo_settings (
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  protect_main INTEGER NOT NULL DEFAULT 0,
  required_approvals INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org, repo)
);
