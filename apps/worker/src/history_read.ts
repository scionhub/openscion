//! History reads over the live database and any archive chunk they spill into.
//!
//! The live walk is the same SQL as a single database. When a parent id is not
//! in the live tables, the id is resolved through `changeset_locate`, that
//! piece is opened, and the walk continues. Checkpoints sit on chunk
//! boundaries, so a historical tree touches at most one archive.

import { archiveHistory, openArchive, planArchiveChunks, type ArchiveRecord, type PieceStore } from "./archive";
import { directoryEntries, snapshotAt, type DirEntry, type SnapFile } from "./checkpoints";
import { blameLines, showDiff, type HistoryCommit } from "./history";
import {
  minLiveLsn,
  queryBlameTouches,
  queryFirstParent,
  queryHave,
  queryIsAncestor,
  queryLog,
  queryPriors,
  queryShow,
  type LogArgs,
  type LogPage,
  type LogRow,
} from "./history_query";
import { lookupRefNames } from "./browse";
import {
  archiveChunkBytes,
  archiveChunkCommits,
  checkpointEvery,
  ensureHistorySchema,
  indexChangeset,
  parseChangesetBody,
} from "./history_schema";
import type { RepoSql } from "./pieces";
import { backfillCheckpoints, ensureCheckpointAt } from "./checkpoints";

const ID_RE = /^[0-9a-f]{64}$/;

export type HistorySource = {
  sql: RepoSql;
  store: PieceStore;
  every?: number;
};

type Db = { sql: RepoSql; close(): void };

async function liveDb(source: HistorySource): Promise<Db> {
  return { sql: source.sql, close() {} };
}

async function dbForId(source: HistorySource, id: string): Promise<Db> {
  const live = await source.sql.sqlOne<{ id: string }>(`SELECT id FROM changesets WHERE id = ? LIMIT 1`, [id]);
  if (live) return liveDb(source);
  const located = await source.sql.sqlOne<{ piece_cid: string }>(
    `SELECT a.piece_cid AS piece_cid
       FROM changeset_locate l
       JOIN history_archives a ON a.id = l.archive_id
      WHERE l.id = ?
      LIMIT 1`,
    [id]
  );
  if (!located) return liveDb(source);
  const opened = await openArchive(source.store, String(located.piece_cid));
  return opened;
}

