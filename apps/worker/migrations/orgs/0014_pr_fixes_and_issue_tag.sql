-- PR fixes array and issue tag field
PRAGMA foreign_keys = ON;

-- Add JSON-encoded fixes list on pulls (array of integers as TEXT).
ALTER TABLE pulls ADD COLUMN fixes TEXT;
CREATE INDEX IF NOT EXISTS idx_pulls_repo_number ON pulls(org, repo, number);

-- Add optional tag on issues.
ALTER TABLE issues ADD COLUMN tag TEXT;
CREATE INDEX IF NOT EXISTS idx_issues_repo_tag ON issues(org, repo, tag);

