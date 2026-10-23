//! Permission checks, comment validation, and compare status mapping.

import type { Actor } from "./authz";
import {
  commentDeleteDenied,
  commentResolveDenied,
  mapCompareFileStatus,
  mergeabilityJson,
  mergeBlockReasons,
  MERGE_REASON_OWNER_APPROVAL,
  pullApproveDenied,
  pullEditDenied,
  remapCompareBody,
  validateCommentInput,
  validateCommentResolve,
  validatePullPatch,
} from "./pulls";

const author: Actor = { userId: "u-author", name: "ada", admin: false };
const other: Actor = { userId: "u-other", name: "bob", admin: false };
const admin: Actor = { userId: "u-admin", name: "root", admin: true };

if (mapCompareFileStatus("deleted") !== "removed") {
  throw new Error("deleted file status must map to removed");
}
if (mapCompareFileStatus("added") !== "added" || mapCompareFileStatus("modified") !== "modified") {
  throw new Error("added and modified statuses must be unchanged");
}
if (mapCompareFileStatus("removed") !== "removed") {
  throw new Error("removed must pass through");
}

const remapped = remapCompareBody({
  status: "changed",
  files: [
    { path: "a.txt", status: "added" },
    { path: "b.txt", status: "modified" },
    { path: "c.txt", status: "deleted" },
  ],
}) as { files: { path: string; status: string }[] };
if (remapped.files[0]?.status !== "added") throw new Error("added must stay added");
if (remapped.files[1]?.status !== "modified") throw new Error("modified must stay modified");
if (remapped.files[2]?.status !== "removed") throw new Error("deleted must become removed");

if (pullEditDenied(null, author.userId) !== 401) {
  throw new Error("anonymous PATCH must be 401");
}
if (pullEditDenied(other, author.userId) !== 403) {
  throw new Error("non-author PATCH must be 403");
}
if (pullEditDenied(admin, author.userId) !== 403) {
  throw new Error("admin who is not the author must not PATCH the PR");
}
if (pullEditDenied(author, author.userId) !== null) {
  throw new Error("author must be allowed to PATCH");
}

if (commentDeleteDenied(null, author.userId) !== 401) {
  throw new Error("anonymous comment delete must be 401");
}
if (commentDeleteDenied(other, author.userId) !== 403) {
  throw new Error("non-author comment delete must be 403");
}
if (commentDeleteDenied(author, author.userId) !== null) {
  throw new Error("comment author must be allowed to delete");
}
if (commentDeleteDenied(admin, author.userId) !== null) {
  throw new Error("site admin must be allowed to delete a comment");
}

if (pullApproveDenied(null, author.userId) !== 401) {
  throw new Error("anonymous approve must be 401");
}
if (pullApproveDenied(author, author.userId) !== 403) {
  throw new Error("PR author must not approve their own pull");
}
if (pullApproveDenied(other, author.userId) !== null) {
  throw new Error("a different user must be allowed to approve");
}

const patchOk = validatePullPatch({ title: "new title" });
if (!patchOk.ok || patchOk.value.title !== "new title") {
  throw new Error("PATCH title must be accepted");
}
const patchEmpty = validatePullPatch({});
if (patchEmpty.ok) throw new Error("PATCH with neither title nor body must fail");
const patchLong = validatePullPatch({ title: "x".repeat(121) });
if (patchLong.ok) throw new Error("PATCH title over 120 chars must fail");

const commentOk = validateCommentInput({ body: "looks good", path: "src/a.ts", line: 3, side: "new" });
if (!commentOk.ok || commentOk.value.side !== "new" || commentOk.value.line !== 3) {
  throw new Error("inline comment input must parse");
}
const general = validateCommentInput({ body: "general note" });
if (!general.ok || general.value.path !== null || general.value.line !== null) {
  throw new Error("general comments must allow null path and line");
}
if (validateCommentInput({ body: "x".repeat(10_001) }).ok) {
  throw new Error("comment body over 10k must fail");
}
if (validateCommentInput({ body: "ok", line: 1.5 }).ok) {
  throw new Error("non-integer line must fail");
}
if (validateCommentInput({ body: "ok", path: 12 }).ok) {
  throw new Error("numeric path must fail");
}
if (validateCommentInput({ body: "ok", side: "both" }).ok) {
  throw new Error("side other than old|new must fail");
}
if (validateCommentInput({ body: 1 }).ok) {
  throw new Error("non-string body must fail");
}

if (commentResolveDenied(null, author.userId, author.userId) !== 401) {
  throw new Error("anonymous resolve must be 401");
}
if (commentResolveDenied(author, other.userId, author.userId) !== null) {
  throw new Error("PR author must be allowed to resolve a comment they did not write");
}
if (commentResolveDenied(other, other.userId, author.userId) !== null) {
  throw new Error("comment author must be allowed to resolve");
}
if (commentResolveDenied(admin, other.userId, author.userId) !== 403) {
  throw new Error("admin who is not comment or PR author must not resolve");
}
if (!validateCommentResolve({ resolved: true }).ok) {
  throw new Error("resolved bool must parse");
}

if (mergeBlockReasons({ ownerApprovals: 1, unresolvedComments: 0 }).length !== 0) {
  throw new Error("satisfied gates must not block");
}
if (!mergeBlockReasons({ ownerApprovals: 0, unresolvedComments: 0 }).includes(MERGE_REASON_OWNER_APPROVAL)) {
  throw new Error("merge without an owner approval must be blocked");
}
const blocked = mergeabilityJson({ ownerApprovals: 0, unresolvedComments: 1 });
if (blocked.mergeable || blocked.reasons.length !== 2) {
  throw new Error("mergeability must list every blocking reason");
}
