//! Single-database history queries. Each statement is a parent walk with LIMIT.
//!
//! Callers that cross an archive boundary run the same query on the next
//! database. Rows that leave this module are the page, not the whole log.

import type { RepoSql } from "./pieces";
import { LOG_LIMIT_MAX, likeContains, likePrefix, parseChangesetBody } from "./history_schema";

export type LogArgs = {
  tip: string;
  path?: string;
  author?: string;
  since?: number;
  until?: number;
  grep?: string;
  limit: number;
  cursor?: string;
  /** Resolved cursor, so a page can continue in an older database. */
  keyset?: { at: number; id: string };
};

export type LogRow = {
  id: string;
  author: string;
  message: string;
  created_at: number;
  parents: string[];
  paths: string[];
};

export type LogPage = { commits: LogRow[]; next_cursor: string | null; scanned: number };

const WALK = `
WITH RECURSIVE walk(id, depth) AS (
  SELECT ?, 0
  UNION
  SELECT p.parent, walk.depth + 1
  FROM walk
  JOIN changeset_parents p ON p.child = walk.id
  WHERE walk.depth < ?
)
`;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 20;
  return Math.min(LOG_LIMIT_MAX, Math.floor(limit));
}

async function parentsOf(sql: RepoSql, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = await sql.sqlAll<{ child: string; parent: string; ord: number }>(
    `SELECT child, parent, ord FROM changeset_parents WHERE child IN (${marks}) ORDER BY child, ord`,
    ids
  );
  for (const row of rows) {
    const list = out.get(String(row.child)) ?? [];
    list.push(String(row.parent));
    out.set(String(row.child), list);
  }
  return out;
}

async function pathsOf(sql: RepoSql, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = await sql.sqlAll<{ changeset: string; path: string }>(
    `SELECT changeset, path FROM changeset_paths WHERE changeset IN (${marks}) ORDER BY path`,
    ids
  );
  for (const row of rows) {
    const list = out.get(String(row.changeset)) ?? [];
    list.push(String(row.path));
    out.set(String(row.changeset), list);
  }
  return out;
}

/**
 * Newest-first page of commits reachable from `tip` that live in this database.
 * `continueFrom` is a parent id stored only in an older database, when the walk
 * stopped at the edge of this one before filling the page.
 */
export async function queryLog(
  sql: RepoSql,
  args: LogArgs
): Promise<LogPage & { continueFrom: string | null }> {
  const limit = clampLimit(args.limit);
  const path = args.path?.replace(/^\/+|\/+$/g, "") ?? "";
  const filters: string[] = [];
  const params: unknown[] = [args.tip, 1_000_000];
  if (path) {
    filters.push(
      `EXISTS (SELECT 1 FROM changeset_paths cp WHERE cp.changeset = c.id AND (cp.path = ? OR cp.path LIKE ? ESCAPE '\\'))`
    );
    params.push(path, likePrefix(path));
  }
  if (args.author) {
    filters.push(`LOWER(COALESCE(c.author, '')) LIKE LOWER(?) ESCAPE '\\'`);
    params.push(likeContains(args.author));
  }
  if (args.grep) {
    filters.push(`LOWER(COALESCE(c.message, '')) LIKE LOWER(?) ESCAPE '\\'`);
    params.push(likeContains(args.grep));
  }
  if (args.since != null) {
    filters.push(`COALESCE(c.committed_at, 0) >= ?`);
    params.push(args.since);
  }
  if (args.until != null) {
    filters.push(`COALESCE(c.committed_at, 0) <= ?`);
    params.push(args.until);
  }
  let keyset = args.keyset;
  if (!keyset && args.cursor) {
    const cursor = await sql.sqlOne<{ committed_at: number; id: string }>(
      `SELECT COALESCE(committed_at, 0) AS committed_at, id FROM changesets WHERE id = ? LIMIT 1`,
      [args.cursor]
    );
    if (cursor) keyset = { at: Number(cursor.committed_at), id: String(cursor.id) };
  }
  if (keyset) {
    filters.push(`(COALESCE(c.committed_at, 0) < ? OR (COALESCE(c.committed_at, 0) = ? AND c.id > ?))`);
    params.push(keyset.at, keyset.at, keyset.id);
  }
  const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
  params.push(limit + 1);
  const rows = await sql.sqlAll<{ id: string; author: string | null; message: string | null; committed_at: number | null }>(
    `${WALK}
     SELECT c.id AS id, c.author AS author, c.message AS message, COALESCE(c.committed_at, 0) AS committed_at
       FROM walk
       JOIN changesets c ON c.id = walk.id
      WHERE 1 = 1 ${where}
      ORDER BY committed_at DESC, c.id ASC
      LIMIT ?`,
    params
  );
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const ids = page.map((row) => String(row.id));
  const parents = await parentsOf(sql, ids);
  const paths = await pathsOf(sql, ids);
  const commits: LogRow[] = page.map((row) => ({
    id: String(row.id),
    author: row.author == null ? "" : String(row.author),
    message: row.message == null ? "" : String(row.message),
    created_at: Number(row.committed_at ?? 0),
    parents: parents.get(String(row.id)) ?? [],
    paths: paths.get(String(row.id)) ?? [],
  }));
  const edge = await boundaryParent(sql, args.tip);
  return {
    commits,
    next_cursor: more && commits.length ? commits[commits.length - 1]!.id : null,
    scanned: rows.length,
    continueFrom: more ? null : edge,
  };
}