export async function resolveTipId(source: HistorySource, name: string): Promise<string | null> {
  if (ID_RE.test(name)) {
    const db = await dbForId(source, name);
    const row = await db.sql.sqlOne<{ id: string }>(`SELECT id FROM changesets WHERE id = ? LIMIT 1`, [name]);
    db.close();
    if (row) return name;
  }
  const names = lookupRefNames(name);
  for (const candidate of names) {
    const ref = await source.sql.sqlOne<{ target: string }>(`SELECT target FROM refs WHERE name = ? LIMIT 1`, [candidate]);
    if (ref?.target) return String(ref.target);
  }
  const bare = name.replace(/^refs\/tags\//, "");
  const tag = await source.sql.sqlOne<{ target: string }>(
    `SELECT target FROM tags WHERE name = ? OR name = ? LIMIT 1`,
    [name, bare]
  );
  return tag?.target ? String(tag.target) : null;
}

async function cursorKeyset(source: HistorySource, cursor: string): Promise<{ at: number; id: string } | undefined> {
  const db = await dbForId(source, cursor);
  try {
    const row = await db.sql.sqlOne<{ committed_at: number; id: string }>(
      `SELECT COALESCE(committed_at, 0) AS committed_at, id FROM changesets WHERE id = ? LIMIT 1`,
      [cursor]
    );
    if (!row) return undefined;
    return { at: Number(row.committed_at), id: String(row.id) };
  } finally {
    db.close();
  }
}

export async function readLog(source: HistorySource, args: LogArgs): Promise<LogPage> {
  const limit = Math.min(100, Math.max(1, args.limit || 20));
  const commits: LogRow[] = [];
  let tip = args.tip;
  const keyset = args.cursor ? await cursorKeyset(source, args.cursor) : undefined;
  const seen = new Set<string>();
  for (let guard = 0; guard < 64 && commits.length < limit; guard++) {
    const db = await dbForId(source, tip);
    try {
      const page = await queryLog(db.sql, {
        ...args,
        tip,
        limit: limit - commits.length,
        cursor: undefined,
        keyset,
      });
      for (const commit of page.commits) {
        if (seen.has(commit.id)) continue;
        seen.add(commit.id);
        commits.push(commit);
      }
      if (page.next_cursor) return { commits, next_cursor: page.next_cursor, scanned: commits.length };
      if (!page.continueFrom || seen.has(page.continueFrom)) break;
      tip = page.continueFrom;
    } finally {
      db.close();
    }
  }
  return { commits, next_cursor: null, scanned: commits.length };
}

function commitFromShow(show: {
  id: string;
  author: string;
  message: string;
  created_at: number;
  parents: string[];
  changes: { op: string; path: string; blob?: string }[];
}): HistoryCommit {
  return {
    id: show.id,
    author: show.author,
    message: show.message,
    created_at: show.created_at,
    parents: show.parents,
    changes: show.changes.map((change) => ({
      op: change.op === "delete" ? "delete" : "upsert",
      path: change.path,
      blob: change.blob,
    })),
  };
}

async function loadBlob(sql: RepoSql, id: string): Promise<string | null> {
  const row = await sql.sqlOne<{ bytes: Uint8Array | ArrayBuffer | number[] | string }>(
    `SELECT bytes FROM objects WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!row) return null;
  const raw = row.bytes;
  let bytes: Uint8Array;
  if (raw instanceof Uint8Array) bytes = raw;
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
  else if (typeof raw === "string") bytes = Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
  else if (Array.isArray(raw)) bytes = Uint8Array.from(raw);
  else return null;
  return new TextDecoder().decode(bytes);
}

export async function readShow(
  source: HistorySource,
  id: string
): Promise<{ id: string; author: string; message: string; created_at: number; parents: string[]; diff: string } | null> {
  const db = await dbForId(source, id);
  const show = await queryShow(db.sql, id);
  db.close();
  if (!show) return null;
  const priors = [...show.priors];
  const missing = new Set(show.changes.map((change) => change.path).filter((path) => !priors.some((prior) => prior.path === path)));
  let cursor = show.parents[0] ?? null;
  const seen = new Set<string>([id]);
  for (let guard = 0; guard < 64 && missing.size > 0 && cursor && !seen.has(cursor); guard++) {
    seen.add(cursor);
    const next = await dbForId(source, cursor);
    try {
      const found = await queryPriors(next.sql, cursor, [...missing]);
      for (const prior of found) {
        if (!missing.has(prior.path)) continue;
        priors.push(prior);
        missing.delete(prior.path);
      }
      const parent = await next.sql.sqlOne<{ parent: string }>(
        `SELECT parent FROM changeset_parents WHERE child = ? AND ord = 0 LIMIT 1`,
        [cursor]
      );
      cursor = parent?.parent ? String(parent.parent) : null;
    } finally {
      next.close();
    }
  }
  const blobs: Record<string, string> = {};
  const ids = new Set<string>();
  for (const change of show.changes) if (change.blob) ids.add(change.blob);
  for (const prior of priors) if (prior.blob) ids.add(prior.blob);
  for (const blob of ids) {
    const text = await loadBlob(source.sql, blob);
    if (text != null) blobs[blob] = text;
  }
  const commit = commitFromShow(show);
  const priorCommit: HistoryCommit = {
    id: "0".repeat(64),
    parents: [],
    author: "",
    message: "",
    created_at: 0,
    changes: priors
      .filter((prior) => prior.op !== "delete" && prior.blob)
      .map((prior) => ({ op: "upsert" as const, path: prior.path, blob: prior.blob! })),
  };
  return {
    id: show.id,
    author: show.author,
    message: show.message,
    created_at: show.created_at,
    parents: show.parents,
    diff: showDiff([priorCommit, commit], commit, blobs),
  };
}

export async function readBlame(
  source: HistorySource,
  tip: string,
  path: string
): Promise<{ path: string; tip: string; lines: { line: number; changeset: string; author: string; text: string }[] } | null> {
  const groups: { id: string; author: string; op: string; blob: string | null }[][] = [];
  let cursor: string | null = tip;
  const seen = new Set<string>();
  for (let guard = 0; guard < 64 && cursor && !seen.has(cursor); guard++) {
    seen.add(cursor);
    const db = await dbForId(source, cursor);
    try {
      const page = await queryBlameTouches(db.sql, cursor, path);
      groups.push(page.touches);
      cursor = page.continueFrom;
    } finally {
      db.close();
    }
  }
  const touches = groups.reverse().flat();
  const versions: { id: string; author: string; text: string }[] = [];
  let blob: string | null = null;
  for (const touch of touches) {
    blob = touch.op === "delete" ? null : touch.blob;
    if (!blob) continue;
    const text = await loadBlob(source.sql, blob);
    if (text == null) continue;
    const prev = versions[versions.length - 1];
    if (!prev || prev.text !== text) versions.push({ id: touch.id, author: touch.author, text });
  }
  if (!versions.length) return null;
  return { path, tip, lines: blameLines(versions) };
}

/** First-parent ids after `good` through `bad`, oldest first. */
export async function readFirstParent(source: HistorySource, bad: string, good: string): Promise<string[] | null> {
  if (bad === good) return null;
  const newestFirst: string[] = [];
  let cursor = bad;
  const seen = new Set<string>();
  let reached = false;
  for (let guard = 0; guard < 10000 && cursor && !seen.has(cursor); guard++) {
    seen.add(cursor);
    const db = await dbForId(source, cursor);
    try {
      const page = await queryFirstParent(db.sql, cursor, good, 5000);
      for (const id of page.ids) {
        if (!newestFirst.includes(id)) newestFirst.push(id);
      }
      if (page.reachedGood) {
        reached = true;
        break;
      }
      if (!page.continueFrom) break;
      cursor = page.continueFrom;
    } finally {
      db.close();
    }
  }
  if (!reached) return null;
  return newestFirst.reverse();
}

export async function readIsAncestor(source: HistorySource, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  let cursor = descendant;
  const seen = new Set<string>();
  for (let guard = 0; guard < 64 && cursor && !seen.has(cursor); guard++) {
    seen.add(cursor);
    const db = await dbForId(source, cursor);
    try {
      if (await queryIsAncestor(db.sql, ancestor, cursor)) return true;
      const edge = await db.sql.sqlOne<{ parent: string }>(
        `WITH RECURSIVE walk(id, depth) AS (
            SELECT ?, 0
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
        [cursor]
      );
      cursor = edge?.parent ? String(edge.parent) : null;
    } finally {
      db.close();
    }
  }
  return false;
}

