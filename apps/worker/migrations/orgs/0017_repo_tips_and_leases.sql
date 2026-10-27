-- Last-known engine tip (watermark) and a short-lived write lease per repo.
-- Used to refuse writes against a stale RepoDO snapshot (H2) and to serialize
-- ref persist / PR merge across Worker isolates. Not a full hydrate redesign.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repo_tips (
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  target TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org, repo, ref_name)
);
CREATE INDEX IF NOT EXISTS idx_repo_tips_org_repo ON repo_tips(org, repo);

CREATE TABLE IF NOT EXISTS repo_leases (
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  holder TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  PRIMARY KEY (org, repo)
);
