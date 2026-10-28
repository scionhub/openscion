// ScionBase-native CI: `.scionbase/ci.yml` jobs become queued check runs on a
// changeset; registered runners long-poll for them over outbound HTTPS, and any
// script can report a result with an owner or runner token.
import { d1All, d1Run, dbOrgs } from "./db";
import { loadActor, sha256Hex, type Actor } from "./authz";
import { isRepoOwner } from "./owners";
import { engineFetch } from "./pulls";
import { getRepoSettings, CHECK_NAME_RE } from "./settings";
import { emitEvent } from "./webhooks";

type Env = Parameters<typeof engineFetch>[0];

export const CHECK_STATES = ["queued", "running", "success", "failure", "error", "cancelled"] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export const FINAL_STATES = new Set<string>(["success", "failure", "error", "cancelled"]);
export const LOG_MAX = 1_000_000;
export const CI_PATH = ".scionbase/ci.yml";
const MAX_JOBS = 20;
const MAX_STEPS = 50;
const DEFAULT_TIMEOUT = 600;
const MAX_TIMEOUT = 3600;
const POLL_MAX_MS = 25_000;
const POLL_STEP_MS = 2_000;

export type CiStep = { name: string; run: string };
export type CiJob = { name: string; runsOn: string[]; steps: CiStep[]; timeout: number };

// ---------- tiny YAML subset ----------

function indentOf(l: string): number {
  return l.length - l.trimStart().length;
}
function isBlank(l: string): boolean {
  const t = l.trim();
  return t === "" || t.startsWith("#");
}
function stripComment(s: string): string {
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0]!;
    const end = s.indexOf(q, 1);
    return end > 0 ? s.slice(0, end + 1) : s;
  }
  return s.replace(/\s+#.*$/, "");
}
function unquote(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.length >= 2 ? s.slice(1, -1) : s;
  }
  return s;
}
function scalar(raw: string): unknown {
  const s = stripComment(raw.trim());
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => scalar(x)) : [];
  }
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~" || s === "") return null;
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return Number(s);
  return s;
}
const KEY_RE = /^("[^"]*"|'[^']*'|[^:"'[\]{}#][^:]*?)\s*:(?:\s+(.*)|)$/;

/** Parses the small YAML subset ci.yml uses (maps, lists, flow lists, `|` blocks). JSON also works. */
export function parseYamlSubset(src: string): unknown {
  if (src.trim().startsWith("{")) return JSON.parse(src);
  const raw = src.replace(/\t/g, "  ").split(/\r?\n/);
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`${CI_PATH} line ${i + 1}: ${msg}`);
  };
  const skip = () => {
    while (i < raw.length && isBlank(raw[i]!)) i++;
  };
  const isItem = (t: string) => t === "-" || t.startsWith("- ");

  function block(minIndent: number): unknown {
    skip();
    if (i >= raw.length) return null;
    const ind = indentOf(raw[i]!);
    if (ind < minIndent) return null;
    return isItem(raw[i]!.trim()) ? list(ind) : map(ind);
  }
  function blockScalar(ind: number, style: string): string {
    const lines: string[] = [];
    let base = -1;
    while (i < raw.length) {
      const l = raw[i]!;
      if (l.trim() === "") {
        lines.push("");
        i++;
        continue;
      }
      const li = indentOf(l);
      if (li <= ind) break;
      if (base < 0) base = li;
      lines.push(l.slice(Math.min(base, li)));
      i++;
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (style.startsWith(">")) return lines.join(" ");
    return lines.join("\n") + (style === "|-" ? "" : "\n");
  }
  function afterKey(rest: string, ind: number): unknown {
    const r = stripComment(rest).trim();
    if (/^[|>][-+]?$/.test(r)) return blockScalar(ind, r);
    if (r === "") {
      skip();
      if (i < raw.length) {
        const li = indentOf(raw[i]!);
        if (li > ind) return block(li);
        if (li === ind && isItem(raw[i]!.trim())) return list(ind);
      }
      return null;
    }
    return scalar(r);
  }
  function map(ind: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (;;) {
      skip();
      if (i >= raw.length) break;
      const l = raw[i]!;
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) fail("unexpected indentation");
      const t = l.trim();
      if (isItem(t)) break;
      const m = t.match(KEY_RE);
      if (!m) fail("expected `key: value`");
      const key = unquote(m![1]!);
      i++;
      obj[key] = afterKey(m![2] ?? "", ind);
    }
    return obj;
  }
  function list(ind: number): unknown[] {
    const arr: unknown[] = [];
    for (;;) {
      skip();
      if (i >= raw.length) break;
      const l = raw[i]!;
      const li = indentOf(l);
      const t = l.trim();
      if (li !== ind || !isItem(t)) break;
      const after = t.slice(1);
      const rest = after.trimStart();
      if (rest === "" || rest.startsWith("#")) {
        i++;
        arr.push(block(ind + 1));
        continue;
      }
      if (KEY_RE.test(stripComment(rest)) || /^[^:"'[]+:\s*[|>]/.test(rest)) {
        const childInd = li + 1 + (after.length - rest.length);
        raw[i] = " ".repeat(childInd) + rest;
        arr.push(map(childInd));
        continue;
      }
      arr.push(scalar(rest));
      i++;
    }
    return arr;
  }
  const out = block(0);
  skip();
  if (i < raw.length) fail("could not parse");
  return out;
}

