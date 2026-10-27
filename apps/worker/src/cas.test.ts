//! CAS planners: persist tip, stale-DO watermark, last-owner SQL, PR state.

import {
  CLOSE_ISSUE_SQL,
  CLOSE_PULL_SQL,
  DELETE_MEMBER_SQL,
  DELETE_REPO_OWNER_SQL,
  DEMOTE_OWNER_SQL,
  findSnapshotRef,
  isDoTipStale,
  MERGE_PULL_SQL,
  parseRefExpected,
  planRefPersist,
  refAliases,
  REOPEN_ISSUE_SQL,
  staleSnapshotRefs,
} from "./cas";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

const a = "aa".repeat(32);
const b = "bb".repeat(32);

ok(planRefPersist(null, { name: "main", target: a, version: 1 }).sql === "insert", "create with no expected");
ok(planRefPersist(null, { name: "main", target: a, version: 1, expected: null }).sql === "insert", "create expected null");
ok(
  planRefPersist(null, { name: "main", target: a, version: 2, expected: a }).action === "conflict",
  "create must not apply when expected a prior tip"
);

ok(
  planRefPersist({ name: "main", target: a, version: 1 }, { name: "main", target: a, version: 1 }).sql === "noop",
  "same target is idempotent"
);
ok(
  planRefPersist({ name: "main", target: a, version: 1 }, { name: "main", target: b, version: 2, expected: a }).sql ===
    "update",
  "CAS hits when expected matches"
);
ok(
  planRefPersist({ name: "main", target: b, version: 2 }, { name: "main", target: a, version: 2, expected: a }).action ===
    "conflict",
  "CAS misses when expected is stale"
);
ok(
  planRefPersist({ name: "main", target: a, version: 1 }, { name: "main", target: b, version: 2 }).sql === "update",
  "omitted expected uses version predecessor"
);
ok(
  planRefPersist({ name: "main", target: a, version: 3 }, { name: "main", target: b, version: 2 }).action === "conflict",
  "older version must not clobber"
);

ok(!isDoTipStale(null, { target: a, version: 1 }), "no watermark is not stale");
ok(isDoTipStale({ target: b, version: 2 }, { target: a, version: 1 }), "D1 ahead of DO");
ok(!isDoTipStale({ target: a, version: 1 }, { target: a, version: 1 }), "matching tip");
ok(isDoTipStale({ target: a, version: 1 }, null), "DO missing a recorded tip");
ok(isDoTipStale({ target: a, version: 2 }, { target: b, version: 2 }), "same version different target");
ok(!isDoTipStale({ target: a, version: 1 }, { target: b, version: 2 }), "DO ahead of watermark");

ok(refAliases("main").includes("refs/heads/main"), "short name aliases heads/");
ok(refAliases("refs/heads/main").includes("main"), "heads/ aliases short name");
ok(findSnapshotRef([{ name: "refs/heads/main", target: a, version: 3 }], "main")?.version === 3, "alias match");

const stale = staleSnapshotRefs(
  [{ ref_name: "main", target: b, version: 4 }],
  [{ name: "main", target: a, version: 2 }]
);
ok(stale.includes("main"), "snapshot behind watermark");
ok(staleSnapshotRefs([{ ref_name: "main", target: a, version: 2 }], [{ name: "main", target: a, version: 2 }]).length === 0, "in sync");

ok(parseRefExpected({ expected: a, new: b }) === a, "expected string");
ok(parseRefExpected({ expected: null, new: b }) === null, "expected null");
ok(parseRefExpected({ new: b }) === undefined, "omitted expected");

ok(CLOSE_PULL_SQL.includes("state = 'open'"), "close is conditional");
ok(MERGE_PULL_SQL.includes("state = 'open'"), "merge is conditional");
ok(CLOSE_ISSUE_SQL.includes("state = 'open'"), "issue close is conditional");
ok(REOPEN_ISSUE_SQL.includes("state = 'closed'"), "issue reopen is conditional");
ok(DEMOTE_OWNER_SQL.includes("COUNT(*)"), "demote encodes last-owner");
ok(DELETE_MEMBER_SQL.includes("role != 'owner'"), "delete allows non-owners");
ok(DELETE_MEMBER_SQL.includes("COUNT(*)"), "delete encodes last-owner");
ok(DELETE_REPO_OWNER_SQL.includes("COUNT(*)"), "repo owner delete encodes last-owner");

console.log("cas ok");
