import { d1All, d1Run, dbOrgs, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { forbidden } from "./authz";
import { emitEvent } from "./webhooks";

type Env = D1Env & { waitUntil?: (p: Promise<unknown>) => void };

const TITLE_MAX = 120;
const BODY_MAX = 10_000;

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
  tag: string | null;
  created_at: number;
  closed_at: number | null;
};

export type IssueCommentRow = {
  id: string;
  org: string;
  repo: string;
  number: number;
  author_user_id: string;
  author: string;
  body: string;
  created_at: number;
  updated_at: number;
};

function parseLabels(raw: unknown): string[] | null {
  if (raw == null) return null;
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? (raw as string).split(",") : [];
  const clean = [...new Set(arr.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  return clean.length ? clean : null;
}

export function issueJson(r: IssueRow, extra: Record<string, unknown> = {}) {
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
    tag: r.tag,
    created_at: r.created_at,
    closed_at: r.closed_at,
    ...extra,
  };
}

function commentJson(r: IssueCommentRow) {
  return {
    id: r.id,
    org: r.org,
    repo: r.repo,
    number: r.number,
    author_user_id: r.author_user_id,
    author: r.author,
    body: r.body,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Title and description are author-only; site admins may override. */
export function issueEditDenied(actor: Actor | null, authorUserId: string): 401 | 403 | null {
  if (!actor) return 401;
  if (actor.admin || actor.userId === authorUserId) return null;
  return 403;
}

/** Comment body edit/delete is the comment author; site admins may override. */
export function issueCommentMutateDenied(actor: Actor | null, authorUserId: string): 401 | 403 | null {
  if (!actor) return 401;
  if (actor.admin || actor.userId === authorUserId) return null;
  return 403;
}

export function validateIssueCommentBody(
  raw: unknown
): { ok: true; body: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid JSON" };
  }
  const body = (raw as { body?: unknown }).body;
  if (typeof body !== "string") return { ok: false, error: "body must be a string" };
  if (body.length === 0) return { ok: false, error: "body is required" };
  if (body.length > BODY_MAX) return { ok: false, error: "body too long" };
  return { ok: true, body };
}

async function ensureCounter(env: D1Env, org: string, repo: string): Promise<void> {
  const db = dbOrgs(env);
  const have = await d1All<{ next: number }>(db, "SELECT next FROM repo_counters WHERE org = ? AND repo = ? LIMIT 1", [org, repo]);
  if (have[0]) return;
  const maxRows = await d1All<{ n: number }>(db, "SELECT COALESCE(MAX(number), 0) as n FROM pulls WHERE org = ? AND repo = ?", [org, repo]).catch(() => [{ n: 0 }]);
  const next = (maxRows[0]?.n ?? 0) + 1;
  try {
    await d1Run(db, "INSERT OR IGNORE INTO repo_counters (org, repo, next) VALUES (?, ?, ?)", [org, repo, next]);
  } catch {
    /* ignore races */
  }
}

/** Atomically allocates the next shared number for a repo. */
export async function allocateRepoNumber(env: D1Env, org: string, repo: string): Promise<number> {
  const db = dbOrgs(env);
  await ensureCounter(env, org, repo);
  try {
    const rows = await d1All<{ next: number }>(
      db,
      "UPDATE repo_counters SET next = next + 1 WHERE org = ? AND repo = ? RETURNING next",
      [org, repo]
    );
    const newNext = rows[0]?.next ?? 1;
    return newNext - 1;
  } catch {
    const cur = await d1All<{ next: number }>(db, "SELECT next FROM repo_counters WHERE org = ? AND repo = ? LIMIT 1", [org, repo]);
    const next = (cur[0]?.next ?? 1) + 1;
    await d1Run(db, "UPDATE repo_counters SET next = ? WHERE org = ? AND repo = ?", [next, org, repo]);
    return next - 1;
  }
}

async function loadIssue(env: Env, org: string, repo: string, number: number): Promise<IssueRow | null> {
  const rows = await d1All<IssueRow>(
    dbOrgs(env),
    "SELECT * FROM issues WHERE org = ? AND repo = ? AND number = ? LIMIT 1",
    [org, repo, number]
  );
  return rows[0] ?? null;
}

async function commentCount(env: Env, org: string, repo: string, number: number): Promise<number> {
  try {
    const rows = await d1All<{ n: number }>(
      dbOrgs(env),
      "SELECT COUNT(*) as n FROM issue_comments WHERE org = ? AND repo = ? AND number = ?",
      [org, repo, number]
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

const ISSUES_LIST = /^\/v1\/repos\/([^/]+)\/([^/]+)\/issues$/;
const ISSUE_ONE = /^\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/;
const ISSUE_ACTION = /^\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/(close|reopen)$/;
const ISSUE_COMMENTS = /^\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/comments$/;
const ISSUE_COMMENT_ONE = /^\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/comments\/([^/]+)$/;

/** Handle `/v1/repos/{org}/{repo}/issues...`. Returns null when not a matching route. */
export async function handleIssues(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const db = dbOrgs(env);

  const commentOne = path.match(ISSUE_COMMENT_ONE);
  if (commentOne) {
    const org = decodeURIComponent(commentOne[1]!);
    const repo = decodeURIComponent(commentOne[2]!);
    const number = Number(commentOne[3]);
    const id = decodeURIComponent(commentOne[4]!);
    const issue = await loadIssue(env, org, repo, number);
    if (!issue) return json({ error: "not found" }, 404);
    const rows = await d1All<IssueCommentRow>(
      db,
      "SELECT * FROM issue_comments WHERE id = ? AND org = ? AND repo = ? AND number = ? LIMIT 1",
      [id, org, repo, number]
    );
    const row = rows[0];
    if (!row) return json({ error: "not found" }, 404);
    if (method === "GET") return json(commentJson(row));
    if (method === "PATCH") {
      const denied = issueCommentMutateDenied(actor, row.author_user_id);
      if (denied === 401) return json({ error: "unauthorized" }, 401);
      if (denied === 403) return forbidden();
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const parsed = validateIssueCommentBody(raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const t = nowMs();
      await d1Run(db, "UPDATE issue_comments SET body = ?, updated_at = ? WHERE id = ?", [parsed.body, t, id]);
      return json(commentJson({ ...row, body: parsed.body, updated_at: t }));
    }
    if (method === "DELETE") {
      const denied = issueCommentMutateDenied(actor, row.author_user_id);
      if (denied === 401) return json({ error: "unauthorized" }, 401);
      if (denied === 403) return forbidden();
      await d1Run(db, "DELETE FROM issue_comments WHERE id = ?", [id]);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  const comments = path.match(ISSUE_COMMENTS);
  if (comments) {
    const org = decodeURIComponent(comments[1]!);
    const repo = decodeURIComponent(comments[2]!);
    const number = Number(comments[3]);
    const issue = await loadIssue(env, org, repo, number);
    if (!issue) return json({ error: "not found" }, 404);
    if (method === "GET") {
      const rows = await d1All<IssueCommentRow>(
        db,
        "SELECT * FROM issue_comments WHERE org = ? AND repo = ? AND number = ? ORDER BY created_at ASC",
        [org, repo, number]
      );
      return json({ comments: rows.map(commentJson) });
    }
    if (method === "POST") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const parsed = validateIssueCommentBody(raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const id = crypto.randomUUID();
      const t = nowMs();
      await d1Run(
        db,
        "INSERT INTO issue_comments (id, org, repo, number, author_user_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, org, repo, number, actor.userId, actor.name, parsed.body, t, t]
      );
      return json(
        commentJson({
          id,
          org,
          repo,
          number,
          author_user_id: actor.userId,
          author: actor.name,
          body: parsed.body,
          created_at: t,
          updated_at: t,
        }),
        201
      );
    }
    return json({ error: "method not allowed" }, 405);
  }

  const list = path.match(ISSUES_LIST);
  if (list) {
    const org = decodeURIComponent(list[1]!);
    const repo = decodeURIComponent(list[2]!);
    if (method === "GET") {
      const url = new URL(request.url);
      const tag = url.searchParams.get("tag");
      let rows: IssueRow[] = [];
      if (tag && tag.trim() !== "") {
        rows = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? AND tag = ? ORDER BY number DESC", [org, repo, tag]);
      } else {
        rows = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? ORDER BY number DESC", [org, repo]);
      }
      return json({ issues: rows.map((r) => issueJson(r)) });
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
      if (title.length > TITLE_MAX) return json({ error: "title too long" }, 400);
      const text = typeof body.body === "string" ? body.body : "";
      if (text.length > BODY_MAX) return json({ error: "body too long" }, 400);
      const labels = parseLabels(body.labels);
      const assignees = parseLabels(body.assignees);
      const number = await allocateRepoNumber(env, org, repo);
      const id = crypto.randomUUID();
      const t = nowMs();
      const tag =
        typeof body.tag === "string"
          ? body.tag.trim().slice(0, 64) || null
          : null;
      await d1Run(
        db,
        "INSERT INTO issues (id, org, repo, number, author_user_id, title, body, state, labels, assignees, tag, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)",
        [id, org, repo, number, actor.userId, title, text, labels ? JSON.stringify(labels) : null, assignees ? JSON.stringify(assignees) : null, tag, t]
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
    const row = await loadIssue(env, org, repo, number);
    if (!row) return json({ error: "not found" }, 404);
    const denied = issueEditDenied(actor, row.author_user_id);
    if (denied === 403) return forbidden();
    if (verb === "close") {
      const t = nowMs();
      await d1Run(db, "UPDATE issues SET state = 'closed', closed_at = ? WHERE id = ?", [t, row.id]);
      env.waitUntil?.(emitEvent(env, org, repo, "issue", { action: "closed", issue: { ...issueJson(row), state: "closed", closed_at: t } }));
      return json({ ...issueJson(row), state: "closed", closed_at: t });
    }
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
      const row = await loadIssue(env, org, repo, number);
      if (!row) return json({ error: "not found" }, 404);
      return json(issueJson(row, { comment_count: await commentCount(env, org, repo, number) }));
    }
    if (method === "PATCH") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      const row = await loadIssue(env, org, repo, number);
      if (!row) return json({ error: "not found" }, 404);
      const editDenied = issueEditDenied(actor, row.author_user_id);
      if (editDenied === 403) return forbidden();
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const title = body.title === undefined ? row.title : typeof body.title === "string" && body.title.trim() ? body.title.trim() : row.title;
      if (title.length > TITLE_MAX) return json({ error: "title too long" }, 400);
      const text = body.body === undefined ? row.body : typeof body.body === "string" ? body.body : row.body;
      if (text.length > BODY_MAX) return json({ error: "body too long" }, 400);
      const labels = body.labels === undefined ? row.labels : (() => {
        const v = parseLabels(body.labels);
        return v ? JSON.stringify(v) : null;
      })();
      const assignees = body.assignees === undefined ? row.assignees : (() => {
        const v = parseLabels(body.assignees);
        return v ? JSON.stringify(v) : null;
      })();
      const tag =
        body.tag === undefined
          ? row.tag
          : typeof body.tag === "string"
            ? body.tag.trim().slice(0, 64) || null
            : row.tag;
      await d1Run(db, "UPDATE issues SET title = ?, body = ?, labels = ?, assignees = ?, tag = ? WHERE id = ?", [title, text, labels, assignees, tag, row.id]);
      const updated = (await d1All<IssueRow>(db, "SELECT * FROM issues WHERE id = ? LIMIT 1", [row.id]))[0]!;
      env.waitUntil?.(emitEvent(env, org, repo, "issue", { action: "edited", issue: issueJson(updated) }));
      return json(issueJson(updated));
    }
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}
