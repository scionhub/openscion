//! Move the oldest contiguous lsn range into an immutable SQLite piece.
//!
//! The file is written once, uploaded through the repo's piece store, and
//! checked by reading it back. Live rows are deleted only after that check.
//! A later archive never updates a piece that was already stored.

import { Piece } from "@web3-storage/data-segment";

import { closeCachedArchives, emptyArchiveSql, openArchiveBytes, type OpenArchive } from "./archive_db";
import { ensureCheckpointAt } from "./checkpoints";
import type { RepoSql } from "./pieces";
import { internPiece } from "./pieces";

export type PieceStore = {
  put(pieceCid: string, bytes: Uint8Array): Promise<void>;
  get(pieceCid: string): Promise<Uint8Array | null>;
};

export type PlannedChunk = { lsnMin: number; lsnMax: number; rows: number; bytes: number };

export type ArchiveRecord = {
  id: number;
  lsn_min: number;
  lsn_max: number;
  first_id: string;
  last_id: string;
  piece_cid: string;
  size: number;
  checksum: string;
  rows: number;
};

export function pieceCidOf(bytes: Uint8Array): string {
  return Piece.fromPayload(bytes).link.toString();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function memoryPieceStore(): PieceStore & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async put(pieceCid, bytes) {
      const prev = map.get(pieceCid);
      if (prev && !bytesEqual(prev, bytes)) throw new Error("piece is write-once");
      if (!prev) map.set(pieceCid, bytes);
    },
    async get(pieceCid) {
      return map.get(pieceCid) ?? null;
    },
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function planArchiveChunks(
  sql: RepoSql,
  cutoffLsn: number,
  chunkCommits: number,
  chunkBytes: number,
  allowPartial: boolean
): Promise<PlannedChunk[]> {
  const archived = await sql.sqlOne<{ lsn: number | null }>(`SELECT MAX(lsn_max) AS lsn FROM history_archives`);
  const floor = Number(archived?.lsn ?? 0);
  const rows = await sql.sqlAll<{ lsn: number; bytes: number }>(
    `SELECT lsn, LENGTH(body) AS bytes FROM changesets WHERE lsn > ? AND lsn < ? ORDER BY lsn ASC`,
    [floor, cutoffLsn]
  );
  const chunks: PlannedChunk[] = [];
  let current: PlannedChunk | null = null;
  for (const row of rows) {
    const lsn = Number(row.lsn);
    const bytes = Number(row.bytes ?? 0);
    if (!current) current = { lsnMin: lsn, lsnMax: lsn, rows: 0, bytes: 0 };
    const wouldOverflow =
      current.rows > 0 && (current.rows >= chunkCommits || current.bytes >= chunkBytes);
    if (wouldOverflow) {
      chunks.push(current);
      current = { lsnMin: lsn, lsnMax: lsn, rows: 0, bytes: 0 };
    }
    current.lsnMax = lsn;
    current.rows += 1;
    current.bytes += bytes;
  }
  if (current && (allowPartial || current.rows >= chunkCommits || current.bytes >= chunkBytes)) chunks.push(current);
  return chunks;
}

async function copyChunk(live: RepoSql, chunk: PlannedChunk): Promise<Uint8Array> {
  await ensureCheckpointAt(live, chunk.lsnMin);
  await ensureCheckpointAt(live, chunk.lsnMax);
  const file = await emptyArchiveSql();
  try {
    const changesets = await live.sqlAll<Record<string, unknown>>(
      `SELECT id, lsn, root_tree, body, created_at, author, message, committed_at
         FROM changesets WHERE lsn >= ? AND lsn <= ? ORDER BY lsn ASC`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    for (const row of changesets) {
      await file.sql.sqlRun(
        `INSERT INTO changesets (id, lsn, root_tree, body, created_at, author, message, committed_at, indexed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          row.id,
          row.lsn,
          row.root_tree,
          row.body,
          row.created_at,
          row.author ?? null,
          row.message ?? null,
          row.committed_at ?? null,
        ]
      );
    }
    const parents = await live.sqlAll<{ child: string; parent: string; ord: number }>(
      `SELECT p.child, p.parent, p.ord
         FROM changeset_parents p
         JOIN changesets c ON c.id = p.child
        WHERE c.lsn >= ? AND c.lsn <= ?`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    for (const row of parents) {
      await file.sql.sqlRun(`INSERT INTO changeset_parents (child, parent, ord) VALUES (?, ?, ?)`, [
        row.child,
        row.parent,
        row.ord,
      ]);
    }
    const paths = await live.sqlAll<{ changeset: string; path: string; op: string; blob: string | null; kind: string | null }>(
      `SELECT cp.changeset, cp.path, cp.op, cp.blob, cp.kind
         FROM changeset_paths cp
         JOIN changesets c ON c.id = cp.changeset
        WHERE c.lsn >= ? AND c.lsn <= ?`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    for (const row of paths) {
      await file.sql.sqlRun(
        `INSERT INTO changeset_paths (changeset, path, op, blob, kind) VALUES (?, ?, ?, ?, ?)`,
        [row.changeset, row.path, row.op, row.blob, row.kind]
      );
    }
    const checkpoints = await live.sqlAll<{ lsn: number; changeset_id: string; created_at: number }>(
      `SELECT lsn, changeset_id, created_at FROM tree_checkpoints WHERE lsn >= ? AND lsn <= ?`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    for (const row of checkpoints) {
      await file.sql.sqlRun(
        `INSERT INTO tree_checkpoints (lsn, changeset_id, created_at) VALUES (?, ?, ?)`,
        [row.lsn, row.changeset_id, row.created_at]
      );
    }
    const files = await live.sqlAll<{ lsn: number; path: string; blob: string | null; kind: string | null; piece_cid: string | null }>(
      `SELECT lsn, path, blob, kind, piece_cid FROM tree_checkpoint_files WHERE lsn >= ? AND lsn <= ?`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    for (const row of files) {
      await file.sql.sqlRun(
        `INSERT INTO tree_checkpoint_files (lsn, path, blob, kind, piece_cid) VALUES (?, ?, ?, ?, ?)`,
        [row.lsn, row.path, row.blob, row.kind, row.piece_cid]
      );
    }
    return await file.bytes();
  } finally {
    await file.close();
  }
}

async function assertArchive(bytes: Uint8Array, chunk: PlannedChunk): Promise<void> {
  const opened = await openArchiveBytes(`verify:${chunk.lsnMin}:${chunk.lsnMax}`, bytes);
  try {
    const row = await opened.sql.sqlOne<{ n: number; lo: number; hi: number }>(
      `SELECT COUNT(*) AS n, MIN(lsn) AS lo, MAX(lsn) AS hi FROM changesets`
    );
    if (!row || Number(row.n) !== chunk.rows || Number(row.lo) !== chunk.lsnMin || Number(row.hi) !== chunk.lsnMax) {
      throw new Error("archive checksum failed");
    }
    const edge = await opened.sql.sqlOne<{ lsn: number }>(
      `SELECT lsn FROM tree_checkpoints WHERE lsn = ? LIMIT 1`,
      [chunk.lsnMin]
    );
    if (!edge) throw new Error("archive is missing its boundary checkpoint");
  } finally {
    (opened as OpenArchive & { destroy?: () => void }).destroy?.();
  }
}

async function dropLiveChunk(sql: RepoSql, chunk: PlannedChunk): Promise<void> {
  await sql.sqlRun(
    `DELETE FROM changeset_paths WHERE changeset IN (SELECT id FROM changesets WHERE lsn >= ? AND lsn <= ?)`,
    [chunk.lsnMin, chunk.lsnMax]
  );
  await sql.sqlRun(
    `DELETE FROM changeset_parents WHERE child IN (SELECT id FROM changesets WHERE lsn >= ? AND lsn <= ?)`,
    [chunk.lsnMin, chunk.lsnMax]
  );
  await sql.sqlRun(`DELETE FROM changesets WHERE lsn >= ? AND lsn <= ?`, [chunk.lsnMin, chunk.lsnMax]);
  await sql.sqlRun(`DELETE FROM tree_checkpoint_files WHERE lsn >= ? AND lsn < ?`, [chunk.lsnMin, chunk.lsnMax]);
  await sql.sqlRun(`DELETE FROM tree_checkpoints WHERE lsn >= ? AND lsn < ?`, [chunk.lsnMin, chunk.lsnMax]);
}

/**
 * Archive every planned chunk. `allowPartial` is true for an explicit admin
 * request and false for the size-triggered path, which leaves a short tail live.
 */
export async function archiveHistory(
  sql: RepoSql,
  store: PieceStore,
  opts: {
    cutoffLsn: number;
    chunkCommits: number;
    chunkBytes: number;
    allowPartial: boolean;
    now?: number;
  }
): Promise<ArchiveRecord[]> {
  const plan = await planArchiveChunks(sql, opts.cutoffLsn, opts.chunkCommits, opts.chunkBytes, opts.allowPartial);
  const wrote: ArchiveRecord[] = [];
  for (const chunk of plan) {
    const existing = await sql.sqlOne<{ id: number; piece_cid: string; size: number; checksum: string; first_id: string; last_id: string }>(
      `SELECT id, piece_cid, size, checksum, first_id, last_id FROM history_archives WHERE lsn_min = ? AND lsn_max = ? LIMIT 1`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    if (existing) {
      const bytes = await store.get(String(existing.piece_cid));
      if (!bytes || (await sha256Hex(bytes)) !== String(existing.checksum)) {
        throw new Error("archived piece failed read-back");
      }
      await dropLiveChunk(sql, chunk);
      wrote.push({
        id: Number(existing.id),
        lsn_min: chunk.lsnMin,
        lsn_max: chunk.lsnMax,
        first_id: String(existing.first_id),
        last_id: String(existing.last_id),
        piece_cid: String(existing.piece_cid),
        size: Number(existing.size),
        checksum: String(existing.checksum),
        rows: chunk.rows,
      });
      continue;
    }
    const bytes = await copyChunk(sql, chunk);
    const checksum = await sha256Hex(bytes);
    const pieceCid = pieceCidOf(bytes);
    await store.put(pieceCid, bytes);
    const readBack = await store.get(pieceCid);
    if (!readBack || (await sha256Hex(readBack)) !== checksum || !bytesEqual(readBack, bytes)) {
      throw new Error("archived piece failed read-back");
    }
    await assertArchive(readBack, chunk);
    await internPiece(sql, pieceCid);
    const ends = await sql.sqlOne<{ first_id: string; last_id: string }>(
      `SELECT
         (SELECT id FROM changesets WHERE lsn = ? LIMIT 1) AS first_id,
         (SELECT id FROM changesets WHERE lsn = ? LIMIT 1) AS last_id`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    if (!ends?.first_id || !ends.last_id) throw new Error("archive range disappeared before commit");
    await sql.sqlRun(
      `INSERT INTO history_archives (lsn_min, lsn_max, first_id, last_id, piece_cid, size, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [chunk.lsnMin, chunk.lsnMax, ends.first_id, ends.last_id, pieceCid, bytes.length, checksum, opts.now ?? Date.now()]
    );
    const header = await sql.sqlOne<{ id: number }>(
      `SELECT id FROM history_archives WHERE lsn_min = ? AND lsn_max = ? LIMIT 1`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    const archiveId = Number(header?.id ?? 0);
    const ids = await sql.sqlAll<{ id: string; lsn: number }>(
      `SELECT id, lsn FROM changesets WHERE lsn >= ? AND lsn <= ?`,
      [chunk.lsnMin, chunk.lsnMax]
    );
    for (const row of ids) {
      await sql.sqlRun(`INSERT OR REPLACE INTO changeset_locate (id, archive_id, lsn) VALUES (?, ?, ?)`, [
        row.id,
        archiveId,
        row.lsn,
      ]);
    }
    await dropLiveChunk(sql, chunk);
    wrote.push({
      id: archiveId,
      lsn_min: chunk.lsnMin,
      lsn_max: chunk.lsnMax,
      first_id: String(ends.first_id),
      last_id: String(ends.last_id),
      piece_cid: pieceCid,
      size: bytes.length,
      checksum,
      rows: chunk.rows,
    });
  }
  return wrote;
}

export async function openArchive(store: PieceStore, pieceCid: string): Promise<OpenArchive> {
  const bytes = await store.get(pieceCid);
  if (!bytes) throw new Error("archived piece is missing");
  return openArchiveBytes(pieceCid, bytes);
}

export { closeCachedArchives };
