import { requiredCheckReasons } from "./ci";
import { getRepoSettings } from "./settings";
import {
  d1All,
  d1Run,
  dbOrgs,
  dbTop,
  loadUsersById,
  mergeAuthorNames,
  nowMs,
  uuid,
  type D1Env,
} from "./db";
import type { Actor } from "./authz";
import { forbidden, orgCanWrite } from "./authz";
import { isRepoOwner, ownerUserIds } from "./owners";

const TITLE_MAX = 120;
const BODY_MAX = 10_000;

type Env = D1Env & {
  ENGINE: DurableObjectNamespace;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function pullsWithAuthors(
  env: Env,
  sql: string,
  params: unknown[]
): Promise<PullRow[]> {
  const rows = await d1All<PullRow>(dbOrgs(env), sql, params);
  const users = await loadUsersById(
    dbTop(env),
    rows.map((r) => r.author_user_id)
  );
  return mergeAuthorNames(rows, users);
}

export function engineFetch(env: Env, origin: URL, path: string, init: RequestInit): Promise<Response> {
  const id = env.ENGINE.idFromName("filecoin-project");
  const stub = env.ENGINE.get(id);
  const u = new URL(origin.toString());
  const q = path.indexOf("?");
  u.pathname = "/orgs/filecoin-project" + (q >= 0 ? path.slice(0, q) : path);
  u.search = q >= 0 ? path.slice(q) : "";
  return stub.fetch(new Request(u.toString(), init));
}

type PullRow = {
  id: string;
  org: string;
  repo: string;
  number: number;
  author_user_id: string;
  author_name?: string;
  title: string;
  body: string;
  head_ref: string;
  head_target: string;
  base_ref: string;
  state: string;
  created_at: number;
  merged_by: string | null;
  merged_at: number | null;
};

type CommentRow = {
  id: string;
  org: string;
  repo: string;
  number: number;
  path: string | null;
  line: number | null;
  side: string | null;
  author_user_id: string;
  author: string;
  body: string;
  created_at: number;
  resolved?: number | null;
  resolved_by?: string | null;
  resolved_at?: number | null;
};

type ApprovalRow = {
  org: string;
  repo: string;
  number: number;
  user_id: string;
  user_name: string;
  created_at: number;
};

export type CommentInput = {
  body: string;
  path: string | null;
  line: number | null;
  side: "old" | "new" | null;
};

export type PullPatch = {
  title?: string;
  body?: string;
};

/** Map engine compare status onto the public file-change vocabulary. */
export function mapCompareFileStatus(status: unknown): string {
  if (status === "deleted") return "removed";
  return typeof status === "string" ? status : String(status ?? "");
}

/** Rewrite `files[].status` `"deleted"` → `"removed"` on a compare payload. */
export function remapCompareBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const rec = body as { files?: unknown };
  if (!Array.isArray(rec.files)) return body;
  return {
    ...rec,
    files: rec.files.map((file) => {
      if (!file || typeof file !== "object") return file;
      const f = file as { status?: unknown };
      if (f.status === "deleted") return { ...f, status: "removed" };
      return file;
    }),
  };
}

