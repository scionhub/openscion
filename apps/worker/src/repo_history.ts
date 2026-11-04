//! RepoDO history, snapshot, and archive routes.
//!
//! Log, blame, show, and tree reads run inside SQLite. Archive copies the
//! oldest changesets into a write-once piece and deletes the live rows only
//! after the piece reads back with the same checksum.

import { memoryPieceStore, type PieceStore } from "./archive";
import {
  archiveChunkBytes,
  archiveChunkCommits,
  checkpointEvery,
  writeBlameCache,
} from "./history_schema";
import {
  haveChangesets,
  listArchives,
  maybeAutoArchive,
  noteChangeset,
  openLocatedArchive,
  pageChangesets,
  planArchive,
  prepareHistory,
  readBlame,
  readFirstParent,
  readLog,
  readMergeBase,
  readShow,
  readSnapshot,
  readTree,
  resolveTipId,
  runArchive,
  type HistorySource,
} from "./history_read";
import type { RepoSql } from "./pieces";

export type HistoryEnv = {
  TREE_CHECKPOINT_EVERY?: string;
  HISTORY_ARCHIVE_CHUNK?: string;
  HISTORY_ARCHIVE_CHUNK_BYTES?: string;
  HISTORY_ARCHIVE_MAX_BYTES?: string;
};

