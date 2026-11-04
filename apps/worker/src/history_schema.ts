//! Changeset graph stored beside the JSON log.
//!
//! `changeset_parents` and `changeset_paths` let log, blame, and bisect walk
//! history with SQL instead of parsing every body. Rows are filled on insert
//! and, for databases created before the index existed, by an idempotent
//! backfill on first touch (the same moment `ensureCommpSchema` migrates).

import type { RepoSql } from "./pieces";

export const DEFAULT_CHECKPOINT_EVERY = 1000;
export const DEFAULT_ARCHIVE_CHUNK_COMMITS = 10_000;
export const DEFAULT_ARCHIVE_CHUNK_BYTES = 8_000_000;
export const BLAME_CACHE_CAP = 256;
export const CHANGESET_PAGE_MAX = 1000;
export const LOG_LIMIT_MAX = 100;

export const HISTORY_DDL = [
  `CREATE TABLE IF NOT EXISTS changeset_parents (
        child TEXT NOT NULL,
        parent TEXT NOT NULL,
        ord INTEGER NOT NULL,
        PRIMARY KEY (child, ord)
      )`,
  `CREATE INDEX IF NOT EXISTS idx_changeset_parents_parent ON changeset_parents(parent)`,
  `CREATE INDEX IF NOT EXISTS idx_changeset_parents_child ON changeset_parents(child)`,
  `CREATE TABLE IF NOT EXISTS changeset_paths (
        changeset TEXT NOT NULL,
        path TEXT NOT NULL,
        op TEXT NOT NULL,
        blob TEXT,
        kind TEXT,
        PRIMARY KEY (changeset, path)
      )`,
  `CREATE INDEX IF NOT EXISTS idx_changeset_paths_path ON changeset_paths(path, changeset)`,
  `CREATE TABLE IF NOT EXISTS tree_checkpoints (
        lsn INTEGER PRIMARY KEY,
        changeset_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
  `CREATE TABLE IF NOT EXISTS tree_checkpoint_files (
        lsn INTEGER NOT NULL,
        path TEXT NOT NULL,
        blob TEXT,
        kind TEXT,
        piece_cid TEXT,
        PRIMARY KEY (lsn, path)
      )`,
  `CREATE INDEX IF NOT EXISTS idx_checkpoint_files_lsn ON tree_checkpoint_files(lsn)`,
  `CREATE TABLE IF NOT EXISTS history_archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lsn_min INTEGER NOT NULL,
        lsn_max INTEGER NOT NULL,
        first_id TEXT NOT NULL,
        last_id TEXT NOT NULL,
        piece_cid TEXT NOT NULL,
        size INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
  `CREATE INDEX IF NOT EXISTS idx_history_archives_lsn ON history_archives(lsn_min, lsn_max)`,
  `CREATE TABLE IF NOT EXISTS changeset_locate (
        id TEXT PRIMARY KEY,
        archive_id INTEGER NOT NULL,
        lsn INTEGER NOT NULL
      )`,
  `CREATE INDEX IF NOT EXISTS idx_changeset_locate_lsn ON changeset_locate(lsn)`,
  `CREATE INDEX IF NOT EXISTS idx_changeset_locate_archive ON changeset_locate(archive_id)`,
] as const;

const ALTERS = [
  `ALTER TABLE changesets ADD COLUMN author TEXT`,
  `ALTER TABLE changesets ADD COLUMN message TEXT`,
  `ALTER TABLE changesets ADD COLUMN committed_at INTEGER`,
  `ALTER TABLE changesets ADD COLUMN indexed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE blame_cache ADD COLUMN touched_at INTEGER NOT NULL DEFAULT 0`,
];

export type ParsedChange = {
  op: "upsert" | "delete";
  path: string;
  blob?: string;
  kind?: string;
};

export type ParsedChangeset = {
  parents: string[];
  author: string;
  message: string;
  created_at: number;
  changes: ParsedChange[];
  metadata: Record<string, string>;
};

