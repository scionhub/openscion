-- Migration 0002: seed orgs and memberships; add filecoin-project and owner membership for user andy.
PRAGMA foreign_keys = ON;

-- Create orgs table if missing
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Create memberships table if missing (per-org membership)
CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- member|owner
  can_write INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(org_id, user_id)
);

-- Seed the filecoin-project org (idempotent)
INSERT OR IGNORE INTO orgs (id, created_at) VALUES ('filecoin-project', CAST(strftime('%s','now') AS INTEGER) * 1000);

-- Seed andy (existing) as owner with write access in filecoin-project (idempotent)
INSERT OR IGNORE INTO memberships (org_id, user_id, role, can_write, created_at)
SELECT 'filecoin-project', '0ae8965c-8dad-4b1b-a2ea-87d106161ee0', 'owner', 1, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM users WHERE id = '0ae8965c-8dad-4b1b-a2ea-87d106161ee0');