type StorageKv = {
  get(key: string): Promise<unknown>;
  put(key: string, value: ArrayBuffer): Promise<unknown>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function toBytes(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}

/** Piece bytes live in DO KV, outside SQLite, and are never overwritten. */
export function pieceStoreFromStorage(storage: StorageKv): PieceStore {
  return {
    async put(pieceCid, bytes) {
      const key = `piece:${pieceCid}`;
      const prev = toBytes(await storage.get(key));
      if (prev) {
        if (prev.length !== bytes.length || prev.some((byte, index) => byte !== bytes[index])) {
          throw new Error("piece is write-once");
        }
        return;
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      await storage.put(key, copy.buffer);
    },
    async get(pieceCid) {
      return toBytes(await storage.get(`piece:${pieceCid}`));
    },
  };
}

export function historyEvery(env: HistoryEnv | undefined): number {
  return checkpointEvery(env?.TREE_CHECKPOINT_EVERY);
}

export function archiveMaxBytes(env: HistoryEnv | undefined): number {
  const n = Number(env?.HISTORY_ARCHIVE_MAX_BYTES ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function sourceOf(sql: RepoSql, store: PieceStore, env: HistoryEnv | undefined): HistorySource {
  return { sql, store, every: historyEvery(env) };
}

/** Index one inserted changeset and archive full chunks when the DO is over the size cap. */
export async function afterChangesetInsert(
  sql: RepoSql,
  store: PieceStore,
  env: HistoryEnv | undefined,
  row: { id: string; lsn: number; body: string }
): Promise<void> {
  await prepareHistory(sql, historyEvery(env));
  await noteChangeset(sql, row, historyEvery(env));
  const maxBytes = archiveMaxBytes(env);
  if (!maxBytes) return;
  try {
    await maybeAutoArchive(sourceOf(sql, store, env), maxBytes, archiveChunkCommits(env?.HISTORY_ARCHIVE_CHUNK), archiveChunkBytes(env?.HISTORY_ARCHIVE_CHUNK_BYTES));
  } catch (error) {
    console.error("[archive] auto archive failed", error);
  }
}

export async function serveHistory(sql: RepoSql, store: PieceStore, env: HistoryEnv | undefined, request: Request): Promise<Response> {
  await prepareHistory(sql, historyEvery(env));
  const url = new URL(request.url);
  const op = url.searchParams.get("op") || "log";
  const source = sourceOf(sql, store, env);
  if (op === "show") {
    const id = url.searchParams.get("id") || "";
    const show = await readShow(source, id);
    if (!show) return json({ error: "not found" }, 404);
    return json(show);
  }
  if (op === "blame") {
    const file = url.searchParams.get("path") || "";
    if (!file) return json({ error: "path is required" }, 400);
    const name = url.searchParams.get("ref") || url.searchParams.get("branch") || "main";
    const tip = await resolveTipId(source, name);
    if (!tip) return json({ error: "not found" }, 404);
    const cached = await sql.sqlOne<{ body: string }>(`SELECT body FROM blame_cache WHERE path = ? AND tip = ? LIMIT 1`, [file, tip]);
    if (cached?.body) {
      try {
        return json(JSON.parse(String(cached.body)));
      } catch {
        /* recompute */
      }
    }
    const payload = await readBlame(source, tip, file);
    if (!payload) return json({ error: "content unavailable", path: file }, 404);
    await writeBlameCache(sql, file, tip, JSON.stringify(payload));
    return json(payload);
  }
  if (op === "first-parent") {
    const bad = url.searchParams.get("bad") || "";
    const good = url.searchParams.get("good") || "";
    const badId = await resolveTipId(source, bad);
    const goodId = await resolveTipId(source, good);
    if (!badId || !goodId) return json({ error: "not found" }, 404);
    const ids = await readFirstParent(source, badId, goodId);
    if (!ids) return json({ error: "not found" }, 404);
    return json({ ids });
  }
  if (op === "merge-base") {
    const a = await resolveTipId(source, url.searchParams.get("a") || "");
    const b = await resolveTipId(source, url.searchParams.get("b") || "");
    if (!a || !b) return json({ error: "not found" }, 404);
    return json({ id: await readMergeBase(source, a, b) });
  }
  if (op === "have") {
    const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === "string") : [];
    return json({ present: await haveChangesets(source, ids) });
  }
  const name = url.searchParams.get("ref") || url.searchParams.get("branch") || "main";
  const tip = await resolveTipId(source, name);
  if (!tip) return json({ error: "not found" }, 404);
  const page = await readLog(source, {
    tip,
    path: url.searchParams.get("path") || undefined,
    author: url.searchParams.get("author") || undefined,
    since: numParam(url.searchParams.get("since")),
    until: numParam(url.searchParams.get("until")),
    grep: url.searchParams.get("grep") || undefined,
    limit: Number(url.searchParams.get("n") || url.searchParams.get("limit") || 20),
    cursor: url.searchParams.get("cursor") || undefined,
  });
  return json({ ref: name, commits: page.commits, next_cursor: page.next_cursor });
}

function numParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function serveSnapshot(
  sql: RepoSql,
  store: PieceStore,
  env: HistoryEnv | undefined,
  request: Request,
  org: string,
  repo: string
): Promise<Response> {
  await prepareHistory(sql, historyEvery(env));
  const url = new URL(request.url);
  const rev = url.searchParams.get("rev") || "main";
  const path = url.searchParams.get("path") || "";
  const op = url.searchParams.get("op") || "tree";
  const source = sourceOf(sql, store, env);
  if (op === "blob") {
    const cleaned = path.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return json({ code: "InvalidChange", message: "path is required" }, 400);
    const snap = await readSnapshot(source, rev);
    if (!snap) return json({ code: "NotFound", message: "unknown revision" }, 404);
    const file = snap.files.get(cleaned);
    if (!file?.blob) return json({ code: "NotFound", message: `path not found: ${cleaned}` }, 404);
    const kind = file.kind === "symlink" ? "symlink" : "file";
    return json({
      ref: rev,
      path: cleaned,
      kind,
      blob: file.blob,
      size: null,
      pieceCid: file.pieceCid ?? null,
      url: null,
      offset: null,
      length: null,
      raw: `/v1/repos/${org}/${repo}/objects`,
      deltas: snap.deltas,
      archives: snap.archives,
    });
  }
  const tree = await readTree(source, rev, path);
  if (!tree) return json({ code: "NotFound", message: "unknown revision" }, 404);
  return json({
    ref: rev,
    path: path.replace(/^\/+|\/+$/g, ""),
    tree: tree.head.root_tree || "0".repeat(64),
    commit: tree.head.id,
    entries: tree.entries,
    deltas: tree.deltas,
    archives: tree.archives,
  });
}

export async function serveArchive(sql: RepoSql, store: PieceStore, env: HistoryEnv | undefined, request: Request): Promise<Response> {
  await prepareHistory(sql, historyEvery(env));
  if (request.method === "GET") return json({ archives: await listArchives(sql) });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await request.json().catch(() => null)) as { before?: string; dry_run?: boolean } | null;
  const before = body?.before?.trim() || "";
  if (!before) return json({ error: "before is required" }, 400);
  const source = sourceOf(sql, store, env);
  const chunkCommits = archiveChunkCommits(env?.HISTORY_ARCHIVE_CHUNK);
  const chunkBytes = archiveChunkBytes(env?.HISTORY_ARCHIVE_CHUNK_BYTES);
  if (body?.dry_run) {
    const plan = await planArchive(source, before, chunkCommits, chunkBytes);
    if (!plan) return json({ error: "not found" }, 404);
    return json({ dry_run: true, ...plan });
  }
  try {
    const ran = await runArchive(source, before, { chunkCommits, chunkBytes, allowPartial: true });
    return json({ dry_run: false, cutoff_lsn: ran.cutoff_lsn, archives: ran.archives });
  } catch (error) {
    const message = error instanceof Error ? error.message : "archive failed";
    const status = message === "cutoff not found" ? 404 : 500;
    return json({ error: message }, status);
  }
}

export async function serveChangesetPage(
  sql: RepoSql,
  store: PieceStore,
  limit: number,
  afterLsn: number,
  archiveId: number | null
): Promise<{ changesets: { id: string; lsn: number; root_tree: string; changeset: unknown }[]; next_lsn: number | null }> {
  if (archiveId == null) return pageChangesets(sql, limit, afterLsn);
  const opened = await openLocatedArchive({ sql, store }, archiveId);
  if (!opened) return { changesets: [], next_lsn: null };
  try {
    return await pageChangesets(opened.sql, limit, afterLsn);
  } finally {
    opened.close();
  }
}

/** In-memory store for tests that do not have Durable Object KV. */
export function testPieceStore(): PieceStore {
  return memoryPieceStore();
}
