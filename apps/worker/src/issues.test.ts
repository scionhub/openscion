//! Issue title/body and comment author checks.

import type { Actor } from "./authz";
import {
  issueCommentMutateDenied,
  issueEditDenied,
  validateIssueCommentBody,
} from "./issues";

const author: Actor = { userId: "u-author", name: "ada", admin: false };
const other: Actor = { userId: "u-other", name: "bob", admin: false };
const owner: Actor = { userId: "u-owner", name: "cara", admin: false };
const admin: Actor = { userId: "u-admin", name: "root", admin: true };

if (issueEditDenied(null, author.userId) !== 401) {
  throw new Error("anonymous issue PATCH must be 401");
}
if (issueEditDenied(other, author.userId) !== 403) {
  throw new Error("non-author issue PATCH must be 403");
}
if (issueEditDenied(owner, author.userId) !== 403) {
  throw new Error("repo owner who is not the author must not PATCH title/body");
}
if (issueEditDenied(author, author.userId) !== null) {
  throw new Error("issue author must be allowed to PATCH");
}
if (issueEditDenied(admin, author.userId) !== null) {
  throw new Error("site admin may override issue title/body");
}

if (issueCommentMutateDenied(null, author.userId) !== 401) {
  throw new Error("anonymous comment mutate must be 401");
}
if (issueCommentMutateDenied(other, author.userId) !== 403) {
  throw new Error("non-author comment mutate must be 403");
}
if (issueCommentMutateDenied(author, author.userId) !== null) {
  throw new Error("comment author must be allowed to edit/delete");
}
if (issueCommentMutateDenied(admin, author.userId) !== null) {
  throw new Error("site admin may override comment edit/delete");
}

if (validateIssueCommentBody(null).ok) throw new Error("null comment body must fail");
if (validateIssueCommentBody({}).ok) throw new Error("missing body must fail");
if (validateIssueCommentBody({ body: "" }).ok) throw new Error("empty body must fail");
const ok = validateIssueCommentBody({ body: "looks good" });
if (!ok.ok || ok.body !== "looks good") throw new Error("valid comment body must pass");
const tooLong = validateIssueCommentBody({ body: "x".repeat(10_001) });
if (tooLong.ok) throw new Error("oversize comment body must fail");
