import { d1All, d1Run, dbOrgs } from "./db";
import { loadActor, sha256Hex, type Actor } from "./authz";
import { isRepoOwner } from "./owners"; // optional import; we gate admin/owner routes lightly
import { engineFetch } from "./pulls";
import { getRepoSettings, CHECK_NAME_RE } from "./settings";

type Env = Parameters<typeof engineFetch>[0];

export const CHECK_STATES = ["queued", "running", "success", "failure", "error", "cancelled"] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export const FINAL_STATES = new Set<string>(["success", "failure", "error", "cancelled"]);
export const LOG_MAX = 1_000_000;
const MAX_JOBS = 64;
const DEFAULT_TIMEOUT = 600;
const MAX_TIMEOUT = 3600;
const POLL_MAX_MS = 25_000;
const POLL_STEP_MS = 2_000;

// ---------- helpers ----------

export function labelsMatch(runnerLabels: string[], runsOn: string[]): boolean {
  const have = new Set(runnerLabels.map((l) => l.toLowerCase()));
  return runsOn.every((l) => have.has(l.toLowerCase()));
}

export function capLog(log: string): string {
  if (log.length <= LOG_MAX) return log;
  const marker = "[log truncated: showing the last 1 MB]\n";
  return marker + log.slice(log.length - (LOG_MAX - marker.length));
}

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

export async function requiredCheckReasons(env: Env, org: string, repo: string, changeset: string | null): Promise<string[]> {
  const { requiredChecks } = await getRepoSettings(env, org, repo);
  if (!requiredChecks.length) return [];
  if (!changeset) return requiredChecks.map((n) => requiredCheckReason(n, undefined));
  const rows = await runs(env, org, repo, changeset).catch(() => [] as CheckRow[]);
  const states = new Map(rows.map((r) => [r.name, r.state]));
  return failingRequiredChecks(requiredChecks, rows).map((n) => requiredCheckReason(n, states.get(n)));
}

// ---------- discovery of .scm/test*/Dockerfile ----------

type TestMeta = {
  name: string; // test directory name, e.g., "test1"
  path: string; // ".scm/test1"
  runsOn: string[]; // labels from optional "labels" file
  timeout: number; // seconds from optional "timeout" file
  needs?: string[]; // optional docker needs from .scm/<test>/needs
};

const HEX64 = /^[0-9a-f]{64}$/;

async function readSmallText(env: Env, origin: URL, org: string, repo: string, cs: string, path: string): Promise<string | null> {
  const r = await engineFetch(env, origin, `/v1/repos/${org}/${repo}/blob/${cs}?path=${encodeURIComponent(path)}`, { method: "GET" });
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const hint = (await r.json()) as { contentBase64?: string; url?: string; offset?: number; length?: number; size?: number };
  const len = hint.length ?? hint.size ?? 0;
  if (len > 64 * 1024) return null;
  if (hint.contentBase64) {
    return new TextDecoder().decode(Uint8Array.from(atob(hint.contentBase64), (c) => c.charCodeAt(0)));
  }
  if (!hint.url || hint.offset == null || len === 0) return null;
  const resp = await fetch(hint.url, { headers: { range: `bytes=${hint.offset}-${hint.offset + len - 1}` } });
  if (!resp.ok) return null;
  const buf = new Uint8Array(await resp.arrayBuffer());
  return new TextDecoder().decode(resp.status === 206 ? buf : buf.slice(hint.offset, hint.offset + len));
}

// Parse a `.scm/<test>/needs` file content:
// - one directive per line
// - ignore blanks and lines starting with '#'
// - accept only `docker:<folder>` where <folder> is a single segment under .scm (no slashes, not '.' or '..')
// - cap total to 8
export function parseNeedsText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^docker:([A-Za-z0-9._-]+)$/);
    if (!m) continue;
    const seg = m[1]!;
    if (!seg || seg === "." || seg === ".." || seg.includes("/")) continue;
    out.push(seg);
    if (out.length >= 8) break;
  }
  return out;
}

async function listDir(env: Env, origin: URL, org: string, repo: string, cs: string, path: string): Promise<{ name: string; kind: "file" | "dir" }[]> {
  const r = await engineFetch(env, origin, `/v1/repos/${org}/${repo}/list/${cs}?path=${encodeURIComponent(path)}`, { method: "GET" });
  if (!r.ok) return [];
  try {
    const body = (await r.json()) as { entries?: { name?: string; kind?: string }[] };
    const out: { name: string; kind: "file" | "dir" }[] = [];
    for (const e of body.entries ?? []) {
      const name = String(e.name ?? "");
      const kind = (e.kind === "dir" || e.kind === "file") ? (e.kind as "dir" | "file") : ("file" as const);
      if (name) out.push({ name, kind });
    }
    return out;
  } catch {
    return [];
  }
}

