import { parseCiConfig, parseYamlSubset, labelsMatch, capLog, failingRequiredChecks, LOG_MAX } from "./ci";
import { applySettingsPatch, DEFAULT_SETTINGS } from "./settings";
import { mergeBlockReasons } from "./pulls";
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const y = `# CI for curio
jobs:
  vet:
    runs-on: [linux, x64]
    timeout: 300
    steps:
      - name: vet paths
        run: go vet ./lib/paths/...
  fails:
    runs-on: linux
    steps:
      - name: multi
        run: |
          echo "about to fail" # keep
          exit 3
      - run: echo unreachable
`;
const p = parseCiConfig(y);
ok(p.ok, "parse " + JSON.stringify(p));
if (p.ok) {
  ok(p.jobs.length === 2, "2 jobs");
  ok(JSON.stringify(p.jobs[0]!.runsOn) === '["linux","x64"]' && p.jobs[0]!.timeout === 300, "vet");
  ok(p.jobs[0]!.steps[0]!.run === "go vet ./lib/paths/...", "run");
  ok(p.jobs[1]!.steps[0]!.run === 'echo "about to fail" # keep\nexit 3\n', "block " + JSON.stringify(p.jobs[1]!.steps[0]!.run));
  ok(p.jobs[1]!.steps[1]!.name === "step 2" && p.jobs[1]!.timeout === 600, "defaults");
  ok(JSON.stringify(p.jobs[1]!.runsOn) === '["linux"]', "string runs-on");
}
ok(!parseCiConfig("nope: 1").ok, "needs jobs");
ok(!parseCiConfig("jobs:\n  bad name:\n    steps:\n      - run: x\n").ok, "bad name");
ok(!parseCiConfig("jobs:\n  a:\n    steps: []\n").ok, "no steps");
ok(parseCiConfig('{"jobs":{"a":{"runs-on":[],"steps":[{"run":"true"}]}}}').ok, "json");
ok(JSON.stringify(parseYamlSubset("a:\n- 1\n- x: 2\n  y: 'q'\n")) === '{"a":[1,{"x":2,"y":"q"}]}', "list at key indent");
ok(labelsMatch(["linux", "X64"], ["x64"]) && labelsMatch(["a"], []) && !labelsMatch(["linux"], ["mac"]), "labels");
const big = "x".repeat(LOG_MAX + 10);
ok(capLog(big).length === LOG_MAX && capLog(big).startsWith("[log truncated"), "cap");
ok(JSON.stringify(failingRequiredChecks(["a", "b", "c"], [{ name: "a", state: "success" }, { name: "b", state: "failure" }])) === '["b","c"]', "required");
const s = applySettingsPatch({ ...DEFAULT_SETTINGS }, { requiredChecks: ["vet", "vet", "lint"] });
ok(s.ok && s.settings.requiredChecks.join() === "vet,lint", "settings checks");
ok(!applySettingsPatch(DEFAULT_SETTINGS, { requiredChecks: ["bad name"] }).ok, "bad check name");
ok(mergeBlockReasons({ ownerApprovals: 1, unresolvedComments: 0, checkReasons: ["required check vet is failure"] }).length === 1, "gate");
console.log("ci ok");
