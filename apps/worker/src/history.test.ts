//! Log walk, blame, and unified diff. Payloads must not carry PieceCIDs.

import { blameLines, diffLines, publicCommit, showDiff, unifiedDiff, versionsForPath, walkLog, asCommit, type HistoryCommit } from "./history";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const blob1 = "1".repeat(64);
const blob2 = "2".repeat(64);
const blob3 = "3".repeat(64);

const commits: HistoryCommit[] = [
  { id: a, parents: [], author: "ada", message: "init readme", created_at: 1_000, changes: [{ op: "upsert", path: "README.md", blob: blob1 }] },
  { id: b, parents: [a], author: "ada", message: "add src", created_at: 2_000, changes: [{ op: "upsert", path: "src/main.rs", blob: blob2 }] },
  { id: c, parents: [b], author: "grace", message: "fix parser", created_at: 3_000, changes: [{ op: "upsert", path: "README.md", blob: blob3 }] },
];

const page = walkLog(commits, c, { limit: 2 });
ok(page.commits.length === 2 && page.commits[0]!.id === c, "newest first");
ok(page.next_cursor === page.commits[1]!.id, "cursor is the last id");
const rest = walkLog(commits, c, { limit: 2, cursor: page.next_cursor! });
ok(rest.commits.length === 1 && rest.commits[0]!.id === a && rest.next_cursor === null, "second page");

const readme = walkLog(commits, c, { limit: 20, path: "README.md" });
ok(readme.commits.map((row) => row.id).join() === [c, a].join(), "path filter");
const byAuthor = walkLog(commits, c, { limit: 20, author: "GRA" });
ok(byAuthor.commits.length === 1 && byAuthor.commits[0]!.id === c, "author filter");
const grepped = walkLog(commits, c, { limit: 20, grep: "parser" });
ok(grepped.commits.length === 1 && grepped.commits[0]!.id === c, "grep");
const windowed = walkLog(commits, c, { limit: 20, since: 1500, until: 2500 });
ok(windowed.commits.length === 1 && windowed.commits[0]!.id === b, "since/until");

const pub = publicCommit(commits[0]!);
ok(!("metadata" in pub) && !JSON.stringify(pub).includes("pcid") && !JSON.stringify(pub).includes("piece"), "log rows omit piece cids");

const parsed = asCommit({ id: a, changeset: { parents: [], changes: [{ op: "upsert", path: "f", blob: blob1 }], author: "a", message: "m", created_at: 1, metadata: { "pcid:f": "bafy" } } });
ok(parsed && !JSON.stringify(publicCommit(parsed)).includes("bafy"), "metadata pcid is dropped");

const versions = versionsForPath(commits, "README.md", { [blob1]: "one\n", [blob3]: "one\ntwo\n" });
const lines = blameLines(versions);
ok(lines.length === 2, "two lines");
ok(lines[0]!.changeset === a && lines[0]!.text === "one", "unchanged line stays with the first commit");
ok(lines[1]!.changeset === c && lines[1]!.text === "two", "new line is the later commit");

const diff = unifiedDiff("README.md", "one\n", "one\ntwo\n");
ok(diff.includes("@@ ") && diff.includes("+two") && diff.includes("a/README.md") && diff.includes("b/README.md"), "unified hunk");
ok(diffLines(["a"], ["a", "b"]).some((edit) => edit.op === "ins"), "insert");

const shown = showDiff(commits, commits[2]!, { [blob1]: "one\n", [blob3]: "one\ntwo\n" });
ok(shown.includes("+two") && !shown.includes("bafy"), "show diff has no piece cid");

console.log("history ok");