/** Parse a compare/pull-files JSON response and remap file statuses. */
export async function remapCompareResponse(resp: Response): Promise<Response> {
  const text = await resp.text();
  try {
    const body = remapCompareBody(JSON.parse(text) as unknown);
    return json(body, resp.status);
  } catch {
    return new Response(text, {
      status: resp.status,
      headers: { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" },
    });
  }
}

/** Only the PR author may PATCH title/body. Anonymous → 401, others → 403. */
export function pullEditDenied(actor: Actor | null, authorUserId: string): 401 | 403 | null {
  if (!actor) return 401;
  if (actor.userId !== authorUserId) return 403;
  return null;
}

/** Comment author or site admin may delete a comment. */
export function commentDeleteDenied(actor: Actor | null, authorUserId: string): 401 | 403 | null {
  if (!actor) return 401;
  if (actor.admin || actor.userId === authorUserId) return null;
  return 403;
}

/** The PR author cannot approve their own pull request. */
export function pullApproveDenied(actor: Actor | null, authorUserId: string): 401 | 403 | null {
  if (!actor) return 401;
  if (actor.userId === authorUserId) return 403;
  return null;
}

/** Comment author or PR author may resolve/unresolve a comment. */
export function commentResolveDenied(
  actor: Actor | null,
  commentAuthorUserId: string,
  pullAuthorUserId: string
): 401 | 403 | null {
  if (!actor) return 401;
  if (actor.userId === commentAuthorUserId || actor.userId === pullAuthorUserId) return null;
  return 403;
}

export const MERGE_REASON_OWNER_APPROVAL = "at least one owner approval is required";

export function mergeReasonUnresolved(count: number): string {
  return count === 1 ? "1 unresolved comment" : `${count} unresolved comments`;
}

export type MergeGate = {
  ownerApprovals: number;
  unresolvedComments: number;
  /** Owner approvals required by repo settings (always >= 1). */
  requiredApprovals?: number;
  /** Required CI checks not yet `success` on the head changeset. */
  checkReasons?: string[];
};

/** Readable merge-block reasons; empty means the review gates pass. */
export function mergeBlockReasons(gate: MergeGate): string[] {
  const reasons: string[] = [];
  const need = Math.max(1, gate.requiredApprovals ?? 1);
  if (gate.ownerApprovals < need) {
    reasons.push(need === 1 ? MERGE_REASON_OWNER_APPROVAL : `at least ${need} owner approvals are required (${gate.ownerApprovals} so far)`);
  }
  if (gate.unresolvedComments > 0) reasons.push(mergeReasonUnresolved(gate.unresolvedComments));
  for (const r of gate.checkReasons ?? []) reasons.push(r);
  return reasons;
}

export function mergeabilityJson(gate: MergeGate): {
  mergeable: boolean;
  reasons: string[];
  ownerApprovals: number;
  unresolvedComments: number;
  requiredApprovals: number;
} {
  const reasons = mergeBlockReasons(gate);
  return {
    mergeable: reasons.length === 0,
    reasons,
    ownerApprovals: gate.ownerApprovals,
    unresolvedComments: gate.unresolvedComments,
    requiredApprovals: Math.max(1, gate.requiredApprovals ?? 1),
  };
}

export function validateCommentResolve(
  raw: unknown
): { ok: true; resolved: boolean } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid JSON" };
  }
  const resolved = (raw as { resolved?: unknown }).resolved;
  if (typeof resolved !== "boolean") return { ok: false, error: "resolved must be a boolean" };
  return { ok: true, resolved };
}

export function validatePullPatch(raw: unknown): { ok: true; value: PullPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid JSON" };
  }
  const rec = raw as Record<string, unknown>;
  const out: PullPatch = {};
  if (rec.title !== undefined) {
    if (typeof rec.title !== "string") return { ok: false, error: "title must be a string" };
    const title = rec.title.trim();
    if (!title) return { ok: false, error: "title is required" };
    if (title.length > TITLE_MAX) return { ok: false, error: "title too long" };
    out.title = title;
  }
  if (rec.body !== undefined) {
    if (typeof rec.body !== "string") return { ok: false, error: "body must be a string" };
    if (rec.body.length > BODY_MAX) return { ok: false, error: "body too long" };
    out.body = rec.body;
  }
  if (out.title === undefined && out.body === undefined) {
    return { ok: false, error: "title or body is required" };
  }
  return { ok: true, value: out };
}

