-- Public profile tagline and paid-user repo quota flag.
PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN tagline TEXT;
ALTER TABLE users ADD COLUMN paid INTEGER NOT NULL DEFAULT 0;