/** Parent id just outside this database, walking every parent from `start`. */
export async function boundaryParent(sql: RepoSql, start: string): Promise<string | null> {
  const row = await sql.sqlOne<{ parent: string }>(
    `WITH RECURSIVE walk(id, depth) AS (
        SELECT ?1, 0
        UNION
        SELECT p.parent, walk.depth + 1
        FROM walk
        JOIN changeset_parents p ON p.child = walk.id
        JOIN changesets c ON c.id = walk.id
        WHERE walk.depth < 1000000
      )
      SELECT p.parent AS parent
        FROM walk
        JOIN changeset_parents p ON p.child = walk.id
        LEFT JOIN changesets c ON c.id = p.parent
       WHERE c.id IS NULL
       ORDER BY walk.depth DESC
       LIMIT 1`,
    [start]
  );
  return row?.parent ? String(row.parent) : null;
}

export type ShowRow = {
  id: string;
  lsn: number;
  root_tree: string;
  author: string;
  message: string;
  created_at: number;
  parents: string[];
  changes: { op: string; path: string; blob?: string; kind?: string }[];
  priors: { path: string; op: string; blob: string | null }[];
};

export async function queryShow(sql: RepoSql, id: string): Promise<ShowRow | null> {
  const row = await sql.sqlOne<{
    id: string;
    lsn: number;
    root_tree: string;
    body: string;
    author: string | null;
    message: string | null;
    committed_at: number | null;
  }>(
    `SELECT id, lsn, root_tree, body, author, message, committed_at FROM changesets WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!row) return null;
  const parsed = parseChangesetBody(String(row.body));
  const parents = parsed?.parents ?? [];
  const changes = parsed?.changes ?? [];
  const paths = changes.map((change) => change.path);
  const priors = await queryPriors(sql, parents[0] ?? null, paths);
  return {
    id: String(row.id),
    lsn: Number(row.lsn),
    root_tree: String(row.root_tree),
    author: row.author == null ? parsed?.author ?? "" : String(row.author),
    message: row.message == null ? parsed?.message ?? "" : String(row.message),
    created_at: Number(row.committed_at ?? parsed?.created_at ?? 0),
    parents,
    changes,
    priors,
  };
}

export async function queryPriors(
  sql: RepoSql,
  parent: string | null,
  paths: string[]
): Promise<{ path: string; op: string; blob: string | null }[]> {
  if (!parent || paths.length === 0) return [];
  const marks = paths.map(() => "?").join(",");
  const rows = await sql.sqlAll<{ path: string; op: string; blob: string | null; depth: number }>(
    `WITH RECURSIVE walk(id, depth) AS (
        SELECT ?1, 0
        UNION ALL
        SELECT p.parent, walk.depth + 1
        FROM walk
        JOIN changeset_parents p ON p.child = walk.id AND p.ord = 0
        JOIN changesets c ON c.id = walk.id
        WHERE walk.depth < 1000000
      )
      SELECT cp.path AS path, cp.op AS op, cp.blob AS blob, walk.depth AS depth
        FROM walk
        JOIN changeset_paths cp ON cp.changeset = walk.id
       WHERE cp.path IN (${marks})
       ORDER BY walk.depth ASC`,
    [parent, ...paths]
  );
  const seen = new Set<string>();
  const out: { path: string; op: string; blob: string | null }[] = [];
  for (const row of rows) {
    const path = String(row.path);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, op: String(row.op), blob: row.blob == null ? null : String(row.blob) });
  }
  return out;
}

export type BlameTouch = { id: string; author: string; op: string; blob: string | null; depth: number };

/** Commits on the first-parent chain in this database that touch `path`, oldest first. */
export async function queryBlameTouches(
  sql: RepoSql,
  tip: string,
  path: string
): Promise<{ touches: BlameTouch[]; continueFrom: string | null }> {
  const rows = await sql.sqlAll<{ id: string; author: string | null; op: string; blob: string | null; depth: number }>(
    `WITH RECURSIVE walk(id, depth) AS (
        SELECT ?1, 0
        UNION ALL
        SELECT p.parent, walk.depth + 1
        FROM walk
        JOIN changeset_parents p ON p.child = walk.id AND p.ord = 0
        JOIN changesets c ON c.id = walk.id
        WHERE walk.depth < 1000000
      )
      SELECT c.id AS id, c.author AS author, cp.op AS op, cp.blob AS blob, walk.depth AS depth
        FROM walk
        JOIN changesets c ON c.id = walk.id
        JOIN changeset_paths cp ON cp.changeset = c.id AND cp.path = ?2
       ORDER BY walk.depth DESC`,
    [tip, path]
  );
  const edge = await boundaryParent(sql, tip);
  return {
    touches: rows.map((row) => ({
      id: String(row.id),
      author: row.author == null ? "" : String(row.author),
      op: String(row.op),
      blob: row.blob == null ? null : String(row.blob),
      depth: Number(row.depth),
    })),
    continueFrom: edge,
  };
}

/** First-parent ids from `bad` back toward `good`, newest first, excluding `good`. */
export async function queryFirstParent(
  sql: RepoSql,
  bad: string,
  good: string,
  limit: number
): Promise<{ ids: string[]; reachedGood: boolean; continueFrom: string | null }> {
  const rows = await sql.sqlAll<{ id: string; depth: number }>(
    `WITH RECURSIVE walk(id, depth) AS (
        SELECT ?1, 0
        UNION ALL
        SELECT p.parent, walk.depth + 1
        FROM walk
        JOIN changeset_parents p ON p.child = walk.id AND p.ord = 0
        JOIN changesets c ON c.id = p.parent
        WHERE walk.id != ?2 AND walk.depth < 1000000
        LIMIT ?3
      )
      SELECT id, depth FROM walk ORDER BY depth ASC`,
    [bad, good, limit]
  );
  const ids = rows.map((row) => String(row.id)).filter((id) => id !== good);
  if (rows.some((row) => String(row.id) === good)) {
    return { ids, reachedGood: true, continueFrom: null };
  }
  const oldest = ids[ids.length - 1];
  if (!oldest) return { ids, reachedGood: bad === good, continueFrom: null };
  const parent = await sql.sqlOne<{ parent: string }>(
    `SELECT parent FROM changeset_parents WHERE child = ? AND ord = 0 LIMIT 1`,
    [oldest]
  );
  if (!parent) return { ids, reachedGood: false, continueFrom: null };
  if (String(parent.parent) === good) return { ids, reachedGood: true, continueFrom: null };
  return { ids, reachedGood: false, continueFrom: String(parent.parent) };
}

export async function queryIsAncestor(sql: RepoSql, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  const row = await sql.sqlOne<{ ok: number }>(
    `WITH RECURSIVE walk(id, depth) AS (
        SELECT ?1, 0
        UNION
        SELECT p.parent, walk.depth + 1
        FROM walk
        JOIN changeset_parents p ON p.child = walk.id
        JOIN changesets c ON c.id = walk.id
        WHERE walk.depth < 1000000 AND walk.id != ?2
      )
      SELECT 1 AS ok FROM walk WHERE id = ?2 LIMIT 1`,
    [descendant, ancestor]
  );
  return !!row;
}

/** Shallowest ancestor of `a` that is also an ancestor of `b` (the walk's merge-base). */
export async function queryMergeBase(sql: RepoSql, a: string, b: string): Promise<string | null> {
  if (a === b) return a;
  const row = await sql.sqlOne<{ id: string }>(
    `WITH RECURSIVE wa(id, depth) AS (
        SELECT ?1, 0
        UNION
        SELECT p.parent, wa.depth + 1
        FROM wa
        JOIN changeset_parents p ON p.child = wa.id
        JOIN changesets c ON c.id = wa.id
        WHERE wa.depth < 1000000
      ),
      wb(id) AS (
        SELECT ?2
        UNION
        SELECT p.parent
        FROM wb
        JOIN changeset_parents p ON p.child = wb.id
        JOIN changesets c ON c.id = wb.id
      )
      SELECT wa.id AS id FROM wa JOIN wb ON wb.id = wa.id
      ORDER BY wa.depth ASC
      LIMIT 1`,
    [a, b]
  );
  return row?.id ? String(row.id) : null;
}

export async function queryHave(sql: RepoSql, ids: string[]): Promise<string[]> {
  const present: string[] = [];
  const size = 80;
  for (let i = 0; i < ids.length; i += size) {
    const slice = ids.slice(i, i + size);
    if (slice.length === 0) continue;
    const marks = slice.map(() => "?").join(",");
    const rows = await sql.sqlAll<{ id: string }>(
      `SELECT id FROM changesets WHERE id IN (${marks})
       UNION
       SELECT id FROM changeset_locate WHERE id IN (${marks})`,
      [...slice, ...slice]
    );
    for (const row of rows) present.push(String(row.id));
  }
  return present;
}

export async function minLiveLsn(sql: RepoSql): Promise<number | null> {
  const row = await sql.sqlOne<{ lsn: number }>(`SELECT MIN(lsn) AS lsn FROM changesets`);
  if (!row || row.lsn == null) return null;
  return Number(row.lsn);
}

export async function changesetByLsn(
  sql: RepoSql,
  lsn: number
): Promise<{ id: string; lsn: number; root_tree: string; author: string; message: string; created_at: number } | null> {
  const row = await sql.sqlOne<{
    id: string;
    lsn: number;
    root_tree: string;
    author: string | null;
    message: string | null;
    committed_at: number | null;
  }>(
    `SELECT id, lsn, root_tree, author, message, committed_at FROM changesets WHERE lsn = ? LIMIT 1`,
    [lsn]
  );
  if (!row) return null;
  return {
    id: String(row.id),
    lsn: Number(row.lsn),
    root_tree: String(row.root_tree),
    author: row.author == null ? "" : String(row.author),
    message: row.message == null ? "" : String(row.message),
    created_at: Number(row.committed_at ?? 0),
  };
}
