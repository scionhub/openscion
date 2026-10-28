//! RepoDO storage rules: one location per member COMMP, tip+tree SQL.

import { relocateBundleMember, REPO_DO_PATH_RE, TIP_TREE_SQL } from "./repo";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

const first = { bundleCid: "bundle-a", pieceCid: "pcid-1", offset: 0, length: 8 };
const moved = { bundleCid: "bundle-b", pieceCid: "pcid-1", offset: 16, length: 8 };
const other = { bundleCid: "bundle-a", pieceCid: "pcid-2", offset: 8, length: 4 };

const afterMove = relocateBundleMember([first, other], moved);
ok(afterMove.length === 2, "relocate keeps other pieces");
ok(
  afterMove.filter((row) => row.pieceCid === "pcid-1").length === 1,
  "each pieceCID occupies one bundle_members row"
);
ok(
  afterMove.find((row) => row.pieceCid === "pcid-1")?.bundleCid === "bundle-b",
  "relocate points at the new bundle"
);
ok(afterMove.some((row) => row.pieceCid === "pcid-2"), "unrelated member stays");

ok(TIP_TREE_SQL.includes("COALESCE(r.root_tree, c.root_tree)"), "tip query uses stored tree");
ok(TIP_TREE_SQL.includes("WHERE r.name = ?"), "tip query is a ref primary-key lookup");
ok(!TIP_TREE_SQL.toLowerCase().includes("order by lsn"), "tip query does not walk the log");

ok(REPO_DO_PATH_RE.test("/__internal/do/andy/demo/sqlite-migrate"), "sqlite-migrate is a RepoDO area");
ok(REPO_DO_PATH_RE.test("/__internal/do/andy/demo/sqlite-stats"), "sqlite-stats is a RepoDO area");
ok(REPO_DO_PATH_RE.test("/__internal/do/andy/demo/reset"), "reset still matches");
ok(!REPO_DO_PATH_RE.test("/__internal/do/andy/demo/unknown"), "unknown area is rejected");

console.log("repo storage ok");
