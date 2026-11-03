//! Commit status validation and the merge gate for required contexts.

import { STATUS_DDL, failingStatusContexts, statusReason, validateStatusBody } from "./statuses";
import { mergeBlockReasons } from "./pulls";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

ok(!STATUS_DDL.toLowerCase().includes("piece"), "status table does not store piece cids");
ok(STATUS_DDL.includes("changeset"), "status table keys a changeset id");

const good = validateStatusBody({ state: "success", context: "ci/test", target_url: "https://ci.example/1" });
ok(good.ok && good.state === "success", "accepts success");
ok(!validateStatusBody({ state: "error", context: "ci" }).ok, "rejects unknown state");
ok(!validateStatusBody({ state: "pending", context: "has space" }).ok, "rejects bad context");
ok(!validateStatusBody({ state: "failure", context: "ci", target_url: "ftp://x" }).ok, "rejects non-http url");

const missing = failingStatusContexts(["ci", "lint"], [{ context: "ci", state: "success" }]);
ok(missing.length === 1 && missing[0] === "lint", "missing context fails");
ok(failingStatusContexts(["ci"], [{ context: "ci", state: "pending" }]).length === 1, "pending is not green");
ok(failingStatusContexts(["ci"], [{ context: "ci", state: "success" }]).length === 0, "success is green");
ok(statusReason("ci", undefined).includes("missing"), "missing reason");
ok(statusReason("ci", "failure").includes("failure"), "failure reason");

const blocked = mergeBlockReasons({
  ownerApprovals: 1,
  unresolvedComments: 0,
  requiredApprovals: 1,
  approvalSatisfied: true,
  statusReasons: ["required status ci is pending"],
});
ok(blocked.some((reason) => reason.includes("required status ci")), "status blocks merge beside approvals");
const clear = mergeBlockReasons({
  ownerApprovals: 1,
  unresolvedComments: 0,
  requiredApprovals: 1,
  approvalSatisfied: true,
  statusReasons: [],
});
ok(clear.length === 0, "green statuses do not block");

console.log("statuses ok");
