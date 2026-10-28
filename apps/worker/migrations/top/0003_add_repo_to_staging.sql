-- Add repo_id to staging_meta for per-repo mapping
ALTER TABLE staging_meta ADD COLUMN repo_id TEXT;

