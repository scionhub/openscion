//! GET /v1/orgs: caller memberships vs anonymous public catalog.

import { callerOrgIds, publicOrgIds, PUBLIC_DIRECTORY_ORGS } from "./orgs";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

ok(PUBLIC_DIRECTORY_ORGS.includes("filecoin-project"), "filecoin-project is public");

const authed = callerOrgIds("alice", ["my-org", "filecoin-project"]);
ok(authed[0] === "alice", "username namespace is first");
ok(authed.includes("my-org") && authed.includes("filecoin-project"), "memberships");
ok(callerOrgIds("alice", ["alice", "my-org"])[0] === "alice", "username not duplicated");
ok(JSON.stringify(callerOrgIds("alice", [])) === JSON.stringify(["alice"]), "username only");

const anon = publicOrgIds(
  ["filecoin-project", "alice", "my-org"],
  ["alice", "bob"]
);
ok(anon.includes("filecoin-project"), "anon keeps filecoin-project");
ok(anon.includes("my-org"), "anon keeps formal orgs");
ok(!anon.includes("alice") && !anon.includes("bob"), "anon omits username namespaces");
ok(JSON.stringify(publicOrgIds([], [])) === JSON.stringify(["filecoin-project"]), "anon always has filecoin-project");

console.log("orgs ok");