export function validateCommentInput(
  raw: unknown
): { ok: true; value: CommentInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid JSON" };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.body !== "string") return { ok: false, error: "body must be a string" };
  if (rec.body.length === 0) return { ok: false, error: "body is required" };
  if (rec.body.length > BODY_MAX) return { ok: false, error: "body too long" };
  let path: string | null = null;
  if (rec.path !== undefined && rec.path !== null) {
    if (typeof rec.path !== "string") return { ok: false, error: "path must be a string" };
    path = rec.path;
  }
  let line: number | null = null;
  if (rec.line !== undefined && rec.line !== null) {
    if (typeof rec.line !== "number" || !Number.isInteger(rec.line)) {
      return { ok: false, error: "line must be an integer" };
    }
    line = rec.line;
  }
  let side: "old" | "new" | null = null;
  if (rec.side !== undefined && rec.side !== null) {
    if (rec.side !== "old" && rec.side !== "new") {
      return { ok: false, error: "side must be old or new" };
    }
    side = rec.side;
  }
  return { ok: true, value: { body: rec.body, path, line, side } };
}

function pullJson(row: PullRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: row.id,
    org: row.org,
    repo: row.repo,
    number: row.number,
    author_user_id: row.author_user_id,
    author: row.author_name ?? null,
    title: row.title,
    body: row.body,
    head_ref: row.head_ref,
    head_target: row.head_target,
    base_ref: row.base_ref,
    state: row.state,
    created_at: row.created_at,
    merged_by: row.merged_by,
    merged_at: row.merged_at,
    ...extra,
  };
}

function commentJson(row: CommentRow): Record<string, unknown> {
  return {
    id: row.id,
    org: row.org,
    repo: row.repo,
    number: row.number,
    path: row.path,
    line: row.line,
    side: row.side,
    author_user_id: row.author_user_id,
    author: row.author,
    body: row.body,
    created_at: row.created_at,
    resolved: row.resolved === 1,
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at ?? null,
  };
}

function approvalJson(
  row: ApprovalRow,
  ownerIds?: Set<string>
): { user: string; owner: boolean; created_at: number } {
  return {
    user: row.user_name,
    owner: ownerIds ? ownerIds.has(row.user_id) : false,
    created_at: row.created_at,
  };
}

async function loadPull(
  env: Env,
  org: string,
  repo: string,
  number: number
): Promise<PullRow | null> {
  const rows = await pullsWithAuthors(
    env,
    `SELECT * FROM pulls WHERE org = ? AND repo = ? AND number = ? LIMIT 1`,
    [org, repo, number]
  );
  return rows[0] ?? null;
}

async function pullCounts(
  env: Env,
  org: string,
  repo: string,
  number: number
): Promise<{ comment_count: number; approval_count: number }> {
  const db = dbOrgs(env);
  const comments = await d1All<{ n: number }>(
    db,
    "SELECT COUNT(*) as n FROM pr_comments WHERE org = ? AND repo = ? AND number = ?",
    [org, repo, number]
  );
  const approvals = await d1All<{ n: number }>(
    db,
    "SELECT COUNT(*) as n FROM pr_approvals WHERE org = ? AND repo = ? AND number = ?",
    [org, repo, number]
  );
  return {
    comment_count: comments[0]?.n ?? 0,
    approval_count: approvals[0]?.n ?? 0,
  };
}

async function mergeGate(
  env: Env,
  org: string,
  repo: string,
  number: number,
  origin?: URL
): Promise<MergeGate> {
  const db = dbOrgs(env);
  let unresolvedComments = 0;
  try {
    const unresolved = await d1All<{ n: number }>(
      db,
      `SELECT COUNT(*) as n FROM pr_comments
        WHERE org = ? AND repo = ? AND number = ? AND COALESCE(resolved, 0) = 0`,
      [org, repo, number]
    );
    unresolvedComments = unresolved[0]?.n ?? 0;
  } catch {
    const all = await d1All<{ n: number }>(
      db,
      "SELECT COUNT(*) as n FROM pr_comments WHERE org = ? AND repo = ? AND number = ?",
      [org, repo, number]
    );
    unresolvedComments = all[0]?.n ?? 0;
  }
  let ownerApprovals = 0;
  try {
    const owned = await d1All<{ n: number }>(
      db,
      // Counts only approvals from repo owners who are not the PR author.
      `SELECT COUNT(*) as n FROM pr_approvals a
         INNER JOIN repo_owners o
           ON o.org = a.org AND o.repo = a.repo AND o.user_id = a.user_id
         INNER JOIN pulls p
           ON p.org = a.org AND p.repo = a.repo AND p.number = a.number
        WHERE a.org = ? AND a.repo = ? AND a.number = ? AND a.user_id != p.author_user_id`,
      [org, repo, number]
    );
    ownerApprovals = owned[0]?.n ?? 0;
  } catch {
    ownerApprovals = 0;
  }
  const { requiredApprovals, requiredChecks } = await getRepoSettings(env, org, repo);
  let checkReasons: string[] = [];
  if (requiredChecks.length) {
    const p = await d1All<{ head_ref: string; head_target: string | null }>(
      db,
      "SELECT head_ref, head_target FROM pulls WHERE org = ? AND repo = ? AND number = ?",
      [org, repo, number]
    );
    let head: string | null = p[0]?.head_target ?? null;
    if (p[0] && origin) head = (await refTarget(env, origin, org, repo, p[0].head_ref)) ?? head;
    checkReasons = await requiredCheckReasons(env, org, repo, head);
  }
  return { ownerApprovals, unresolvedComments, requiredApprovals, checkReasons };
}

