//! CODEOWNERS parse, match, nested rules, and approval coverage.

import {
  candidateCodeownersPaths,
  codeownersDirPrefix,
  evaluateApprovalGate,
  isCodeownerForChanges,
  normalizeOwner,
  ownersForPath,
  parseCodeowners,
  pathMatchesPattern,
  requiredOwnerSets,
  sortCodeownersSources,
} from "./codeowners";

const ok = (c: unknown, m: string) => {
  if (!c) throw new Error(m);
};

ok(normalizeOwner("@Andy") === "andy" && normalizeOwner("bob") === "bob", "normalize owner");

const root = parseCodeowners(
  `# default
* @alice
*.rs @rust
/docs/ @docs
src/lib.rs @lib
`,
  "CODEOWNERS"
);
ok(root.length === 4, "parse skips comments and keeps rules");
ok(ownersForPath("README.md", root).join() === "alice", "star default");
ok(ownersForPath("src/main.rs", root).join() === "rust", "last glob wins over star");
ok(ownersForPath("docs/guide.md", root).join() === "docs", "anchored docs dir");
ok(ownersForPath("src/lib.rs", root).join() === "lib", "last exact path wins");

ok(pathMatchesPattern("pkg/foo.js", "*.js"), "*.js matches nested");
ok(!pathMatchesPattern("pkg/foo.ts", "*.js"), "*.js misses ts");
ok(pathMatchesPattern("docs/a.md", "/docs/"), "/docs/ is directory-scoped");
ok(!pathMatchesPattern("other/docs/a.md", "/docs/"), "anchored /docs/ does not match nested");

const nested = parseCodeowners("*.rs @bob\n", "src/CODEOWNERS");
ok(codeownersDirPrefix("src/CODEOWNERS") === "src/", "nested prefix");
ok(ownersForPath("src/foo.rs", nested).join() === "bob", "nested applies under src/");
ok(ownersForPath("other/foo.rs", nested).length === 0, "nested does not apply outside");

const combined = [
  ...parseCodeowners("* @alice\n", "CODEOWNERS"),
  ...parseCodeowners("*.rs @bob\n", "src/CODEOWNERS"),
];
ok(ownersForPath("README.md", combined).join() === "alice", "root still owns unmatched");
ok(ownersForPath("src/lib.rs", combined).join() === "bob", "nested last-match overrides");

const paths = candidateCodeownersPaths(["src/foo/bar.rs", "docs/a.md"]);
ok(paths.includes("CODEOWNERS") && paths.includes(".github/CODEOWNERS"), "github roots");
ok(paths.includes("src/CODEOWNERS") && paths.includes("src/foo/CODEOWNERS"), "ancestors");
ok(sortCodeownersSources(["src/CODEOWNERS", "CODEOWNERS", ".github/CODEOWNERS"])[0] === ".github/CODEOWNERS", "github order");

const sets = requiredOwnerSets(["src/lib.rs", "README.md"], combined);
ok(sets.length === 2, "two owner sets");

const covered = evaluateApprovalGate({
  changedPaths: ["src/lib.rs", "README.md"],
  rules: combined,
  approverLogins: ["alice", "bob"],
  collaboratorLogins: ["alice", "bob", "cara"],
  requiredApprovals: 1,
});
ok(covered.satisfied && covered.mode === "codeowners", "both sets covered");

const one = evaluateApprovalGate({
  changedPaths: ["src/lib.rs", "README.md"],
  rules: combined,
  approverLogins: ["alice"],
  collaboratorLogins: ["alice", "bob"],
  requiredApprovals: 1,
});
ok(!one.satisfied && (one.reason ?? "").includes("@bob"), "missing bob");

const sameOwner = evaluateApprovalGate({
  changedPaths: ["a.rs", "b.rs"],
  rules: parseCodeowners("*.rs @bob\n", "CODEOWNERS"),
  approverLogins: ["bob"],
  collaboratorLogins: ["bob"],
  requiredApprovals: 1,
});
ok(sameOwner.satisfied, "one approval covers every path in the same set");

const fallback = evaluateApprovalGate({
  changedPaths: ["README.md"],
  rules: [],
  approverLogins: ["cara"],
  collaboratorLogins: ["cara", "alice"],
  requiredApprovals: 1,
});
ok(fallback.satisfied && fallback.mode === "fallback", "no CODEOWNERS: collaborator approval");

const outsider = evaluateApprovalGate({
  changedPaths: ["README.md"],
  rules: [],
  approverLogins: ["eve"],
  collaboratorLogins: ["cara"],
  requiredApprovals: 1,
});
ok(!outsider.satisfied, "non-collaborator approval does not count in fallback");

const noApprovals = evaluateApprovalGate({
  changedPaths: ["README.md"],
  rules: [],
  approverLogins: [],
  collaboratorLogins: ["cara"],
  requiredApprovals: 1,
});
ok(!noApprovals.satisfied && (noApprovals.reason ?? "").includes("approval is required"), "fallback reason");

ok(isCodeownerForChanges("bob", ["src/lib.rs"], combined), "bob owns src");
ok(!isCodeownerForChanges("bob", ["README.md"], combined), "bob does not own readme");
ok(isCodeownerForChanges("@Alice", ["README.md"], combined), "@Alice matches alice");

console.log("codeowners ok");
