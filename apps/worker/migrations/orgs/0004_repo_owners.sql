-- Per-repo owners. Names are stored at write time so list endpoints do not
-- join TOP.users. Andy is backfilled as owner of the two platform repos.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repo_owners (
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org, repo, user_id)
);
CREATE INDEX IF NOT EXISTS idx_repo_owners_repo ON repo_owners(org, repo);
CREATE INDEX IF NOT EXISTS idx_repo_owners_user ON repo_owners(user_id);

INSERT OR IGNORE INTO repo_owners (org, repo, user_id, user_name, added_by, created_at)
VALUES
  (
    'filecoin-project',
    'curio',
    '0ae8965c-8dad-4b1b-a2ea-87d106161ee0',
    'andy',
    'andy',
    strftime('%s','now') * 1000
  ),
  (
    'filecoin-project',
    'lotus',
    '0ae8965c-8dad-4b1b-a2ea-87d106161ee0',
    'andy',
    'andy',
    strftime('%s','now') * 1000
  );
