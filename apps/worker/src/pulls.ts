import { d1All, d1Run, nowMs, uuid } from "./db";
import type { Actor } from "./authz";
import { forbidden, orgCanWrite } from "./authz";

const TITLE_MAX = 120;
const BODY_MAX = 10_000;

type Env = {
  DB_SCIONHUB_TOP: D1Database;
  ENGINE: DurableObjectNamespace;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function dbTop(env: Env): D1Database {
  const db = env.DB_SCIONHUB_TOP;
  if (!db) throw new Error("no D1 binding DB_SCIONHUB_TOP");
  return db;
}

export function engineFetch(env: Env, origin: URL, path: string, init: RequestInit): Promise<Response> {
  const id = env.ENGINE.idFromName("filecoin-project");
  const stub = env.ENGINE.get(id);
  const u = new URL(origin.toString());
  u.pathname = "/orgs/filecoin-project" + path;
  u.search = "";
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

/** Handle `/v1/repos/{org}/{repo}/pulls...`. Returns null if the path is not a pulls route. */
export async function handlePulls(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const origin = new URL(request.url);
  const db = dbTop(env);

  const list = path.match(PULLS_LIST);
  if (list) {
    const org = decodeURIComponent(list[1]!);
    const repo = decodeURIComponent(list[2]!);
    if (method === "GET") {
      const rows = await d1All<PullRow>(
        db,
        `SELECT p.*, u.name as author_name
           FROM pulls p LEFT JOIN users u ON u.id = p.author_user_id
          WHERE p.org = ? AND p.repo = ?
          ORDER BY p.number DESC`,
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
    const rows = await d1All<PullRow>(
      db,
      `SELECT p.*, u.name as author_name
         FROM pulls p LEFT JOIN users u ON u.id = p.author_user_id
        WHERE p.org = ? AND p.repo = ? AND p.number = ?
        LIMIT 1`,
      [org, repo, number]
    );
    const row = rows[0];
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
    return resp;
  }

  const one = path.match(PULL_ONE);
  if (one && method === "GET") {
    const org = decodeURIComponent(one[1]!);
    const repo = decodeURIComponent(one[2]!);
    const number = Number(one[3]);
    const rows = await d1All<PullRow>(
      db,
      `SELECT p.*, u.name as author_name
         FROM pulls p LEFT JOIN users u ON u.id = p.author_user_id
        WHERE p.org = ? AND p.repo = ? AND p.number = ?
        LIMIT 1`,
      [org, repo, number]
    );
    const row = rows[0];
    if (!row) return json({ error: "not found" }, 404);
    const headTarget = (await refTarget(env, origin, org, repo, row.head_ref)) ?? row.head_target;
    const baseTarget = await refTarget(env, origin, org, repo, row.base_ref);
    return json(pullJson(row, { head_target: headTarget, base_target: baseTarget }));
  }

  const action = path.match(PULL_ACTION);
  if (action && method === "POST") {
    if (!actor) return json({ error: "unauthorized" }, 401);
    const org = decodeURIComponent(action[1]!);
    const repo = decodeURIComponent(action[2]!);
    const number = Number(action[3]);
    const verb = action[4]!;
    const rows = await d1All<PullRow>(
      db,
      `SELECT p.*, u.name as author_name
         FROM pulls p LEFT JOIN users u ON u.id = p.author_user_id
        WHERE p.org = ? AND p.repo = ? AND p.number = ?
        LIMIT 1`,
      [org, repo, number]
    );
    const row = rows[0];
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
      if (!(await orgCanWrite(env, org, actor))) return forbidden();
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

  if (one || action || files) return json({ error: "method not allowed" }, 405);
  return null;
}
