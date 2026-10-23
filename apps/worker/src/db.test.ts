//! Bindings, fallback, and the split of identity vs repo-scoped tables.

import {
  dbOrgs,
  dbTop,
  mergeAuthorNames,
  orgFromRepoId,
  ORGS_TABLES,
  TOP_TABLES,
} from "./db";

const top = { kind: "top" } as unknown as D1Database;
const orgs = { kind: "orgs" } as unknown as D1Database;

if (dbTop({ DB_SCIONHUB_TOP: top }) !== top) {
  throw new Error("dbTop must return DB_SCIONHUB_TOP");
}

try {
  dbTop({});
  throw new Error("dbTop must throw when the top binding is missing");
} catch (e) {
  if ((e as Error).message !== "no D1 binding DB_SCIONHUB_TOP") throw e;
}

if (dbOrgs({ DB_SCIONHUB_TOP: top, ORGS_DB: orgs }) !== orgs) {
  throw new Error("dbOrgs must prefer ORGS_DB when it is bound");
}

if (dbOrgs({ DB_SCIONHUB_TOP: top }) !== top) {
  throw new Error("dbOrgs must fall back to top when ORGS_DB is undefined");
}

try {
  dbOrgs({});
  throw new Error("dbOrgs must throw when neither binding is present");
} catch (e) {
  if ((e as Error).message !== "no D1 binding DB_SCIONHUB_TOP") throw e;
}

if (orgFromRepoId("filecoin-project/lotus") !== "filecoin-project") {
  throw new Error("orgFromRepoId must split on the first slash");
}
if (orgFromRepoId("alice") !== "alice") {
  throw new Error("orgFromRepoId must return the id when it has no slash");
}

const merged = mergeAuthorNames(
  [
    { author_user_id: "u1", title: "one" },
    { author_user_id: "u2", title: "two" },
    { author_user_id: "missing", title: "three" },
  ],
  [
    { id: "u1", name: "alice" },
    { id: "u2", name: "bob" },
  ]
);
if (merged[0]?.author_name !== "alice" || merged[1]?.author_name !== "bob") {
  throw new Error("mergeAuthorNames must attach names from a separate users query");
}
if (merged[2]?.author_name !== undefined) {
  throw new Error("mergeAuthorNames must leave unknown authors unnamed");
}

const topSet = new Set<string>(TOP_TABLES);
const orgsSet = new Set<string>(ORGS_TABLES);
for (const name of ["users", "tokens", "orgs", "org_members", "memberships", "signup_attempts"]) {
  if (!topSet.has(name)) throw new Error(`${name} must stay on top D1`);
  if (orgsSet.has(name)) throw new Error(`${name} must not move to ORGS_DB`);
}
for (const name of [
  "repos",
  "pulls",
  "pr_comments",
  "pr_approvals",
  "datasets",
  "org_datasets",
  "dataset_usage",
  "providers",
  "pieces",
  "uploads",
]) {
  if (!orgsSet.has(name)) throw new Error(`${name} must live on ORGS_DB`);
  if (topSet.has(name)) throw new Error(`${name} must not stay on top D1`);
}
for (const name of TOP_TABLES) {
  if (orgsSet.has(name)) throw new Error(`${name} cannot be in both D1s`);
}
