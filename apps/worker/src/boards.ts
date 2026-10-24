import { d1All, d1Run, dbOrgs, nowMs, uuid, type D1Env } from "./db";
import type { Actor } from "./authz";
import { emitEvent } from "./webhooks";
import { issueJson, type IssueRow } from "./issues";

type Env = D1Env & { waitUntil?: (p: Promise<unknown>) => void };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export type BoardRow = {
  id: string;
  org: string;
  repo: string;
  name: string;
  tag_filter: string | null;
  state_filter: string; // open|closed|all
  sort_order: number;
  created_at: number;
  updated_at: number;
};

function boardJson(r: BoardRow) {
  return {
    id: r.id,
    org: r.org,
    repo: r.repo,
    name: r.name,
    tag: r.tag_filter,
    state: r.state_filter,
    sort: r.sort_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const BOARDS_LIST = /^\/v1\/repos\/([^/]+)\/([^/]+)\/boards$/;
const BOARD_ONE = /^\/v1\/repos\/([^/]+)\/([^/]+)\/boards\/([^/]+)$/;

/** Handle `/v1/repos/{org}/{repo}/boards...`. Returns null when not a matching route. */
export async function handleBoards(request: Request, env: Env, path: string, actor: Actor | null): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const db = dbOrgs(env);

  const list = path.match(BOARDS_LIST);
  if (list) {
    const org = decodeURIComponent(list[1]!);
    const repo = decodeURIComponent(list[2]!);
    if (method === "GET") {
      const rows = await d1All<BoardRow>(db, "SELECT * FROM boards WHERE org = ? AND repo = ? ORDER BY sort_order ASC, updated_at DESC", [org, repo]);
      return json({ boards: rows.map(boardJson) });
    }
    if (method === "POST") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const nameRaw = typeof body.name === "string" ? body.name.trim() : "";
      if (!nameRaw) return json({ error: "name is required" }, 400);
      if (nameRaw.length > 64) return json({ error: "name too long" }, 400);
      const tag = typeof body.tag === "string" ? (body.tag.trim() || null) : null;
      const state = typeof body.state === "string" && ["open", "closed", "all"].includes(body.state) ? (body.state as "open" | "closed" | "all") : "open";
      const sort = typeof body.sort === "number" && Number.isInteger(body.sort) ? (body.sort as number) : 0;
      const id = uuid();
      const t = nowMs();
      await d1Run(
        db,
        `INSERT INTO boards (id, org, repo, name, tag_filter, state_filter, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, org, repo, nameRaw, tag, state, sort, t, t]
      );
      const row = (await d1All<BoardRow>(db, "SELECT * FROM boards WHERE id = ? LIMIT 1", [id]))[0]!;
      return json(boardJson(row), 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  const one = path.match(BOARD_ONE);
  if (one) {
    const org = decodeURIComponent(one[1]!);
    const repo = decodeURIComponent(one[2]!);
    const name = decodeURIComponent(one[3]!);
    if (method === "GET") {
      const rows = await d1All<BoardRow>(db, "SELECT * FROM boards WHERE org = ? AND repo = ? AND name = ? LIMIT 1", [org, repo, name]);
      const row = rows[0];
      if (!row) return json({ error: "not found" }, 404);
      // Filter issues per board
      const url = new URL(request.url);
      const state = (url.searchParams.get("state") as "open" | "closed" | "all" | null) ?? null;
      const want = state && ["open", "closed", "all"].includes(state) ? state : (row.state_filter as "open" | "closed" | "all");
      let issues: IssueRow[] = [];
      if (row.tag_filter) {
        if (want === "all") {
          issues = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? AND tag = ? ORDER BY number DESC", [org, repo, row.tag_filter]);
        } else {
          issues = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? AND tag = ? AND state = ? ORDER BY number DESC", [org, repo, row.tag_filter, want]);
        }
      } else {
        if (want === "all") {
          issues = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? ORDER BY number DESC", [org, repo]);
        } else {
          issues = await d1All<IssueRow>(db, "SELECT * FROM issues WHERE org = ? AND repo = ? AND state = ? ORDER BY number DESC", [org, repo, want]);
        }
      }
      return json({ board: boardJson(row), issues: issues.map(issueJson) });
    }
    if (method === "PATCH") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      const rows = await d1All<BoardRow>(db, "SELECT * FROM boards WHERE org = ? AND repo = ? AND name = ? LIMIT 1", [org, repo, name]);
      const row = rows[0];
      if (!row) return json({ error: "not found" }, 404);
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const tag = body.tag === undefined ? row.tag_filter : typeof body.tag === "string" ? (body.tag.trim() || null) : row.tag_filter;
      const state =
        body.state === undefined || typeof body.state !== "string" || !["open", "closed", "all"].includes(body.state)
          ? row.state_filter
          : (body.state as string);
      const sort =
        body.sort === undefined || typeof body.sort !== "number" || !Number.isInteger(body.sort) ? row.sort_order : (body.sort as number);
      const t = nowMs();
      await d1Run(db, "UPDATE boards SET tag_filter = ?, state_filter = ?, sort_order = ?, updated_at = ? WHERE id = ?", [tag, state, sort, t, row.id]);
      const updated = (await d1All<BoardRow>(db, "SELECT * FROM boards WHERE id = ? LIMIT 1", [row.id]))[0]!;
      return json(boardJson(updated));
    }
    if (method === "DELETE") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      await d1Run(db, "DELETE FROM boards WHERE org = ? AND repo = ? AND name = ?", [org, repo, name]);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}