export async function readMergeBase(source: HistorySource, a: string, b: string): Promise<string | null> {
  if (a === b) return a;
  const ancestors = new Set<string>();
  let cursor: string | null = a;
  const seen = new Set<string>();
  for (let guard = 0; guard < 64 && cursor && !seen.has(cursor); guard++) {
    seen.add(cursor);
    const db = await dbForId(source, cursor);
    try {
      const rows = await db.sql.sqlAll<{ id: string }>(
        `WITH RECURSIVE walk(id, depth) AS (
            SELECT ?, 0
            UNION
            SELECT p.parent, walk.depth + 1
            FROM walk
            JOIN changeset_parents p ON p.child = walk.id
            JOIN changesets c ON c.id = walk.id
            WHERE walk.depth < 1000000
          )
          SELECT id FROM walk`,
        [cursor]
      );
      for (const row of rows) ancestors.add(String(row.id));
      const edge = await db.sql.sqlOne<{ parent: string }>(
        `WITH RECURSIVE walk(id, depth) AS (
            SELECT ?, 0
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
        [cursor]
      );
      cursor = edge?.parent ? String(edge.parent) : null;
    } finally {
      db.close();
    }
  }
  cursor = b;
  const seenB = new Set<string>();
  for (let guard = 0; guard < 64 && cursor && !seenB.has(cursor); guard++) {
    seenB.add(cursor);
    const db = await dbForId(source, cursor);
    try {
      const rows = await db.sql.sqlAll<{ id: string; depth: number }>(
        `WITH RECURSIVE walk(id, depth) AS (
            SELECT ?, 0
            UNION
            SELECT p.parent, walk.depth + 1
            FROM walk
            JOIN changeset_parents p ON p.child = walk.id
            JOIN changesets c ON c.id = walk.id
            WHERE walk.depth < 1000000
          )
          SELECT id, depth FROM walk ORDER BY depth ASC`,
        [cursor]
      );
      for (const row of rows) {
        if (ancestors.has(String(row.id))) return String(row.id);
      }
      const edge = await db.sql.sqlOne<{ parent: string }>(
        `SELECT p.parent AS parent
           FROM changeset_parents p
           LEFT JOIN changesets c ON c.id = p.parent
          WHERE p.child = ? AND p.ord = 0 AND c.id IS NULL
          LIMIT 1`,
        [rows.length ? rows[rows.length - 1]!.id : cursor]
      );
      cursor = edge?.parent ? String(edge.parent) : null;
    } finally {
      db.close();
    }
  }
  return null;
}

async function headAt(
  source: HistorySource,
  rev: string
): Promise<{ id: string; lsn: number; root_tree: string; author: string; message: string; created_at: number } | null> {
  const id = await resolveTipId(source, rev);
  if (!id) return null;
  const db = await dbForId(source, id);
  try {
    const row = await db.sql.sqlOne<{ id: string; lsn: number; root_tree: string; author: string | null; message: string | null; committed_at: number | null }>(
      `SELECT id, lsn, root_tree, author, message, committed_at FROM changesets WHERE id = ? LIMIT 1`,
      [id]
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
  } finally {
    db.close();
  }
}

export type SnapshotRead = {
  head: { id: string; lsn: number; root_tree: string; author: string; message: string; created_at: number };
  files: Map<string, SnapFile>;
  deltas: number;
  archives: number;
};

/** Tree at `rev`. `archives` is 0 or 1. `deltas` is the replay length. */
export async function readSnapshot(source: HistorySource, rev: string): Promise<SnapshotRead | null> {
  const head = await headAt(source, rev);
  if (!head) return null;
  const liveMin = await minLiveLsn(source.sql);
  const inLive = liveMin != null && head.lsn >= liveMin;
  const liveRow = await source.sql.sqlOne<{ id: string }>(`SELECT id FROM changesets WHERE id = ? LIMIT 1`, [head.id]);
  if (inLive && liveRow) {
    const snap = await snapshotAt(source.sql, head.lsn);
    return { head, files: snap.files, deltas: snap.deltas, archives: 0 };
  }
  const db = await dbForId(source, head.id);
  try {
    const snap = await snapshotAt(db.sql, head.lsn);
    return { head, files: snap.files, deltas: snap.deltas, archives: db.sql === source.sql ? 0 : 1 };
  } finally {
    db.close();
  }
}

export async function readTree(
  source: HistorySource,
  rev: string,
  path: string
): Promise<{ head: SnapshotRead["head"]; entries: DirEntry[]; deltas: number; archives: number } | null> {
  const snap = await readSnapshot(source, rev);
  if (!snap) return null;
  const cleaned = path.replace(/^\/+|\/+$/g, "");
  return {
    head: snap.head,
    entries: directoryEntries(snap.files, cleaned),
    deltas: snap.deltas,
    archives: snap.archives,
  };
}

export async function readBlobFile(
  source: HistorySource,
  rev: string,
  path: string
): Promise<{ head: SnapshotRead["head"]; file: SnapFile; deltas: number; archives: number } | null> {
  const snap = await readSnapshot(source, rev);
  if (!snap) return null;
  const cleaned = path.replace(/^\/+|\/+$/g, "");
  const file = snap.files.get(cleaned);
  if (!file?.blob) return null;
  return { head: snap.head, file, deltas: snap.deltas, archives: snap.archives };
}

export async function prepareHistory(sql: RepoSql, every = checkpointEvery(undefined)): Promise<void> {
  await ensureHistorySchema(sql);
  const ready = await sql.sqlOne<{ value: string }>(`SELECT value FROM meta WHERE key = 'checkpoints_ready' LIMIT 1`);
  if (ready?.value === String(every)) return;
  await backfillCheckpoints(sql, every);
  await sql.sqlRun(`INSERT OR REPLACE INTO meta (key, value) VALUES ('checkpoints_ready', ?)`, [String(every)]);
}

export async function noteChangeset(sql: RepoSql, row: { id: string; lsn: number; body: string }, every: number): Promise<void> {
  await indexChangeset(sql, row);
  if (every > 0 && row.lsn % every === 0) await ensureCheckpointAt(sql, row.lsn);
}

export async function listArchives(sql: RepoSql): Promise<Record<string, unknown>[]> {
  return sql.sqlAll(
    `SELECT id, lsn_min, lsn_max, first_id, last_id, piece_cid, size, checksum, created_at
       FROM history_archives ORDER BY lsn_min ASC`
  );
}

export async function openLocatedArchive(source: HistorySource, archiveId: number): Promise<Db | null> {
  const row = await source.sql.sqlOne<{ piece_cid: string }>(
    `SELECT piece_cid FROM history_archives WHERE id = ? LIMIT 1`,
    [archiveId]
  );
  if (!row) return null;
  return openArchive(source.store, String(row.piece_cid));
}

function parseTime(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const raw = Number(trimmed);
    return raw < 1_000_000_000_000 ? raw * 1000 : raw;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (!match) return null;
  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(date) ? date : null;
}

/** Lsn strictly below the cutoff commit. The cutoff itself stays live. */
export async function cutoffLsn(source: HistorySource, before: string): Promise<number | null> {
  if (ID_RE.test(before)) {
    const head = await headAt(source, before);
    return head ? head.lsn : null;
  }
  const when = parseTime(before);
  if (when == null) {
    const head = await headAt(source, before);
    return head ? head.lsn : null;
  }
  const main = await resolveTipId(source, "main");
  if (!main) return null;
  const db = await dbForId(source, main);
  try {
    const row = await db.sql.sqlOne<{ lsn: number }>(
      `WITH RECURSIVE walk(id, depth) AS (
          SELECT ?, 0
          UNION ALL
          SELECT p.parent, walk.depth + 1
          FROM walk
          JOIN changeset_parents p ON p.child = walk.id AND p.ord = 0
          JOIN changesets c ON c.id = walk.id
          WHERE walk.depth < 1000000
        )
        SELECT c.lsn AS lsn
          FROM walk
          JOIN changesets c ON c.id = walk.id
         WHERE COALESCE(c.committed_at, 0) <= ?
         ORDER BY c.lsn DESC
         LIMIT 1`,
      [main, when]
    );
    return row ? Number(row.lsn) : null;
  } finally {
    db.close();
  }
}

export type ArchivePlan = {
  cutoff_lsn: number;
  chunks: { lsn_min: number; lsn_max: number; rows: number; bytes: number }[];
  rows: number;
  bytes: number;
};

export async function planArchive(
  source: HistorySource,
  before: string,
  chunkCommits: number,
  chunkBytes: number
): Promise<ArchivePlan | null> {
  const lsn = await cutoffLsn(source, before);
  if (lsn == null) return null;
  const chunks = await planArchiveChunks(source.sql, lsn, chunkCommits, chunkBytes, true);
  return {
    cutoff_lsn: lsn,
    chunks: chunks.map((chunk) => ({
      lsn_min: chunk.lsnMin,
      lsn_max: chunk.lsnMax,
      rows: chunk.rows,
      bytes: chunk.bytes,
    })),
    rows: chunks.reduce((sum, chunk) => sum + chunk.rows, 0),
    bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
  };
}

export async function runArchive(
  source: HistorySource,
  before: string,
  opts: { chunkCommits?: number; chunkBytes?: number; allowPartial?: boolean; now?: number } = {}
): Promise<{ cutoff_lsn: number; archives: ArchiveRecord[] }> {
  const lsn = await cutoffLsn(source, before);
  if (lsn == null) throw new Error("cutoff not found");
  const archives = await archiveHistory(source.sql, source.store, {
    cutoffLsn: lsn,
    chunkCommits: opts.chunkCommits ?? archiveChunkCommits(undefined),
    chunkBytes: opts.chunkBytes ?? archiveChunkBytes(undefined),
    allowPartial: opts.allowPartial ?? true,
    now: opts.now,
  });
  return { cutoff_lsn: lsn, archives };
}

export async function maybeAutoArchive(
  source: HistorySource,
  maxBytes: number,
  chunkCommits: number,
  chunkBytes: number
): Promise<ArchiveRecord[]> {
  if (!maxBytes || maxBytes <= 0) return [];
  const size = source.sql.databaseSize?.() ?? 0;
  if (size < maxBytes) return [];
  const tip = await source.sql.sqlOne<{ lsn: number }>(`SELECT MAX(lsn) AS lsn FROM changesets`);
  if (!tip?.lsn) return [];
  return archiveHistory(source.sql, source.store, {
    cutoffLsn: Number(tip.lsn) + 1,
    chunkCommits,
    chunkBytes,
    allowPartial: false,
  });
}

export async function haveChangesets(source: HistorySource, ids: string[]): Promise<string[]> {
  return queryHave(source.sql, ids);
}

export async function pageChangesets(
  sql: RepoSql,
  limit: number,
  afterLsn: number
): Promise<{ changesets: { id: string; lsn: number; root_tree: string; changeset: unknown }[]; next_lsn: number | null }> {
  const size = Math.min(1000, Math.max(1, limit || 100));
  const rows = await sql.sqlAll<{ id: string; lsn: number; root_tree: string; body: string }>(
    `SELECT id, lsn, root_tree, body FROM changesets WHERE lsn > ? ORDER BY lsn ASC LIMIT ?`,
    [afterLsn, size + 1]
  );
  const more = rows.length > size;
  const page = more ? rows.slice(0, size) : rows;
  return {
    changesets: page.map((row) => ({
      id: String(row.id),
      lsn: Number(row.lsn),
      root_tree: String(row.root_tree),
      changeset: parseChangesetBody(String(row.body)) ?? JSON.parse(String(row.body)),
    })),
    next_lsn: more ? Number(page[page.length - 1]!.lsn) : null,
  };
}

/** Parent-before-child ids reachable from `tip`, paged. Bodies are not returned. */
export async function ancestorPage(
  source: HistorySource,
  tip: string,
  limit: number,
  cursor: number
): Promise<{ items: { id: string; parents: string[]; lsn: number }[]; next_cursor: number | null }> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const state: { id: string; expanded: boolean }[] = [{ id: tip, expanded: false }];
  while (state.length) {
    const frame = state.pop();
    if (!frame) break;
    if (frame.expanded) {
      if (seen.has(frame.id)) continue;
      seen.add(frame.id);
      ordered.push(frame.id);
      continue;
    }
    if (seen.has(frame.id)) continue;
    state.push({ id: frame.id, expanded: true });
    const db = await dbForId(source, frame.id);
    try {
      const parents = await db.sql.sqlAll<{ parent: string; ord: number }>(
        `SELECT parent, ord FROM changeset_parents WHERE child = ? ORDER BY ord DESC`,
        [frame.id]
      );
      for (const parent of parents) state.push({ id: String(parent.parent), expanded: false });
    } finally {
      db.close();
    }
  }
  const slice = ordered.slice(cursor, cursor + limit);
  const items = [];
  for (const id of slice) {
    const db = await dbForId(source, id);
    try {
      const row = await db.sql.sqlOne<{ lsn: number }>(`SELECT lsn FROM changesets WHERE id = ? LIMIT 1`, [id]);
      const parents = await db.sql.sqlAll<{ parent: string; ord: number }>(
        `SELECT parent, ord FROM changeset_parents WHERE child = ? ORDER BY ord ASC`,
        [id]
      );
      items.push({
        id,
        lsn: Number(row?.lsn ?? 0),
        parents: parents.map((parent) => String(parent.parent)),
      });
    } finally {
      db.close();
    }
  }
  const next = cursor + slice.length;
  return { items, next_cursor: next < ordered.length ? next : null };
}
