-- Cross-repo index of registered bundle PieceCIDs. Populated when a RepoDO
-- records a bundle-map. Used on delete to skip pieces another repo still
-- references. No backfill: existing curio/lotus (and other pre-migration)
-- bundles are absent until they are registered again.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bundle_refs (
  bundle_cid TEXT NOT NULL,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bundle_cid, org, repo)
);
CREATE INDEX IF NOT EXISTS idx_bundle_refs_repo ON bundle_refs(org, repo);
CREATE INDEX IF NOT EXISTS idx_bundle_refs_cid ON bundle_refs(bundle_cid);
