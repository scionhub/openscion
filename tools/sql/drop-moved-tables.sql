-- Manual later step: drop tables that moved from scionhub-top to scionbase-orgs.
-- Do NOT place this file under apps/worker/migrations/top — Wrangler would
-- auto-apply it on the next `d1 migrations apply`.
--
-- Run only after:
--   1. scionbase-orgs exists and migrations are applied
--   2. tools/move-to-orgs-db.sh copied the rows and counts matched
--   3. the Worker is deployed with ORGS_DB bound
--   4. catalog / PR / dataset reads are verified against the new DB
--
-- Identity tables stay: users, tokens, orgs, org_members, memberships,
-- signup_attempts.
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS uploads;
DROP TABLE IF EXISTS pieces;
DROP TABLE IF EXISTS datasets;
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS pulls;
DROP TABLE IF EXISTS repos;

PRAGMA foreign_keys = ON;