export function parseChangesetBody(body: string): ParsedChangeset | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const parents = Array.isArray(parsed.parents)
    ? parsed.parents.filter((parent): parent is string => typeof parent === "string")
    : [];
  const changes: ParsedChange[] = [];
  if (Array.isArray(parsed.changes)) {
    for (const raw of parsed.changes) {
      if (!raw || typeof raw !== "object") continue;
      const change = raw as Record<string, unknown>;
      const op = change.op === "delete" ? "delete" : change.op === "upsert" ? "upsert" : null;
      const path = typeof change.path === "string" ? change.path : "";
      if (!op || !path) continue;
      const blob = typeof change.blob === "string" ? change.blob : undefined;
      const kind = typeof change.kind === "string" ? change.kind : undefined;
      changes.push(blob ? { op, path, blob, kind } : { op, path, kind });
    }
  }
  const metadata: Record<string, string> = {};
  if (parsed.metadata && typeof parsed.metadata === "object") {
    for (const [key, value] of Object.entries(parsed.metadata as Record<string, unknown>)) {
      if (typeof value === "string") metadata[key] = value;
    }
  }
  return {
    parents,
    author: typeof parsed.author === "string" ? parsed.author : "",
    message: typeof parsed.message === "string" ? parsed.message : "",
    created_at: Number(parsed.created_at ?? 0) || 0,
    changes,
    metadata,
  };
}

export function checkpointEvery(raw: string | number | undefined | null): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? DEFAULT_CHECKPOINT_EVERY);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CHECKPOINT_EVERY;
  return Math.floor(n);
}

export function archiveChunkCommits(raw: string | number | undefined | null): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? DEFAULT_ARCHIVE_CHUNK_COMMITS);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ARCHIVE_CHUNK_COMMITS;
  return Math.floor(n);
}

export function archiveChunkBytes(raw: string | number | undefined | null): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? DEFAULT_ARCHIVE_CHUNK_BYTES);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ARCHIVE_CHUNK_BYTES;
  return Math.floor(n);
}

async function ignore(sql: RepoSql, statement: string): Promise<void> {
  try {
    await sql.sqlRun(statement);
  } catch {
    /* column already exists */
  }
}

/** Create the graph tables and backfill any changeset the index has not seen. */
export async function ensureHistorySchema(sql: RepoSql): Promise<void> {
  for (const statement of HISTORY_DDL) await sql.sqlRun(statement);
  for (const statement of ALTERS) await ignore(sql, statement);
  await backfillHistory(sql);
}

export async function indexChangeset(
  sql: RepoSql,
  row: { id: string; lsn: number; body: string }
): Promise<void> {
  const parsed = parseChangesetBody(row.body);
  if (!parsed) return;
  await sql.sqlRun(`DELETE FROM changeset_parents WHERE child = ?`, [row.id]);
  await sql.sqlRun(`DELETE FROM changeset_paths WHERE changeset = ?`, [row.id]);
  for (let ord = 0; ord < parsed.parents.length; ord++) {
    await sql.sqlRun(`INSERT OR REPLACE INTO changeset_parents (child, parent, ord) VALUES (?, ?, ?)`, [
      row.id,
      parsed.parents[ord],
      ord,
    ]);
  }
  for (const change of parsed.changes) {
    await sql.sqlRun(
      `INSERT OR REPLACE INTO changeset_paths (changeset, path, op, blob, kind) VALUES (?, ?, ?, ?, ?)`,
      [row.id, change.path, change.op, change.blob ?? null, change.kind ?? null]
    );
  }
  await sql.sqlRun(
    `UPDATE changesets SET author = ?, message = ?, committed_at = ?, indexed = 1 WHERE id = ?`,
    [parsed.author, parsed.message, parsed.created_at, row.id]
  );
}

/** Idempotent. Safe to call on every request; already-indexed rows are skipped. */
export async function backfillHistory(sql: RepoSql): Promise<number> {
  let indexed = 0;
  for (;;) {
    const rows = await sql.sqlAll<{ id: string; lsn: number; body: string }>(
      `SELECT id, lsn, body FROM changesets WHERE COALESCE(indexed, 0) = 0 ORDER BY lsn ASC LIMIT 400`
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      await indexChangeset(sql, row);
      indexed += 1;
    }
  }
  return indexed;
}

/**
 * One row per path (the latest tip) and at most {@link BLAME_CACHE_CAP} paths.
 * Older tips for the same path are dropped on write.
 */
export async function writeBlameCache(
  sql: RepoSql,
  path: string,
  tip: string,
  body: string,
  now = Date.now()
): Promise<void> {
  await sql.sqlRun(`DELETE FROM blame_cache WHERE path = ?`, [path]);
  await sql.sqlRun(`INSERT INTO blame_cache (path, tip, body, touched_at) VALUES (?, ?, ?, ?)`, [
    path,
    tip,
    body,
    now,
  ]);
  await sql.sqlRun(
    `DELETE FROM blame_cache WHERE rowid NOT IN (
        SELECT rowid FROM blame_cache ORDER BY touched_at DESC LIMIT ?
      )`,
    [BLAME_CACHE_CAP]
  );
}

export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function likePrefix(path: string): string {
  return `${path.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`;
}
