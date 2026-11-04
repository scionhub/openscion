-- Shared vs own Filecoin datasets. New orgs default to the platform dataset
-- (filecoin-project / on-chain 46121). `mode = own` is an admin-recorded
-- intent; the on-chain dataset is created lazily on the next add-pieces.
-- `dataset_usage` tracks approximate padded bundle bytes actually added.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS org_datasets (
  org TEXT PRIMARY KEY,
  dataset_org TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shared', 'own')),
  reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_usage (
  dataset_org TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