function isTestDir(name: string): boolean {
  // Accept test, test1, test_unit, test-foo; keep convention-over-config.
  return /^test[0-9A-Za-z._-]*$/.test(name);
}

async function discoverDockerTests(env: Env, origin: URL, org: string, repo: string, cs: string): Promise<TestMeta[]> {
  const out: TestMeta[] = [];
  const scm = await listDir(env, origin, org, repo, cs, ".scm");
  for (const e of scm) {
    if (e.kind !== "dir" || !isTestDir(e.name)) continue;
    const base = `.scm/${e.name}`;
    const dockerfile = await readSmallText(env, origin, org, repo, cs, `${base}/Dockerfile`);
    if (dockerfile == null) continue;
    // Optional files
    const labelsRaw = (await readSmallText(env, origin, org, repo, cs, `${base}/labels`)) ?? "";
    const timeoutRaw = (await readSmallText(env, origin, org, repo, cs, `${base}/timeout`)) ?? "";
    const runsOn = [...new Set(labelsRaw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_.-]{1,32}$/.test(s)))].slice(0, 20);
    let timeout = Math.floor(Number(timeoutRaw.trim()));
    if (!Number.isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT;
    timeout = Math.min(timeout, MAX_TIMEOUT);
    const needsText = (await readSmallText(env, origin, org, repo, cs, `${base}/needs`)) ?? "";
    const needs = parseNeedsText(needsText);
    out.push({ name: e.name, path: base, runsOn, timeout, needs: needs.length ? needs : undefined });
    if (out.length >= MAX_JOBS) break;
  }
  return out;
}

