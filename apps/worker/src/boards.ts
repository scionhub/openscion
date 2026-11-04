import { d1All, d1Run, dbOrgs, dbTop, nowMs, uuid, type D1Env } from "./db";
import type { Actor } from "./authz";
import { forbidden, orgCanAdmin } from "./authz";
import { issueJson, type IssueRow } from "./issues";

type Env = D1Env;

const NAME_MAX = 64;
const SOURCES_MAX = 50;
const ISSUES_MAX = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export type BoardSource = {
  org: string;
  repo: string | null;
};

export type BoardRow = {
  id: string;
  org: string;
  name: string;
  tag_filter: string | null;
  state_filter: string;
  sources: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export function parseBoardName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "name is required" };
  const name = raw.trim();
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > NAME_MAX) return { ok: false, error: "name too long" };
  if (name.includes("/")) return { ok: false, error: "name must not contain /" };
  return { ok: true, value: name };
}

export function parseStateFilter(raw: unknown): { ok: true; value: "open" | "closed" | "all" } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, value: "open" };
  if (raw === "open" || raw === "closed" || raw === "all") return { ok: true, value: raw };
  return { ok: false, error: "state must be open, closed, or all" };
}

/** Parse a sources allowlist. `null` / `[]` means every org the caller can see. */
export function parseSources(raw: unknown): { ok: true; value: BoardSource[] | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, error: "sources must be an array" };
  if (raw.length === 0) return { ok: true, value: null };
  const out: BoardSource[] = [];
  for (const item of raw.slice(0, SOURCES_MAX)) {
    if (typeof item === "string") {
      const s = item.trim();
      if (!s) return { ok: false, error: "source org is required" };
      const slash = s.indexOf("/");
      if (slash < 0) {
        out.push({ org: s, repo: null });
        continue;
      }
      const org = s.slice(0, slash).trim();
      const repo = s.slice(slash + 1).trim();
      if (!org || !repo) return { ok: false, error: "source must be org or org/repo" };
      out.push({ org, repo });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "sources must be objects or strings" };
    }
    const rec = item as { org?: unknown; repo?: unknown };
    const org = typeof rec.org === "string" ? rec.org.trim() : "";
    if (!org) return { ok: false, error: "source org is required" };
    const repo = typeof rec.repo === "string" && rec.repo.trim() ? rec.repo.trim() : null;
    out.push({ org, repo });
  }
  return { ok: true, value: out };
}