/** Validates a parsed ci.yml into jobs. */
export function parseCiConfig(src: string): { ok: true; jobs: CiJob[] } | { ok: false; error: string } {
  let doc: unknown;
  try {
    doc = parseYamlSubset(src);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const jobsRaw = (doc as { jobs?: unknown } | null)?.jobs;
  if (!jobsRaw || typeof jobsRaw !== "object" || Array.isArray(jobsRaw)) {
    return { ok: false, error: "ci.yml needs a top-level `jobs:` map" };
  }
  const entries = Object.entries(jobsRaw as Record<string, unknown>);
  if (entries.length > MAX_JOBS) return { ok: false, error: `at most ${MAX_JOBS} jobs` };
  const jobs: CiJob[] = [];
  for (const [name, spec] of entries) {
    if (!CHECK_NAME_RE.test(name)) return { ok: false, error: `job name ${JSON.stringify(name)} must match [A-Za-z0-9_.-]{1,64}` };
    if (!spec || typeof spec !== "object") return { ok: false, error: `job ${name}: expected a map` };
    const s = spec as Record<string, unknown>;
    let runsOn = s["runs-on"] ?? s.runsOn ?? [];
    if (typeof runsOn === "string") runsOn = [runsOn];
    if (!Array.isArray(runsOn) || !runsOn.every((x) => typeof x === "string")) {
      return { ok: false, error: `job ${name}: runs-on must be a label or list of labels` };
    }
    const stepsRaw = s.steps;
    if (!Array.isArray(stepsRaw) || stepsRaw.length === 0 || stepsRaw.length > MAX_STEPS) {
      return { ok: false, error: `job ${name}: steps must be a list of 1..${MAX_STEPS} {name, run}` };
    }
    const steps: CiStep[] = [];
    for (const [k, st] of stepsRaw.entries()) {
      const o = (typeof st === "string" ? { run: st } : st) as Record<string, unknown> | null;
      const run = o?.run;
      if (typeof run !== "string" || !run.trim()) return { ok: false, error: `job ${name}: step ${k + 1} needs run` };
      steps.push({ name: typeof o?.name === "string" ? o.name : `step ${k + 1}`, run });
    }
    let timeout = Number(s.timeout ?? s["timeout-seconds"] ?? DEFAULT_TIMEOUT);
    if (!Number.isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT;
    jobs.push({ name, runsOn: runsOn as string[], steps, timeout: Math.min(Math.floor(timeout), MAX_TIMEOUT) });
  }
  return { ok: true, jobs };
}

/** A runner matches a job when it has every label the job asks for. */
export function labelsMatch(runnerLabels: string[], runsOn: string[]): boolean {
  const have = new Set(runnerLabels.map((l) => l.toLowerCase()));
  return runsOn.every((l) => have.has(l.toLowerCase()));
}

/** Keeps the last LOG_MAX characters, marking the cut. */
export function capLog(log: string): string {
  if (log.length <= LOG_MAX) return log;
  const marker = "[log truncated: showing the last 1 MB]\n";
  return marker + log.slice(log.length - (LOG_MAX - marker.length));
}

/** Names of required checks that are not `success` on the given runs. */
export function failingRequiredChecks(required: string[], runs: { name: string; state: string }[]): string[] {
  const byName = new Map(runs.map((r) => [r.name, r.state]));
  return required.filter((n) => byName.get(n) !== "success");
}

export function requiredCheckReason(name: string, state: string | undefined): string {
  return `required check ${name} is ${state ?? "missing"}`;
}

// ---------- storage ----------

type CheckRow = {
  id: string;
  org: string;
  repo: string;
  changeset: string;
  name: string;
  state: string;
  summary: string | null;
  log_bytes: number;
  target_url: string | null;
  ref_name: string | null;
  job_spec: string | null;
  runs_on: string | null;
  source: string;
  runner_id: string | null;
  attempt: number;
  reported_by: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};
const CHECK_COLS =
  "id, org, repo, changeset, name, state, summary, log_bytes, target_url, ref_name, job_spec, runs_on, source, runner_id, attempt, reported_by, created_at, updated_at, started_at, finished_at";

function checkJson(r: CheckRow, runnerNames: Map<string, string>) {
  const dur = r.started_at ? (r.finished_at ?? Date.now()) - r.started_at : null;
  return {
    id: r.id,
    name: r.name,
    changeset: r.changeset,
    state: r.state,
    summary: r.summary,
    target_url: r.target_url,
    ref: r.ref_name,
    source: r.source,
    runs_on: r.runs_on ? (JSON.parse(r.runs_on) as string[]) : [],
    runner: r.runner_id ? (runnerNames.get(r.runner_id) ?? r.runner_id) : null,
    attempt: r.attempt,
    reported_by: r.reported_by,
    log_bytes: r.log_bytes,
    created_at: r.created_at,
    updated_at: r.updated_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    duration_ms: dur,
    rerunnable: !!r.job_spec,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function runs(env: Env, org: string, repo: string, changeset: string): Promise<CheckRow[]> {
  return d1All<CheckRow>(
    dbOrgs(env),
    `SELECT ${CHECK_COLS} FROM check_runs WHERE org = ? AND repo = ? AND changeset = ? ORDER BY name`,
    [org, repo, changeset]
  );
}

/** Required checks failing on `changeset`, with readable reasons, for the merge gate. */
export async function requiredCheckReasons(env: Env, org: string, repo: string, changeset: string | null): Promise<string[]> {
  const { requiredChecks } = await getRepoSettings(env, org, repo);
  if (!requiredChecks.length) return [];
  if (!changeset) return requiredChecks.map((n) => requiredCheckReason(n, undefined));
  const rows = await runs(env, org, repo, changeset).catch(() => [] as CheckRow[]);
  const states = new Map(rows.map((r) => [r.name, r.state]));
  return failingRequiredChecks(requiredChecks, rows).map((n) => requiredCheckReason(n, states.get(n)));
}

async function refTarget(env: Env, origin: URL, org: string, repo: string, ref: string): Promise<string | null> {
  const r = await engineFetch(env, origin, `/v1/repos/${org}/${repo}/refs/${ref}`, { method: "GET" });
  if (!r.ok) return null;
  return ((await r.json()) as { target?: string }).target ?? null;
}

/** Reads `.scionbase/ci.yml` at a changeset: text, null when absent, or "retry" when not readable yet. */
async function readCiFile(env: Env, origin: URL, org: string, repo: string, cs: string): Promise<string | null | "retry"> {
  const r = await engineFetch(env, origin, `/v1/repos/${org}/${repo}/blob/${cs}?path=${encodeURIComponent(CI_PATH)}`, { method: "GET" });
  if (r.status === 404) return null;
  if (!r.ok) return "retry";
  const hint = (await r.json()) as { contentBase64?: string; url?: string; offset?: number; length?: number; size?: number };
  if (hint.contentBase64) return new TextDecoder().decode(Uint8Array.from(atob(hint.contentBase64), (c) => c.charCodeAt(0)));
  const len = hint.length ?? hint.size;
  if (!hint.url || hint.offset == null || len == null) return "retry";
  if (len > 256 * 1024) return null;
  if (len === 0) return "";
  const resp = await fetch(hint.url, { headers: { range: `bytes=${hint.offset}-${hint.offset + len - 1}` } });
  if (!resp.ok) return "retry";
  const buf = new Uint8Array(await resp.arrayBuffer());
  return new TextDecoder().decode(resp.status === 206 ? buf : buf.slice(hint.offset, hint.offset + len));
}

/** Enqueues ci.yml jobs at `cs` once; safe to call repeatedly. */
export async function ensureScanned(env: Env, origin: URL, org: string, repo: string, cs: string, refName: string | null): Promise<void> {
  const db = dbOrgs(env);
  const seen = await d1All<{ status: string }>(db, "SELECT status FROM ci_scans WHERE org = ? AND repo = ? AND changeset = ?", [org, repo, cs]);
  if (seen.length) return;
  const text = await readCiFile(env, origin, org, repo, cs).catch(() => "retry" as const);
  if (text === "retry") return;
  const now = Date.now();
  if (text === null) {
    await d1Run(db, "INSERT OR IGNORE INTO ci_scans (org, repo, changeset, status, scanned_at) VALUES (?, ?, ?, 'none', ?)", [org, repo, cs, now]);
    return;
  }
  const parsed = parseCiConfig(text);
  if (!parsed.ok) {
    await d1Run(db, "INSERT OR IGNORE INTO ci_scans (org, repo, changeset, status, detail, scanned_at) VALUES (?, ?, ?, 'invalid', ?, ?)", [org, repo, cs, parsed.error, now]);
    await d1Run(
      db,
      `INSERT OR IGNORE INTO check_runs (id, org, repo, changeset, name, state, summary, source, ref_name, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, 'ci.yml', 'error', ?, 'ci.yml', ?, ?, ?, ?)`,
      [crypto.randomUUID(), org, repo, cs, `invalid ${CI_PATH}: ${parsed.error}`, refName, now, now, now]
    );
    return;
  }
  for (const job of parsed.jobs) {
    await d1Run(
      db,
      `INSERT OR IGNORE INTO check_runs (id, org, repo, changeset, name, state, source, ref_name, job_spec, runs_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 'ci.yml', ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), org, repo, cs, job.name, refName, JSON.stringify(job), JSON.stringify(job.runsOn), now, now]
    );
  }
  await d1Run(db, "INSERT OR IGNORE INTO ci_scans (org, repo, changeset, status, scanned_at) VALUES (?, ?, ?, 'queued', ?)", [org, repo, cs, now]);
}

/** Scans main and the heads of open PRs (lazy enqueue on poll and list). */
export async function scanRepo(env: Env, origin: URL, org: string, repo: string): Promise<void> {
  const heads = new Map<string, string>();
  const main = await refTarget(env, origin, org, repo, "main").catch(() => null);
  if (main) heads.set(main, "refs/heads/main");
  const pulls = await d1All<{ head_ref: string }>(dbOrgs(env), "SELECT head_ref FROM pulls WHERE org = ? AND repo = ? AND state = 'open'", [org, repo]);
  for (const p of pulls) {
    const t = await refTarget(env, origin, org, repo, p.head_ref).catch(() => null);
    if (t && !heads.has(t)) heads.set(t, p.head_ref);
  }
  for (const [cs, ref] of heads) await ensureScanned(env, origin, org, repo, cs, ref).catch(() => undefined);
}

/** After a ref write: scan when it is main or the head of an open PR. */
export async function onRefWritten(env: Env, origin: URL, org: string, repo: string, refName: string): Promise<void> {
  const full = refName.startsWith("refs/") ? refName : `refs/heads/${refName}`;
  const isMain = full === "refs/heads/main";
  const prs = isMain
    ? []
    : await d1All<{ number: number }>(dbOrgs(env), "SELECT number FROM pulls WHERE org = ? AND repo = ? AND state = 'open' AND (head_ref = ? OR head_ref = ?)", [org, repo, full, refName]);
  if (!isMain && !prs.length) return;
  const t = await refTarget(env, origin, org, repo, full);
  if (t) await ensureScanned(env, origin, org, repo, t, full);
}

/** Running jobs whose runner stopped reporting past timeout + 2 min become errors. */
async function expireStale(env: Env, org: string, repo: string): Promise<void> {
  const db = dbOrgs(env);
  const rows = await d1All<{ id: string; job_spec: string | null; started_at: number | null; updated_at: number }>(
    db,
    "SELECT id, job_spec, started_at, updated_at FROM check_runs WHERE org = ? AND repo = ? AND state = 'running'",
    [org, repo]
  );
  const now = Date.now();
  for (const r of rows) {
    const timeout = r.job_spec ? ((JSON.parse(r.job_spec) as CiJob).timeout ?? DEFAULT_TIMEOUT) : DEFAULT_TIMEOUT;
    if (now - r.updated_at > (timeout + 120) * 1000) {
      await d1Run(db, "UPDATE check_runs SET state = 'error', summary = 'runner stopped reporting', finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'", [now, now, r.id]);
    }
  }
}

// ---------- auth ----------

type Runner = { id: string; org: string; repo: string; name: string; labels: string[] };

async function loadRunner(env: Env, request: Request): Promise<Runner | null> {
  const m = (request.headers.get("authorization") || "").match(/Bearer (scnr_[A-Za-z0-9]+)/);
  if (!m) return null;
  const rows = await d1All<{ id: string; org: string; repo: string; name: string; labels: string }>(
    dbOrgs(env),
    "SELECT id, org, repo, name, labels FROM ci_runners WHERE token_hash = ? LIMIT 1",
    [await sha256Hex(m[1]!)]
  );
  const r = rows[0];
  if (!r) return null;
  await d1Run(dbOrgs(env), "UPDATE ci_runners SET last_seen = ? WHERE id = ?", [Date.now(), r.id]);
  return { id: r.id, org: r.org, repo: r.repo, name: r.name, labels: JSON.parse(r.labels) as string[] };
}

async function ownerOrAdmin(env: Env, actor: Actor | null, org: string, repo: string): Promise<boolean> {
  return !!actor && (actor.admin || (await isRepoOwner(env, org, repo, actor.userId)));
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "scnr_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = await request.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function pullHead(env: Env, origin: URL, org: string, repo: string, n: number): Promise<{ cs: string | null; ref: string } | null> {
  const rows = await d1All<{ head_ref: string; head_target: string | null; state: string }>(
    dbOrgs(env),
    "SELECT head_ref, head_target, state FROM pulls WHERE org = ? AND repo = ? AND number = ?",
    [org, repo, n]
  );
  const p = rows[0];
  if (!p) return null;
  const live = p.state === "open" ? await refTarget(env, origin, org, repo, p.head_ref).catch(() => null) : null;
  return { cs: live ?? p.head_target ?? null, ref: p.head_ref };
}

const HEX64 = /^[0-9a-f]{64}$/;

// ---------- routes ----------

/** Handles /v1/repos/{o}/{r}/checks..., /v1/repos/{o}/{r}/runners..., /v1/runners/... ; null when not a CI route. */
export async function handleCi(request: Request, env: Env, path: string): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const origin = new URL(request.url);
  const db = dbOrgs(env);

  // ----- runner protocol -----
  if (path === "/v1/runners/poll" && method === "POST") {
    const runner = await loadRunner(env, request);
    if (!runner) return json({ error: "runner token required" }, 401);
    const body = await readBody(request);
    const waitMs = Math.min(Math.max(Number(body.wait_s ?? 20) * 1000, 0), POLL_MAX_MS);
    await expireStale(env, runner.org, runner.repo).catch(() => undefined);
    await scanRepo(env, origin, runner.org, runner.repo).catch(() => undefined);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const queued = await d1All<CheckRow>(
        db,
        `SELECT ${CHECK_COLS} FROM check_runs WHERE org = ? AND repo = ? AND state = 'queued' AND job_spec IS NOT NULL ORDER BY created_at LIMIT 50`,
        [runner.org, runner.repo]
      );
      for (const q of queued) {
        const job = JSON.parse(q.job_spec!) as CiJob;
        if (!labelsMatch(runner.labels, job.runsOn)) continue;
        const now = Date.now();
        const res = await db
          .prepare("UPDATE check_runs SET state = 'running', runner_id = ?, started_at = ?, finished_at = NULL, updated_at = ?, log = '', log_bytes = 0, summary = NULL WHERE id = ? AND state = 'queued'")
          .bind(runner.id, now, now, q.id)
          .run();
        if ((res.meta?.changes ?? 0) !== 1) continue;
        return json({
          job: { id: q.id, org: q.org, repo: q.repo, changeset: q.changeset, ref: q.ref_name, name: q.name, attempt: q.attempt, steps: job.steps, timeout: job.timeout, runs_on: job.runsOn },
        });
      }
      if (Date.now() + POLL_STEP_MS > deadline) return new Response(null, { status: 204 });
      await new Promise((r) => setTimeout(r, POLL_STEP_MS));
    }
  }
  const jobUpd = path.match(/^\/v1\/runners\/jobs\/([^/]+)$/);
  if (jobUpd && (method === "PATCH" || method === "POST")) {
    const runner = await loadRunner(env, request);
    if (!runner) return json({ error: "runner token required" }, 401);
    const id = decodeURIComponent(jobUpd[1]!);
    const rows = await d1All<{ state: string; runner_id: string | null; log: string | null; name: string | null }>(db, "SELECT state, runner_id, log, name FROM check_runs WHERE id = ?", [id]);
    const row = rows[0];
    if (!row) return json({ error: "not found" }, 404);
    if (row.runner_id !== runner.id) return json({ error: "job is not claimed by this runner" }, 403);
    if (row.state !== "running") return json({ state: row.state, cancelled: true });
    const b = await readBody(request);
    const log = capLog((row.log ?? "") + (typeof b.log_append === "string" ? b.log_append : ""));
    const now = Date.now();
    const state = typeof b.state === "string" ? b.state : "running";
    if (!CHECK_STATES.includes(state as CheckState) || state === "queued") return json({ error: "bad state" }, 400);
    const summary = typeof b.summary === "string" ? b.summary.slice(0, 2000) : null;
    await d1Run(
      db,
      `UPDATE check_runs SET log = ?, log_bytes = ?, state = ?, summary = COALESCE(?, summary), updated_at = ?,
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`,
      [log, log.length, state, summary, now, FINAL_STATES.has(state) ? 1 : 0, now, id]
    );
    if (FINAL_STATES.has(state)) {
      // Best-effort webhook
      (env as any).waitUntil?.(emitEvent(env as any, runner.org, runner.repo, "check_run", { action: "completed", id, name: rows[0]?.name, state }));
    }
    return json({ state, cancelled: false });
  }

  // ----- per-repo routes -----
  const m = path.match(/^\/v1\/repos\/([^/]+)\/([^/]+)\/(checks|runners)(?:\/(.+))?$/);
  if (!m) return null;
  const org = decodeURIComponent(m[1]!);
  const repo = decodeURIComponent(m[2]!);
  const kind = m[3]!;
  const rest = m[4] ? decodeURIComponent(m[4]) : "";

  if (kind === "runners") {
    const actor = await loadActor(env, request);
    if (!(await ownerOrAdmin(env, actor, org, repo))) return json({ error: "only repo owners can manage runners" }, actor ? 403 : 401);
    if (!rest && method === "GET") {
      const rows = await d1All<{ id: string; name: string; labels: string; created_by: string; created_at: number; last_seen: number | null }>(
        db,
        "SELECT id, name, labels, created_by, created_at, last_seen FROM ci_runners WHERE org = ? AND repo = ? ORDER BY created_at",
        [org, repo]
      );
      return json({ runners: rows.map((r) => ({ ...r, labels: JSON.parse(r.labels) as string[] })) });
    }
    if (!rest && method === "POST") {
      const b = await readBody(request);
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 64) : `runner-${Date.now().toString(36)}`;
      let labels = b.labels;
      if (typeof labels === "string") labels = labels.split(",");
      if (!Array.isArray(labels)) labels = [];
      const clean = [...new Set((labels as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_.-]{1,32}$/.test(x)))].slice(0, 20);
      const token = randomToken();
      const id = crypto.randomUUID();
      await d1Run(
        db,
        "INSERT INTO ci_runners (id, org, repo, name, labels, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, org, repo, name, JSON.stringify(clean), await sha256Hex(token), actor!.name, Date.now()]
      );
      return json({ id, name, labels: clean, token, note: "The token is shown once; store it like a password." }, 201);
    }
    if (rest && method === "DELETE") {
      await d1Run(db, "DELETE FROM ci_runners WHERE org = ? AND repo = ? AND (id = ? OR name = ?)", [org, repo, rest, rest]);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // checks
  if (!rest && method === "GET") {
    const url = new URL(request.url);
    let cs = url.searchParams.get("changeset");
    const pr = url.searchParams.get("pr");
    const ref = url.searchParams.get("ref");
    let refName: string | null = null;
    if (pr) {
      const h = await pullHead(env, origin, org, repo, Number(pr));
      if (!h) return json({ error: "no such pull request" }, 404);
      cs = h.cs;
      refName = h.ref;
    } else if (ref && !cs) {
      cs = await refTarget(env, origin, org, repo, ref);
      refName = ref;
    }
    if (!cs || !HEX64.test(cs)) return json({ error: "pass ?pr=N, ?ref=NAME or ?changeset=<64 hex>" }, 400);
    if (pr || refName === "main" || refName === "refs/heads/main") await ensureScanned(env, origin, org, repo, cs, refName).catch(() => undefined);
    await expireStale(env, org, repo).catch(() => undefined);
    const rows = await runs(env, org, repo, cs);
    const runnerRows = await d1All<{ id: string; name: string }>(db, "SELECT id, name FROM ci_runners WHERE org = ? AND repo = ?", [org, repo]);
    const names = new Map(runnerRows.map((r) => [r.id, r.name]));
    const scan = await d1All<{ status: string; detail: string | null }>(db, "SELECT status, detail FROM ci_scans WHERE org = ? AND repo = ? AND changeset = ?", [org, repo, cs]);
    const { requiredChecks } = await getRepoSettings(env, org, repo);
    return json({ changeset: cs, ci_yml: scan[0]?.status ?? "pending", checks: rows.map((r) => checkJson(r, names)), required: requiredChecks });
  }

  const logM = rest.match(/^([^/]+)\/log$/);
  if (logM && method === "GET") {
    const rows = await d1All<{ log: string | null; name: string; state: string }>(
      db,
      "SELECT log, name, state FROM check_runs WHERE org = ? AND repo = ? AND id = ?",
      [org, repo, logM[1]!]
    );
    if (!rows[0]) return json({ error: "not found" }, 404);
    return new Response(rows[0].log ?? "", { headers: { "content-type": "text/plain; charset=utf-8", "x-check-state": rows[0].state } });
  }

  // Writes: owner (or admin) user token, or a runner token registered on this repo.
  const actor = await loadActor(env, request);
  const runner = actor ? null : await loadRunner(env, request);
  const allowed = (runner && runner.org === org && runner.repo === repo) || (await ownerOrAdmin(env, actor, org, repo));
  if (!allowed) return json({ error: "an owner token or this repo's runner token is required" }, actor || runner ? 403 : 401);
  const who = actor ? actor.name : `runner:${runner!.name}`;
  const b = method === "GET" ? {} : await readBody(request);

  async function resolveCs(): Promise<{ cs: string; ref: string | null } | Response> {
    if (typeof b.changeset === "string" && HEX64.test(b.changeset)) return { cs: b.changeset, ref: typeof b.ref === "string" ? b.ref : null };
    if (b.pr != null) {
      const h = await pullHead(env, origin, org, repo, Number(b.pr));
      if (!h || !h.cs) return json({ error: "no such pull request" }, 404);
      return { cs: h.cs, ref: h.ref };
    }
    if (typeof b.ref === "string") {
      const t = await refTarget(env, origin, org, repo, b.ref);
      if (!t) return json({ error: "unknown ref" }, 404);
      return { cs: t, ref: b.ref };
    }
    return json({ error: "pass changeset, pr or ref" }, 400);
  }

  if (rest === "rerun" && method === "POST") {
    const name = typeof b.name === "string" ? b.name : "";
    const target = await resolveCs();
    if (target instanceof Response) return target;
    const rows = await d1All<{ id: string; job_spec: string | null; state: string }>(
      db,
      "SELECT id, job_spec, state FROM check_runs WHERE org = ? AND repo = ? AND changeset = ? AND name = ?",
      [org, repo, target.cs, name]
    );
    const row = rows[0];
    if (!row) return json({ error: `no check named ${name} on that changeset` }, 404);
    if (!row.job_spec) return json({ error: "this check was reported externally; re-run its script and report again" }, 400);
    const now = Date.now();
    await d1Run(
      db,
      `UPDATE check_runs SET state = 'queued', attempt = attempt + 1, summary = NULL, log = '', log_bytes = 0, runner_id = NULL,
         started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`,
      [now, row.id]
    );
    return json({ id: row.id, name, state: "queued", rerun_by: who });
  }

  if (!rest && (method === "POST" || method === "PUT")) {
    const name = typeof b.name === "string" ? b.name : "";
    if (!CHECK_NAME_RE.test(name)) return json({ error: "name must match [A-Za-z0-9_.-]{1,64}" }, 400);
    const state = typeof b.state === "string" ? b.state : "";
    if (!CHECK_STATES.includes(state as CheckState)) return json({ error: `state must be one of ${CHECK_STATES.join("|")}` }, 400);
    const target = await resolveCs();
    if (target instanceof Response) return target;
    const summary = typeof b.summary === "string" ? b.summary.slice(0, 2000) : null;
    const log = typeof b.log === "string" ? capLog(b.log) : null;
    const tu = typeof b.target_url === "string" && /^https?:\/\//.test(b.target_url) ? b.target_url.slice(0, 2000) : null;
    const now = Date.now();
    const startedAt = Number.isFinite(Number(b.started_at)) && b.started_at != null ? Number(b.started_at) : state === "queued" ? null : now;
    const finishedAt = Number.isFinite(Number(b.finished_at)) && b.finished_at != null ? Number(b.finished_at) : FINAL_STATES.has(state) ? now : null;
    await d1Run(
      db,
      `INSERT INTO check_runs (id, org, repo, changeset, name, state, summary, log, log_bytes, target_url, ref_name, source, reported_by, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'report', ?, ?, ?, ?, ?)
       ON CONFLICT(org, repo, changeset, name) DO UPDATE SET state = excluded.state, summary = COALESCE(excluded.summary, check_runs.summary),
         log = COALESCE(excluded.log, check_runs.log), log_bytes = COALESCE(excluded.log_bytes, check_runs.log_bytes),
         target_url = COALESCE(excluded.target_url, check_runs.target_url), reported_by = excluded.reported_by,
         updated_at = excluded.updated_at, started_at = COALESCE(check_runs.started_at, excluded.started_at), finished_at = excluded.finished_at`,
      [crypto.randomUUID(), org, repo, target.cs, name, state, summary, log, log ? log.length : null, tu, target.ref, who, now, now, startedAt, finishedAt]
    );
    const row = (await runs(env, org, repo, target.cs)).find((r) => r.name === name)!;
    return json(checkJson(row, new Map()), 201);
  }
  return json({ error: "method not allowed" }, 405);
}
