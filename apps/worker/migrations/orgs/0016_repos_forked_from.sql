-- Add fork lineage to repos: records the source repo id "<org>/<repo>" when this repo was forked.
PRAGMA foreign_keys = ON;

ALTER TABLE repos ADD COLUMN forked_from TEXT;

-- Optional lookup index for fork ancestry queries
CREATE INDEX IF NOT EXISTS idx_repos_forked_from ON repos(forked_from);