export function decodeSources(raw: string | null | undefined): BoardSource[] | null {
  if (!raw) return null;
  try {
    const parsed = parseSources(JSON.parse(raw) as unknown);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

/**
 * Private repos are hidden unless the actor is a site admin or can write the
 * issue's org. Missing catalog rows and `public` repos are visible (PoC has
 * no private repos yet).
 */
export function issueVisible(
  issue: { org: string; repo: string },
  privateRepos: Set<string>,
  writableOrgs: Set<string>,
  isAdmin: boolean
): boolean {
  if (isAdmin) return true;
  if (!privateRepos.has(`${issue.org}/${issue.repo}`)) return true;
  return writableOrgs.has(issue.org);
}

function boardJson(r: BoardRow) {
  return {
    id: r.id,
    org: r.org,
    name: r.name,
    tag: r.tag_filter,
    state: r.state_filter,
    sources: decodeSources(r.sources),
    sort: r.sort_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function sourcesSql(sources: BoardSource[] | null): { sql: string; params: unknown[] } {
  if (!sources || sources.length === 0) return { sql: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const s of sources) {
    if (s.repo) {
      clauses.push("(org = ? AND repo = ?)");
      params.push(s.org, s.repo);
    } else {
      clauses.push("org = ?");
      params.push(s.org);
    }
  }
  return { sql: ` AND (${clauses.join(" OR ")})`, params };
}

async function loadPrivateRepos(env: Env): Promise<Set<string>> {
  try {
    const rows = await d1All<{ id: string }>(dbOrgs(env), "SELECT id FROM repos WHERE visibility = 'private'");
    return new Set(rows.map((r) => r.id));
  } catch {
    return new Set();
  }
}

async function loadWritableOrgs(env: Env, actor: Actor | null): Promise<Set<string>> {
  const out = new Set<string>();
  if (!actor) return out;
  out.add(actor.name);
  try {
    const rows = await d1All<{ org_id: string }>(
      dbTop(env),
      `SELECT org_id FROM memberships
        WHERE user_id = ? AND (role = 'owner' OR role = 'admin' OR can_write = 1)`,
      [actor.userId]
    );
    for (const r of rows) out.add(r.org_id);
  } catch {
    /* memberships may be missing on older DBs */
  }
  return out;
}

async function loadBoardIssues(
  env: Env,
  row: BoardRow,
  stateOverride: string | null,
  actor: Actor | null
): Promise<ReturnType<typeof issueJson>[]> {
  const parsedState = parseStateFilter(stateOverride ?? row.state_filter);
  const want = parsedState.ok ? parsedState.value : (row.state_filter as "open" | "closed" | "all");
  const sources = decodeSources(row.sources);
  const src = sourcesSql(sources);
  const params: unknown[] = [];
  let sql = "SELECT * FROM issues WHERE 1 = 1";
  if (want !== "all") {
    sql += " AND state = ?";
    params.push(want);
  }
  if (row.tag_filter) {
    sql += " AND tag = ?";
    params.push(row.tag_filter);
  }
  sql += src.sql;
  params.push(...src.params);
  sql += " ORDER BY org ASC, repo ASC, number DESC LIMIT ?";
  params.push(ISSUES_MAX);
  const rows = await d1All<IssueRow>(dbOrgs(env), sql, params);
  const privateRepos = await loadPrivateRepos(env);
  const writable = await loadWritableOrgs(env, actor);
  const isAdmin = actor?.admin === true;
  return rows.filter((i) => issueVisible(i, privateRepos, writable, isAdmin)).map(issueJson);
}

async function findBoard(env: Env, org: string, nameOrId: string): Promise<BoardRow | null> {
  const db = dbOrgs(env);
  const byName = await d1All<BoardRow>(db, "SELECT * FROM boards WHERE org = ? AND name = ? LIMIT 1", [org, nameOrId]);
  if (byName[0]) return byName[0];
  const byId = await d1All<BoardRow>(db, "SELECT * FROM boards WHERE org = ? AND id = ? LIMIT 1", [org, nameOrId]);
  return byId[0] ?? null;
}

const BOARDS_LIST = /^\/v1\/orgs\/([^/]+)\/boards$/;
const BOARD_ONE = /^\/v1\/orgs\/([^/]+)\/boards\/([^/]+)$/;

/** Handle `/v1/orgs/{org}/boards...`. Returns null when not a matching route. */
export async function handleBoards(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const db = dbOrgs(env);

  const list = path.match(BOARDS_LIST);
  if (list) {
    const org = decodeURIComponent(list[1]!);
    if (method === "GET") {
      const rows = await d1All<BoardRow>(
        db,
        "SELECT * FROM boards WHERE org = ? ORDER BY sort_order ASC, updated_at DESC",
        [org]
      );
      return json({ boards: rows.map(boardJson) });
    }
    if (method === "POST") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      if (!(await orgCanAdmin(env, org, actor))) return forbidden();
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const name = parseBoardName(body.name);
      if (!name.ok) return json({ error: name.error }, 400);
      const tag = typeof body.tag === "string" ? body.tag.trim().slice(0, 64) || null : null;
      const state = parseStateFilter(body.state);
      if (!state.ok) return json({ error: state.error }, 400);
      const sources = parseSources(body.sources);
      if (!sources.ok) return json({ error: sources.error }, 400);
      const sort = typeof body.sort === "number" && Number.isInteger(body.sort) ? body.sort : 0;
      const existing = await d1All<{ id: string }>(db, "SELECT id FROM boards WHERE org = ? AND name = ? LIMIT 1", [
        org,
        name.value,
      ]);
      if (existing[0]) return json({ error: "board exists" }, 409);
      const id = uuid();
      const t = nowMs();
      await d1Run(
        db,
        `INSERT INTO boards (id, org, name, tag_filter, state_filter, sources, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, org, name.value, tag, state.value, sources.value ? JSON.stringify(sources.value) : null, sort, t, t]
      );
      const row = (await d1All<BoardRow>(db, "SELECT * FROM boards WHERE id = ? LIMIT 1", [id]))[0]!;
      return json(boardJson(row), 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  const one = path.match(BOARD_ONE);
  if (one) {
    const org = decodeURIComponent(one[1]!);
    const nameOrId = decodeURIComponent(one[2]!);
    if (method === "GET") {
      const row = await findBoard(env, org, nameOrId);
      if (!row) return json({ error: "not found" }, 404);
      const url = new URL(request.url);
      const issues = await loadBoardIssues(env, row, url.searchParams.get("state"), actor);
      return json({ board: boardJson(row), issues });
    }
    if (method === "PATCH") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      if (!(await orgCanAdmin(env, org, actor))) return forbidden();
      const row = await findBoard(env, org, nameOrId);
      if (!row) return json({ error: "not found" }, 404);
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      let name = row.name;
      if (body.name !== undefined) {
        const parsed = parseBoardName(body.name);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        name = parsed.value;
        if (name !== row.name) {
          const clash = await d1All<{ id: string }>(db, "SELECT id FROM boards WHERE org = ? AND name = ? LIMIT 1", [
            org,
            name,
          ]);
          if (clash[0]) return json({ error: "board exists" }, 409);
        }
      }
      const tag =
        body.tag === undefined
          ? row.tag_filter
          : typeof body.tag === "string"
            ? body.tag.trim().slice(0, 64) || null
            : row.tag_filter;
      let state = row.state_filter;
      if (body.state !== undefined) {
        const parsed = parseStateFilter(body.state);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        state = parsed.value;
      }
      let sourcesJson = row.sources;
      if (Object.prototype.hasOwnProperty.call(body, "sources")) {
        const parsed = parseSources(body.sources);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        sourcesJson = parsed.value ? JSON.stringify(parsed.value) : null;
      }
      const sort =
        body.sort === undefined || typeof body.sort !== "number" || !Number.isInteger(body.sort)
          ? row.sort_order
          : body.sort;
      const t = nowMs();
      await d1Run(
        db,
        "UPDATE boards SET name = ?, tag_filter = ?, state_filter = ?, sources = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        [name, tag, state, sourcesJson, sort, t, row.id]
      );
      const updated = (await d1All<BoardRow>(db, "SELECT * FROM boards WHERE id = ? LIMIT 1", [row.id]))[0]!;
      return json(boardJson(updated));
    }
    if (method === "DELETE") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      if (!(await orgCanAdmin(env, org, actor))) return forbidden();
      const row = await findBoard(env, org, nameOrId);
      if (!row) return json({ error: "not found" }, 404);
      await d1Run(db, "DELETE FROM boards WHERE id = ?", [row.id]);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}