async function refTarget(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  refName: string
): Promise<string | null> {
  const resp = await engineFetch(env, origin, `/v1/repos/${org}/${repo}/refs/${refName}`, {
    method: "GET",
  });
  if (!resp.ok) return null;
  const body = (await resp.json()) as { target?: string };
  return body.target ?? null;
}

async function changesetParents(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  id: string
): Promise<string[]> {
  const resp = await engineFetch(env, origin, `/v1/repos/${org}/${repo}/changesets/${id}`, {
    method: "GET",
  });
  if (!resp.ok) return [];
  const body = (await resp.json()) as { parents?: string[] };
  return Array.isArray(body.parents) ? body.parents.filter((p): p is string => typeof p === "string") : [];
}

const PULLS_LIST = /^\/v1\/repos\/([^/]+)\/([^/]+)\/pulls$/;
const PULL_ONE = /^\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)$/;
const PULL_FILES = /^\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)\/files$/;
const PULL_ACTION = /^\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)\/(merge|close)$/;
const PULL_COMMENTS = /^\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)\/comments$/;
const PULL_COMMENT_ONE = /^\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)\/comments\/([^/]+)$/;
const PULL_APPROVALS = /^\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)\/approvals$/;
const PULL_MERGEABILITY = /^\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)\/mergeability$/;