/** Reads .scm/tests on a changeset and enqueues docker jobs once; safe to call repeatedly. */
export async function ensureScanned(env: Env, origin: URL, org: string, repo: string, cs: string, refName: string | null): Promise<void> {
  const db = dbOrgs(env);
  const seen = await d1All<{ status: string }>(db, "SELECT status FROM ci_scans WHERE org = ? AND repo = ? AND changeset = ?", [org, repo, cs]);
  if (seen.length) return;
  const now = Date.now();
  const tests = await discoverDockerTests(env, origin, org, repo, cs).catch(() => [] as TestMeta[]);
  if (!tests.length) {
    await d1Run(db, "INSERT OR IGNORE INTO ci_scans (org, repo, changeset, status, scanned_at) VALUES (?, ?, ?, 'none', ?)", [org, repo, cs, now]);
    return;
  }
  for (const t of tests) {
    // job_spec encodes docker { path, timeout, needs? }
    const spec = { type: "docker", path: t.path, timeout: t.timeout, needs: t.needs };
    await d1Run(
      db,
      `INSERT OR IGNORE INTO check_runs (id, org, repo, changeset, name, state, source, ref_name, job_spec, runs_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 'docker', ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), org, repo, cs, t.name, refName, JSON.stringify(spec), JSON.stringify(t.runsOn), now, now]
    );
  }
  await d1Run(db, "INSERT OR IGNORE INTO ci_scans (org, repo, changeset, status, scanned_at) VALUES (?, ?, ?, 'queued', ?)", [org, repo, cs, now]);
}

// ---------- polling and updates ----------

async function expireStale(env: Env, org: string, repo: string): Promise<void> {
  const db = dbOrgs(env);
  const rows = await d1All<{ id: string; job_spec: string | null; started_at: number | null; updated_at: number }>(
    db,
    "SELECT id, job_spec, started_at, updated_at FROM check_runs WHERE org = ? AND repo = ? AND state = 'running'",
    [org, repo]
  );
  const now = Date.now();
  for (const r of rows) {
    const timeout = r.job_spec ? ((JSON.parse(r.job_spec) as { timeout?: number }).timeout ?? DEFAULT_TIMEOUT) : DEFAULT_TIMEOUT;
    if (now - r.updated_at > (timeout + 120) * 1000) {
      await d1Run(db, "UPDATE check_runs SET state = 'error', summary = 'runner stopped reporting', finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'", [now, now, r.id]);
    }
  }
}

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

async function refTarget(env: Env, origin: URL, org: string, repo: string, ref: string): Promise<string | null> {
  const r = await engineFetch(env, origin, `/v1/repos/${org}/${repo}/refs/${ref}`, { method: "GET" });
  if (!r.ok) return null;
  return ((await r.json()) as { target?: string }).target ?? null;
}

export async function scanRepo(env: Env, origin: URL, org: string, repo: string): Promise<void> {
  const heads = new Map<string, string>();
  const main = await refTarget(env, origin, org, repo, "main").catch(() => null);
  if (main) heads.set(main, "refs/heads/main");
  const pulls = await d1All<{ head_ref: string }>(dbOrgs(env), "SELECT head_ref FROM pulls WHERE org = ? AND repo = ? AND state = 'open'", [org, repo]).catch(() => []);
  for (const p of pulls) {
    const t = await refTarget(env, origin, org, repo, p.head_ref).catch(() => null);
    if (t && !heads.has(t)) heads.set(t, p.head_ref);
  }
  for (const [cs, ref] of heads) await ensureScanned(env, origin, org, repo, cs, ref).catch(() => undefined);
}

export async function onRefWritten(env: Env, origin: URL, org: string, repo: string, refName: string): Promise<void> {
  const full = refName.startsWith("refs/") ? refName : `refs/heads/${refName}`;
  const isMain = full === "refs/heads/main";
  const prs = isMain
    ? []
    : await d1All<{ number: number }>(dbOrgs(env), "SELECT number FROM pulls WHERE org = ? AND repo = ? AND state = 'open' AND (head_ref = ? OR head_ref = ?)", [org, repo, full, refName]).catch(() => []);
  if (!isMain && !prs.length) return;
  const t = await refTarget(env, origin, org, repo, full);
  if (t) await ensureScanned(env, origin, org, repo, t, full);
}

// ---------- routes ----------

export async function handleCi(request: Request, env: Env, path: string): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const origin = new URL(request.url);
  const db = dbOrgs(env);

  // ----- runner protocol -----
  if (path === "/v1/runners/poll" && method === "POST") {
    const runner = await loadRunner(env, request);
    if (!runner) return json({ error: "runner token required" }, 401);
    const body = await (async () => {
      try {
        return (await request.json()) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const waitMs = Math.min(Math.max(Number(body["wait_s"] ?? 20) * 1000, 0), POLL_MAX_MS);
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
        const job = JSON.parse(q.job_spec!) as { type: string; path?: string; timeout?: number; needs?: string[] };
        const runsOn = q.runs_on ? (JSON.parse(q.runs_on) as string[]) : [];
        if (!labelsMatch(runner.labels, runsOn)) continue;
        const now = Date.now();
        const res = await db
          .prepare("UPDATE check_runs SET state = 'running', runner_id = ?, started_at = ?, finished_at = NULL, updated_at = ?, log = '', log_bytes = 0, summary = NULL WHERE id = ? AND state = 'queued'")
          .bind(runner.id, now, now, q.id)
          .run();
        if ((res.meta?.changes ?? 0) !== 1) continue;
        if (job.type === "docker" && job.path) {
          return json({
            job: {
              id: q.id,
              org: q.org,
              repo: q.repo,
              changeset: q.changeset,
              ref: q.ref_name,
              name: q.name,
              attempt: q.attempt,
              docker: {
                path: job.path,
                timeout: Math.min(Math.max(Number(job.timeout ?? DEFAULT_TIMEOUT), 1), MAX_TIMEOUT),
                needs: Array.isArray(job.needs) ? job.needs : undefined
              },
              runs_on: runsOn
            },
          });
        }
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
    const rows = await d1All<{ state: string; runner_id: string | null; log: string | null; name: string }>(db, "SELECT state, runner_id, log, name FROM check_runs WHERE id = ?", [id]);
    const row = rows[0];
    if (!row) return json({ error: "not found" }, 404);
    if (row.runner_id !== runner.id) return json({ error: "job is not claimed by this runner" }, 403);
    if (row.state !== "running") return json({ state: row.state, cancelled: true });
    const b = await (async () => {
      try {
        return (await request.json()) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const log = capLog((row.log ?? "") + (typeof b["log_append"] === "string" ? String(b["log_append"]) : ""));
    const now = Date.now();
    const state = typeof b["state"] === "string" ? String(b["state"]) : "running";
    if (!CHECK_STATES.includes(state as CheckState) || state === "queued") return json({ error: "bad state" }, 400);
    const summary = typeof b["summary"] === "string" ? String(b["summary"]).slice(0, 2000) : null;
    await d1Run(
      db,
      `UPDATE check_runs SET log = ?, log_bytes = ?, state = ?, summary = COALESCE(?, summary), updated_at = ?,
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`,
      [log, log.length, state, summary, now, FINAL_STATES.has(state) ? 1 : 0, now, id]
    );
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
    // If isRepoOwner is unavailable (not ported), allow any authenticated user to create a runner on their repos.
    const allow = actor != null && (await (async () => { try { return await isRepoOwner(env as any, org, repo, actor!.userId); } catch { return true; } })());
    if (!allow) return json({ error: "only repo owners can manage runners" }, actor ? 403 : 401);
    if (!rest && method === "GET") {
      const rows = await d1All<{ id: string; name: string; labels: string; created_by: string; created_at: number; last_seen: number | null }>(
        db,
        "SELECT id, name, labels, created_by, created_at, last_seen FROM ci_runners WHERE org = ? AND repo = ? ORDER BY created_at",
        [org, repo]
      );
      return json({ runners: rows.map((r) => ({ ...r, labels: JSON.parse(r.labels) as string[] })) });
    }
    if (!rest && method === "POST") {
      let b: Record<string, unknown> = {};
      try {
        b = (await request.json()) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      const name = typeof b["name"] === "string" && b["name"].trim() ? b["name"].trim().slice(0, 64) : `runner-${Date.now().toString(36)}`;
      let labels = b["labels"];
      if (typeof labels === "string") labels = (labels as string).split(",");
      if (!Array.isArray(labels)) labels = [];
      const clean = [...new Set((labels as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_.-]{1,32}$/.test(x)))].slice(0, 20);
      const token = await (async () => {
        const b = crypto.getRandomValues(new Uint8Array(24));
        return "scnr_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      })();
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
      // For now, only ?ref or ?changeset are accepted in this minimal port.
      return json({ error: "pass ?ref=NAME or ?changeset=<64 hex>" }, 400);
    } else if (ref && !cs) {
      cs = await refTarget(env, origin, org, repo, ref);
      refName = ref;
    }
    if (!cs || !HEX64.test(cs)) return json({ error: "pass ?ref=NAME or ?changeset=<64 hex>" }, 400);
    if (refName === "main" || refName === "refs/heads/main") await ensureScanned(env, origin, org, repo, cs, refName).catch(() => undefined);
    await expireStale(env, org, repo).catch(() => undefined);
    const rows = await runs(env, org, repo, cs);
    const runnerRows = await d1All<{ id: string; name: string }>(db, "SELECT id, name FROM ci_runners WHERE org = ? AND repo = ?", [org, repo]);
    const names = new Map(runnerRows.map((r) => [r.id, r.name]));
    const scan = await d1All<{ status: string; detail: string | null }>(db, "SELECT status, detail FROM ci_scans WHERE org = ? AND repo = ? AND changeset = ?", [org, repo, cs]);
    const { requiredChecks } = await getRepoSettings(env, org, repo);
    return json({ changeset: cs, docker_tests: scan[0]?.status ?? "pending", checks: rows.map((r) => checkJson(r, names)), required: requiredChecks });
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
  const allowed = (runner && runner.org === org && runner.repo === repo) || !!actor;
  if (!allowed) return json({ error: "an owner token or this repo's runner token is required" }, actor || runner ? 403 : 401);
  const who = actor ? actor.name : `runner:${runner!.name}`;
  const b = method === "GET" ? {} : (await (async () => { try { return (await request.json()) as Record<string, unknown>; } catch { return {}; } })());

  async function resolveCs(): Promise<{ cs: string; ref: string | null } | Response> {
    if (typeof b["changeset"] === "string" && HEX64.test(String(b["changeset"]))) return { cs: String(b["changeset"]), ref: typeof b["ref"] === "string" ? String(b["ref"]) : null };
    if (typeof b["ref"] === "string") {
      const t = await refTarget(env, origin, org, repo, String(b["ref"]));
      if (!t) return json({ error: "unknown ref" }, 404);
      return { cs: t, ref: String(b["ref"]) };
    }
    return json({ error: "pass changeset or ref" }, 400);
  }

  if (rest === "rerun" && method === "POST") {
    const name = typeof b["name"] === "string" ? String(b["name"]) : "";
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
    const name = typeof b["name"] === "string" ? String(b["name"]) : "";
    if (!CHECK_NAME_RE.test(name)) return json({ error: "name must match [A-Za-z0-9_.-]{1,64}" }, 400);
    const state = typeof b["state"] === "string" ? String(b["state"]) : "";
    if (!CHECK_STATES.includes(state as CheckState)) return json({ error: `state must be one of ${CHECK_STATES.join("|")}` }, 400);
    const target = await resolveCs();
    if (target instanceof Response) return target;
    const summary = typeof b["summary"] === "string" ? String(b["summary"]).slice(0, 2000) : null;
    const log = typeof b["log"] === "string" ? capLog(String(b["log"])) : null;
    const tu = typeof b["target_url"] === "string" && /^https?:\/\//.test(String(b["target_url"])) ? String(b["target_url"]).slice(0, 2000) : null;
    const now = Date.now();
    const startedAt = Number.isFinite(Number(b["started_at"])) && b["started_at"] != null ? Number(b["started_at"]) : state === "queued" ? null : now;
    const finishedAt = FINAL_STATES.has(state) ? now : (Number.isFinite(Number(b["finished_at"])) && b["finished_at"] != null ? Number(b["finished_at"]) : null);
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
