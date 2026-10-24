import { d1All, d1Run, dbOrgs, dbTop, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { forbidden } from "./authz";
import { emitEvent } from "./webhooks";

type Env = D1Env & { waitUntil?: (p: Promise<unknown>) => void };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export type IssueRow = {
  id: string;
  org: string;
  repo: string;
  number: number;
  author_user_id: string;
  title: string;
  body: string;
  state: string;
  labels: string | null;
  assignees: string | null;
  created_at: number;
  closed_at: number | null;
};

function parseLabels(raw: unknown): string[] | null {
  if (raw == null) return null;
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? (raw as string).split(",") : [];
  const clean = [...new Set(arr.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  return clean.length ? clean : null;
}

function issueJson(r: IssueRow) {
  return {
    id: r.id,
    org: r.org,
    repo: r.repo,
    number: r.number,
    title: r.title,
    body: r.body,
    state: r.state,
    author_user_id: r.author_user_id,
    labels: r.labels ? (JSON.parse(r.labels) as string[]) : [],
    assignees: r.assignees ? (JSON.parse(r.assignees) as string[]) : [],
    created_at: r.created_at,
    closed_at: r.closed_at,
  };
}

async function ensureCounter(env: D1Env, org: string, repo: string): Promise<void> {
  const db = dbOrgs(env);
  const have = await d1All<{ next: number }>(db, "SELECT next FROM repo_counters WHERE org = ? AND repo = ? LIMIT 1", [org, repo]);
  if (have[0]) return;
  // Initialize to 1 + max(existing PR numbers), ignoring issues (first migration).
  const maxRows = await d1All<{ n: number }>(db, "SELECT COALESCE(MAX(number), 0) as n FROM pulls WHERE org = ? AND repo = ?", [org, repo]).catch(() => [{ n: 0 }]);
  const next = (maxRows[0]?.n ?? 0) + 1;
  try {
    await d1Run(db, "INSERT OR IGNORE INTO repo_counters (org, repo, next) VALUES (?, ?, ?)", [org, repo, next]);
  } catch {
    // ignore races
  }
}

/** Atomically allocates the next shared number for a repo. */
export async function allocateRepoNumber(env: D1Env, org: string, repo: string): Promise<number> {
  const db = dbOrgs(env);
  await ensureCounter(env, org, repo);
  // UPDATE ... RETURNING is supported on D1 SQLite; new value is post-increment.
  try {
    const rows = await d1All<{ next: number }>(
      db,
      "UPDATE repo_counters SET next = next + 1 WHERE org = ? AND repo = ? RETURNING next",
      [org, repo]
    );
    const newNext = rows[0]?.next ?? 1;
    return newNext - 1;
  } catch {
    // Fallback: read-then-write (best-effort)
    const cur = await d1All<{ next: number }>(db, "SELECT next FROM repo_counters WHERE org = ? AND repo = ? LIMIT 1", [org, repo]);
    const next = (cur[0]?.next ?? 1) + 1;
    await d1Run(db, "UPDATE repo_counters SET next = ? WHERE org = ? AND repo = ?", [next, org, repo]);
    return next - 1;
  }
}

const ISSUES_LIST = /^\/v1\/repos\/([^/]+)\/([^/]+)\/issues$/;
const ISSUE_ONE = /^\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/;
const ISSUE_ACTION = /^\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/(close|reopen)$/;

/** Handle `/v1/repos/{org}/{repo}/issues...`. Returns null when not a matching route. */
export async function handleIssues(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const db = dbOrgs(env);

  const list = path.match(ISSUES_LIST);
  if (list) {
    const org = decodeURIComponent(list[1]!);
    const repo = decodeURIComponent(list[2]!);
    if (method === "GET") {
      const rows = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? ORDER BY number DESC", [org, repo]);
      return json({ issues: rows.map(issueJson) });
    }
    if (method === "POST") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return json({ error: "title is required" }, 400);
      const text = typeof body.body === "string" ? body.body : "";
      const labels = parseLabels(body.labels);
      const assignees = parseLabels(body.assignees);
      const number = await allocateRepoNumber(env, org, repo);
      const id = crypto.randomUUID();
      const t = nowMs();
      await d1Run(
        db,
        "INSERT INTO issues (id, org, repo, number, author_user_id, title, body, state, labels, assignees, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)",
        [id, org, repo, number, actor.userId, title, text, labels ? JSON.stringify(labels) : null, assignees ? JSON.stringify(assignees) : null, t]
      );
      const row = (await d1All<IssueRow>(db, "SELECT * FROM issues WHERE id = ? LIMIT 1", [id]))[0]!;
      env.waitUntil?.(emitEvent(env, org, repo, "issue", { action: "opened", issue: issueJson(row) }));
      return json(issueJson(row), 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  const act = path.match(ISSUE_ACTION);
  if (act && method === "POST") {
    if (!actor) return json({ error: "unauthorized" }, 401);
    const org = decodeURIComponent(act[1]!);
    const repo = decodeURIComponent(act[2]!);
    const number = Number(act[3]);
    const verb = act[4]!;
    const rows = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? AND number = ? LIMIT 1", [org, repo, number]);
    const row = rows[0];
    if (!row) return json({ error: "not found" }, 404);
    if (verb === "close") {
      if (!actor.admin && actor.userId !== row.author_user_id) return forbidden();
      const t = nowMs();
      await d1Run(db, "UPDATE issues SET state = 'closed', closed_at = ? WHERE id = ?", [t, row.id]);
      env.waitUntil?.(emitEvent(env, org, repo, "issue", { action: "closed", issue: { ...issueJson(row), state: "closed", closed_at: t } }));
      return json({ ...issueJson(row), state: "closed", closed_at: t });
    }
    // reopen
    const t = nowMs();
    await d1Run(db, "UPDATE issues SET state = 'open', closed_at = NULL WHERE id = ?", [row.id]);
    env.waitUntil?.(emitEvent(env, org, repo, "issue", { action: "reopened", issue: { ...issueJson(row), state: "open", closed_at: null } }));
    return json({ ...issueJson(row), state: "open", closed_at: null });
  }

  const one = path.match(ISSUE_ONE);
  if (one) {
    const org = decodeURIComponent(one[1]!);
    const repo = decodeURIComponent(one[2]!);
    const number = Number(one[3]);
    if (method === "GET") {
      const rows = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? AND number = ? LIMIT 1", [org, repo, number]);
      const row = rows[0];
      if (!row) return json({ error: "not found" }, 404);
      return json(issueJson(row));
    }
    if (method === "PATCH") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      const rows = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? AND number = ? LIMIT 1", [org, repo, number]);
      const row = rows[0];
      if (!row) return json({ error: "not found" }, 404);
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const title = body.title === undefined ? row.title : typeof body.title === "string" && body.title.trim() ? body.title.trim() : row.title;
      const text = body.body === undefined ? row.body : typeof body.body === "string" ? body.body : row.body;
      const labels = body.labels === undefined ? row.labels : (() => {
        const v = parseLabels(body.labels);
        return v ? JSON.stringify(v) : null;
      })();
      const assignees = body.assignees === undefined ? row.assignees : (() => {
        const v = parseLabels(body.assignees);
        return v ? JSON.stringify(v) : null;
      })();
      await d1Run(db, "UPDATE issues SET title = ?, body = ?, labels = ?, assignees = ? WHERE id = ?", [title, text, labels, assignees, row.id]);
      const updated = (await d1All<IssueRow>(db, "SELECT * FROM issues WHERE id = ? LIMIT 1", [row.id]))[0]!;
      env.waitUntil?.(emitEvent(env, org, repo, "issue", { action: "edited", issue: issueJson(updated) }));
      return json(issueJson(updated));
    }
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}