/** Handle `/v1/repos/{org}/{repo}/pulls...`. Returns null if the path is not a pulls route. */
export async function handlePulls(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const origin = new URL(request.url);
  const db = dbOrgs(env);

  const list = path.match(PULLS_LIST);
  if (list) {
    const org = decodeURIComponent(list[1]!);
    const repo = decodeURIComponent(list[2]!);
    if (method === "GET") {
      const rows = await pullsWithAuthors(
        env,
        `SELECT * FROM pulls WHERE org = ? AND repo = ? ORDER BY number DESC`,
        [org, repo]
      );
      return json({ pulls: rows.map((r) => pullJson(r)) });
    }
    if (method === "POST") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      let body: { title?: string; body?: string; head?: string; base?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const title = (body.title ?? "").trim();
      const prBody = body.body ?? "";
      const head = (body.head ?? "").trim();
      const base = (body.base ?? "main").trim();
      if (!title) return json({ error: "title is required" }, 400);
      if (title.length > TITLE_MAX) return json({ error: "title too long" }, 400);
      if (prBody.length > BODY_MAX) return json({ error: "body too long" }, 400);
      if (!head) return json({ error: "head is required" }, 400);
      const headTarget = await refTarget(env, origin, org, repo, head);
      if (!headTarget) return json({ error: "unknown head ref" }, 400);
      const baseTarget = await refTarget(env, origin, org, repo, base);
      if (!baseTarget) return json({ error: "unknown base ref" }, 400);
      const maxRows = await d1All<{ n: number }>(
        db,
        "SELECT COALESCE(MAX(number), 0) as n FROM pulls WHERE org = ? AND repo = ?",
        [org, repo]
      );
      const number = (maxRows[0]?.n ?? 0) + 1;
      const id = uuid();
      const created = nowMs();
      await d1Run(
        db,
        `INSERT INTO pulls
          (id, org, repo, number, author_user_id, title, body, head_ref, head_target, base_ref, state, created_at, merged_by, merged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL)`,
        [id, org, repo, number, actor.userId, title, prBody, head, headTarget, base, created]
      );
      return json(
        pullJson({
          id,
          org,
          repo,
          number,
          author_user_id: actor.userId,
          author_name: actor.name,
          title,
          body: prBody,
          head_ref: head,
          head_target: headTarget,
          base_ref: base,
          state: "open",
          created_at: created,
          merged_by: null,
          merged_at: null,
        }),
        201
      );
    }
    return json({ error: "method not allowed" }, 405);
  }

  const files = path.match(PULL_FILES);
  if (files && method === "GET") {
    const org = decodeURIComponent(files[1]!);
    const repo = decodeURIComponent(files[2]!);
    const number = Number(files[3]);
    const row = await loadPull(env, org, repo, number);
    if (!row) return json({ error: "not found" }, 404);
    const headTarget = (await refTarget(env, origin, org, repo, row.head_ref)) ?? row.head_target;
    const baseTarget = await refTarget(env, origin, org, repo, row.base_ref);
    if (!headTarget || !baseTarget) return json({ error: "unknown compare refs" }, 400);
    const resp = await engineFetch(
      env,
      origin,
      `/v1/repos/${org}/${repo}/compare/${encodeURIComponent(baseTarget)}...${encodeURIComponent(headTarget)}`,
      { method: "GET" }
    );
    return remapCompareResponse(resp);
  }

  const commentOne = path.match(PULL_COMMENT_ONE);
  if (commentOne) {
    const org = decodeURIComponent(commentOne[1]!);
    const repo = decodeURIComponent(commentOne[2]!);
    const number = Number(commentOne[3]);
    const id = decodeURIComponent(commentOne[4]!);
    const rows = await d1All<CommentRow>(
      db,
      `SELECT * FROM pr_comments WHERE id = ? AND org = ? AND repo = ? AND number = ? LIMIT 1`,
      [id, org, repo, number]
    );
    const row = rows[0];
    if (!row) return json({ error: "not found" }, 404);
    if (method === "PATCH") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      const pull = await loadPull(env, org, repo, number);
      if (!pull) return json({ error: "not found" }, 404);
      const denied = commentResolveDenied(actor, row.author_user_id, pull.author_user_id);
      if (denied === 403) return forbidden();
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const parsed = validateCommentResolve(raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const resolvedAt = parsed.resolved ? nowMs() : null;
      const resolvedBy = parsed.resolved ? actor.name : null;
      try {
        await d1Run(
          db,
          `UPDATE pr_comments SET resolved = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`,
          [parsed.resolved ? 1 : 0, resolvedBy, resolvedAt, id]
        );
      } catch {
        return json({ error: "comment resolution is unavailable" }, 500);
      }
      return json(
        commentJson({
          ...row,
          resolved: parsed.resolved ? 1 : 0,
          resolved_by: resolvedBy,
          resolved_at: resolvedAt,
        })
      );
    }
    if (method !== "DELETE") return json({ error: "method not allowed" }, 405);
    if (!actor) return json({ error: "unauthorized" }, 401);
    const denied = commentDeleteDenied(actor, row.author_user_id);
    if (denied === 401) return json({ error: "unauthorized" }, 401);
    if (denied === 403) return forbidden();
    await d1Run(db, "DELETE FROM pr_comments WHERE id = ?", [id]);
    return json({ ok: true });
  }

  const comments = path.match(PULL_COMMENTS);
  if (comments) {
    const org = decodeURIComponent(comments[1]!);
    const repo = decodeURIComponent(comments[2]!);
    const number = Number(comments[3]);
    const pull = await loadPull(env, org, repo, number);
    if (!pull) return json({ error: "not found" }, 404);
    if (method === "GET") {
      const rows = await d1All<CommentRow>(
        db,
        `SELECT * FROM pr_comments WHERE org = ? AND repo = ? AND number = ? ORDER BY created_at ASC`,
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
      const parsed = validateCommentInput(raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const id = uuid();
      const created = nowMs();
      try {
        await d1Run(
          db,
          `INSERT INTO pr_comments
            (id, org, repo, number, path, line, side, author_user_id, author, body, created_at, resolved, resolved_by, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
          [
            id,
            org,
            repo,
            number,
            parsed.value.path,
            parsed.value.line,
            parsed.value.side,
            actor.userId,
            actor.name,
            parsed.value.body,
            created,
          ]
        );
      } catch {
        await d1Run(
          db,
          `INSERT INTO pr_comments
            (id, org, repo, number, path, line, side, author_user_id, author, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            org,
            repo,
            number,
            parsed.value.path,
            parsed.value.line,
            parsed.value.side,
            actor.userId,
            actor.name,
            parsed.value.body,
            created,
          ]
        );
      }
      return json(
        commentJson({
          id,
          org,
          repo,
          number,
          path: parsed.value.path,
          line: parsed.value.line,
          side: parsed.value.side,
          author_user_id: actor.userId,
          author: actor.name,
          body: parsed.value.body,
          created_at: created,
          resolved: 0,
          resolved_by: null,
          resolved_at: null,
        }),
        201
      );
    }
    return json({ error: "method not allowed" }, 405);
  }

  const approvals = path.match(PULL_APPROVALS);
  if (approvals) {
    const org = decodeURIComponent(approvals[1]!);
    const repo = decodeURIComponent(approvals[2]!);
    const number = Number(approvals[3]);
    const pull = await loadPull(env, org, repo, number);
    if (!pull) return json({ error: "not found" }, 404);
    if (method === "GET") {
      const rows = await d1All<ApprovalRow>(
        db,
        `SELECT * FROM pr_approvals WHERE org = ? AND repo = ? AND number = ? ORDER BY created_at ASC`,
        [org, repo, number]
      );
      const owners = await ownerUserIds(env, org, repo);
      return json({ approvals: rows.map((r) => approvalJson(r, owners)) });
    }
    if (method === "POST") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      const denied = pullApproveDenied(actor, pull.author_user_id);
      if (denied === 403) return forbidden();
      const created = nowMs();
      const existing = await d1All<ApprovalRow>(
        db,
        `SELECT * FROM pr_approvals WHERE org = ? AND repo = ? AND number = ? AND user_id = ? LIMIT 1`,
        [org, repo, number, actor.userId]
      );
      const owners = await ownerUserIds(env, org, repo);
      if (existing[0]) {
        return json(approvalJson(existing[0], owners));
      }
      await d1Run(
        db,
        `INSERT INTO pr_approvals (org, repo, number, user_id, user_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [org, repo, number, actor.userId, actor.name, created]
      );
      return json(approvalJson({
        org,
        repo,
        number,
        user_id: actor.userId,
        user_name: actor.name,
        created_at: created,
      }, owners), 201);
    }
    if (method === "DELETE") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      await d1Run(
        db,
        `DELETE FROM pr_approvals WHERE org = ? AND repo = ? AND number = ? AND user_id = ?`,
        [org, repo, number, actor.userId]
      );
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  const one = path.match(PULL_ONE);
  if (one && method === "GET") {
    const org = decodeURIComponent(one[1]!);
    const repo = decodeURIComponent(one[2]!);
    const number = Number(one[3]);
    const row = await loadPull(env, org, repo, number);
    if (!row) return json({ error: "not found" }, 404);
    const headTarget = (await refTarget(env, origin, org, repo, row.head_ref)) ?? row.head_target;
    const baseTarget = await refTarget(env, origin, org, repo, row.base_ref);
    const counts = await pullCounts(env, org, repo, number);
    return json(pullJson(row, { head_target: headTarget, base_target: baseTarget, ...counts }));
  }

  if (one && method === "PATCH") {
    const org = decodeURIComponent(one[1]!);
    const repo = decodeURIComponent(one[2]!);
    const number = Number(one[3]);
    if (!actor) return json({ error: "unauthorized" }, 401);
    const row = await loadPull(env, org, repo, number);
    if (!row) return json({ error: "not found" }, 404);
    const denied = pullEditDenied(actor, row.author_user_id);
    if (denied === 403) return forbidden();
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const parsed = validatePullPatch(raw);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const title = parsed.value.title ?? row.title;
    const body = parsed.value.body ?? row.body;
    await d1Run(db, "UPDATE pulls SET title = ?, body = ? WHERE id = ?", [title, body, row.id]);
    const counts = await pullCounts(env, org, repo, number);
    return json(pullJson({ ...row, title, body }, counts));
  }

  const mergeability = path.match(PULL_MERGEABILITY);
  if (mergeability) {
    const org = decodeURIComponent(mergeability[1]!);
    const repo = decodeURIComponent(mergeability[2]!);
    const number = Number(mergeability[3]);
    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    const row = await loadPull(env, org, repo, number);
    if (!row) return json({ error: "not found" }, 404);
    const gate = await mergeGate(env, org, repo, number, origin);
    return json(mergeabilityJson(gate));
  }

  const action = path.match(PULL_ACTION);
  if (action && method === "POST") {
    if (!actor) return json({ error: "unauthorized" }, 401);
    const org = decodeURIComponent(action[1]!);
    const repo = decodeURIComponent(action[2]!);
    const number = Number(action[3]);
    const verb = action[4]!;
    const row = await loadPull(env, org, repo, number);
    if (!row) return json({ error: "not found" }, 404);
    if (row.state !== "open") return json({ error: "pull is not open" }, 409);

    if (verb === "close") {
      if (!actor.admin && actor.userId !== row.author_user_id) return forbidden();
      await d1Run(
        db,
        "UPDATE pulls SET state = 'closed' WHERE id = ?",
        [row.id]
      );
      return json(pullJson({ ...row, state: "closed" }));
    }

    if (verb === "merge") {
      const canMerge =
        actor.admin ||
        (await isRepoOwner(env, org, repo, actor.userId)) ||
        (await orgCanWrite(env, org, actor));
      if (!canMerge) return forbidden();
      const gate = await mergeGate(env, org, repo, number, origin);
      const blocked = mergeBlockReasons(gate);
      if (blocked.length > 0) {
        return json({ error: "merge blocked", reasons: blocked }, 409);
      }
      const headTarget =
        (await refTarget(env, origin, org, repo, row.head_ref)) ?? row.head_target;
      const baseTarget = await refTarget(env, origin, org, repo, row.base_ref);
      if (!baseTarget) return json({ error: "unknown base ref" }, 400);
      const parents = await changesetParents(env, origin, org, repo, headTarget);
      if (parents[0] !== baseTarget) {
        return json({ error: "head is not based on current base" }, 409);
      }
      const cas = await engineFetch(
        env,
        origin,
        `/v1/repos/${org}/${repo}/refs/${row.base_ref}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected: baseTarget, new: headTarget }),
        }
      );
      if (!cas.ok) {
        const text = await cas.text();
        return json({ error: "ref update failed", detail: text }, cas.status);
      }
      const mergedAt = nowMs();
      await d1Run(
        db,
        `UPDATE pulls SET state = 'merged', merged_by = ?, merged_at = ?, head_target = ?
          WHERE id = ?`,
        [actor.userId, mergedAt, headTarget, row.id]
      );
      return json(
        pullJson({
          ...row,
          state: "merged",
          head_target: headTarget,
          merged_by: actor.userId,
          merged_at: mergedAt,
        })
      );
    }
  }

  if (one || action || files || comments || commentOne || approvals || mergeability) {
    return json({ error: "method not allowed" }, 405);
  }
  return null;
}
