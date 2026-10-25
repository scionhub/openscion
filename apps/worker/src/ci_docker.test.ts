import { capLog, labelsMatch, failingRequiredChecks, parseNeedsText } from "./ci";

const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

ok(labelsMatch(["linux", "X64"], ["x64"]), "labels match");
ok(labelsMatch(["a"], []), "empty runs-on ok");
ok(!labelsMatch(["linux"], ["mac"]), "labels no match");

const big = "x".repeat(1_000_010);
ok(capLog(big).length === 1_000_000 && capLog(big).startsWith("[log truncated"), "cap");

ok(JSON.stringify(failingRequiredChecks(["a", "b", "c"], [{ name: "a", state: "success" }, { name: "b", state: "failure" }])) === '["b","c"]', "required");

// needs parsing
const needsText = `
# comment
docker:build
docker:base
docker:..      # invalid
docker:bad/name
docker:
`;
const parsed = parseNeedsText(needsText);
ok(parsed.length === 2 && parsed[0] === "build" && parsed[1] === "base", "parse needs");

console.log("ci_docker ok");
