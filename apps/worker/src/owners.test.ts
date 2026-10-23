//! Owner permissions, delete confirm, protected repos, and merge gating.

import type { Actor } from "./authz";
import {
  ANDY_USER_ID,
  ANDY_USER_NAME,
  isLastOwner,
  isProtectedRepo,
  ownerMutateDenied,
  ownerJson,
  PROTECTED_REPOS,
  protectedDeleteDenied,
  validateAddOwner,
  validateDeleteConfirm,
} from "./owners";
import {
  commentResolveDenied,
  MERGE_REASON_OWNER_APPROVAL,
  mergeabilityJson,
  mergeBlockReasons,
  mergeReasonUnresolved,
  validateCommentResolve,
} from "./pulls";

const owner: Actor = { userId: "u-owner", name: "ada", admin: false };
const other: Actor = { userId: "u-other", name: "bob", admin: false };
const admin: Actor = { userId: "u-admin", name: "root", admin: true };

if (ANDY_USER_ID !== "0ae8965c-8dad-4b1b-a2ea-87d106161ee0") {
  throw new Error("andy user id must match the migration backfill");
}
if (ANDY_USER_NAME !== "andy") {
  throw new Error("andy user name must match the migration backfill");
}
if (!PROTECTED_REPOS.includes("filecoin-project/curio") || !PROTECTED_REPOS.includes("filecoin-project/lotus")) {
  throw new Error("curio and lotus must be protected");
}
if (!isProtectedRepo("filecoin-project", "curio") || !isProtectedRepo("filecoin-project", "lotus")) {
  throw new Error("platform Filecoin repos must be protected");
}
if (isProtectedRepo("alice", "curio") || isProtectedRepo("filecoin-project", "other")) {
  throw new Error("protection must be exact org/repo");
}

if (ownerMutateDenied(null, true) !== 401) {
  throw new Error("anonymous owner mutate must be 401");
}
if (ownerMutateDenied(other, false) !== 403) {
  throw new Error("non-owner mutate must be 403");
}
if (ownerMutateDenied(owner, true) !== null) {
  throw new Error("owner must be allowed to mutate owners");
}
if (ownerMutateDenied(admin, false) !== null) {
  throw new Error("site admin must be allowed to mutate owners");
}

if (protectedDeleteDenied("alice", "demo", other) !== null) {
  throw new Error("unprotected repos are not blocked by the protected-repo rule");
}
if (protectedDeleteDenied("filecoin-project", "curio", owner) !== 403) {
  throw new Error("non-admin must not delete curio");
}
if (protectedDeleteDenied("filecoin-project", "lotus", other) !== 403) {
  throw new Error("non-admin must not delete lotus");
}
if (protectedDeleteDenied("filecoin-project", "curio", admin) !== 403) {
  throw new Error("site admin must not delete curio");
}
if (protectedDeleteDenied("filecoin-project", "lotus", admin) !== 403) {
  throw new Error("site admin must not delete lotus");
}

const confirmOk = validateDeleteConfirm({ confirm: "alice/demo" }, "alice", "demo");
if (!confirmOk.ok) throw new Error("matching confirm must pass");
if (validateDeleteConfirm({ confirm: "alice/other" }, "alice", "demo").ok) {
  throw new Error("mismatched confirm must fail");
}
if (validateDeleteConfirm({ confirm: "Alice/demo" }, "alice", "demo").ok) {
  throw new Error("confirm must match org/repo exactly, including case");
}
if (validateDeleteConfirm({ confirm: " alice/demo " }, "alice", "demo").ok) {
  throw new Error("confirm must not trim; it must match exactly");
}
if (validateDeleteConfirm({}, "alice", "demo").ok) {
  throw new Error("missing confirm must fail");
}
if (validateDeleteConfirm(null, "alice", "demo").ok) {
  throw new Error("null body must fail");
}
if (validateDeleteConfirm({ confirm: 1 }, "alice", "demo").ok) {
  throw new Error("non-string confirm must fail");
}

if (!isLastOwner(1, true)) throw new Error("sole owner must be last");
if (isLastOwner(2, true)) throw new Error("two owners are not last");
if (isLastOwner(1, false)) throw new Error("removing a non-owner is not last-owner");

const addOk = validateAddOwner({ username: "bob" });
if (!addOk.ok || addOk.username !== "bob") throw new Error("username body must parse");
if (validateAddOwner({ username: "  " }).ok) throw new Error("blank username must fail");
if (validateAddOwner({ user: "bob" }).ok) throw new Error("user instead of username must fail");

const listed = ownerJson({
  org: "alice",
  repo: "demo",
  user_id: "u1",
  user_name: "ada",
  added_by: "ada",
  created_at: 1,
});
if (listed.user !== "ada" || listed.added_by !== "ada" || listed.created_at !== 1) {
  throw new Error("owner list JSON must expose user, added_by, created_at");
}

if (commentResolveDenied(null, owner.userId, owner.userId) !== 401) {
  throw new Error("anonymous comment resolve must be 401");
}
if (commentResolveDenied(other, owner.userId, "u-pr") !== 403) {
  throw new Error("bystander must not resolve a comment");
}
if (commentResolveDenied(admin, owner.userId, "u-pr") !== 403) {
  throw new Error("site admin who is neither comment nor PR author must not resolve");
}
if (commentResolveDenied(owner, owner.userId, "u-pr") !== null) {
  throw new Error("comment author must be allowed to resolve");
}
const prAuthor: Actor = { userId: "u-pr", name: "cara", admin: false };
if (commentResolveDenied(prAuthor, owner.userId, prAuthor.userId) !== null) {
  throw new Error("PR author must be allowed to resolve");
}

const resolveOk = validateCommentResolve({ resolved: true });
if (!resolveOk.ok || resolveOk.resolved !== true) throw new Error("resolved true must parse");
if (!validateCommentResolve({ resolved: false }).ok) throw new Error("resolved false must parse");
if (validateCommentResolve({ resolved: "yes" }).ok) throw new Error("string resolved must fail");
if (validateCommentResolve({}).ok) throw new Error("missing resolved must fail");

const noApproval = mergeBlockReasons({ ownerApprovals: 0, unresolvedComments: 0 });
if (!noApproval.includes(MERGE_REASON_OWNER_APPROVAL) || noApproval.length !== 1) {
  throw new Error("zero owner approvals must block merge");
}
const unresolved = mergeBlockReasons({ ownerApprovals: 1, unresolvedComments: 2 });
if (!unresolved.includes(mergeReasonUnresolved(2))) {
  throw new Error("unresolved comments must block merge");
}
const both = mergeBlockReasons({ ownerApprovals: 0, unresolvedComments: 1 });
if (both.length !== 2 || !both.includes(mergeReasonUnresolved(1))) {
  throw new Error("both gates must produce readable reasons");
}
const open = mergeabilityJson({ ownerApprovals: 1, unresolvedComments: 0 });
if (!open.mergeable || open.reasons.length !== 0 || open.ownerApprovals !== 1) {
  throw new Error("owner approval and zero unresolved comments must be mergeable");
}
const closed = mergeabilityJson({ ownerApprovals: 0, unresolvedComments: 3 });
if (closed.mergeable || closed.unresolvedComments !== 3) {
  throw new Error("mergeability JSON must surface counts and mergeable=false");
}

const nonOwnerApproval = mergeBlockReasons({ ownerApprovals: 0, unresolvedComments: 0 });
if (!nonOwnerApproval.includes(MERGE_REASON_OWNER_APPROVAL)) {
  throw new Error("non-owner approvals must not count toward the owner-approval gate");
}
