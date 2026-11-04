//! Full-tree checkpoints every N changesets, and on archive boundaries.
//!
//! A historical tree or blob loads the nearest checkpoint at or below the
//! target and replays at most N changeset bodies. Archive chunks copy the
//! checkpoint at their first lsn into the chunk file, so a read inside a
//! chunk never opens a second archive.

import type { RepoSql } from "./pieces";
import { parseChangesetBody, type ParsedChangeset } from "./history_schema";

export type SnapFile = { blob: string | null; kind: string; pieceCid: string | null };

export function applyParsed(files: Map<string, SnapFile>, parsed: ParsedChangeset): void {
  for (const change of parsed.changes) {
    if (change.op === "delete") {
      files.delete(change.path);
      continue;
    }
    const prev = files.get(change.path);
    files.set(change.path, {
      blob: change.blob ?? null,
      kind: change.kind ?? "file",
      pieceCid: prev?.pieceCid ?? null,
    });
  }
  for (const [key, value] of Object.entries(parsed.metadata)) {
    if (!key.startsWith("pcid:") || !value) continue;
    const path = key.slice("pcid:".length);
    if (!path) continue;
    const prev = files.get(path);
    if (prev) prev.pieceCid = value;
    else files.set(path, { blob: null, kind: "file", pieceCid: value });
  }
}

export function applyBody(files: Map<string, SnapFile>, body: string): void {
  const parsed = parseChangesetBody(body);
  if (parsed) applyParsed(files, parsed);
}

export async function loadCheckpoint(sql: RepoSql, lsn: number): Promise<Map<string, SnapFile>> {
  const rows = await sql.sqlAll<{ path: string; blob: string | null; kind: string | null; piece_cid: string | null }>(
    `SELECT path, blob, kind, piece_cid FROM tree_checkpoint_files WHERE lsn = ?`,
    [lsn]
  );
  const files = new Map<string, SnapFile>();
  for (const row of rows) {
    files.set(String(row.path), {
      blob: row.blob == null ? null : String(row.blob),
      kind: row.kind == null ? "file" : String(row.kind),
      pieceCid: row.piece_cid == null ? null : String(row.piece_cid),
    });
  }
  return files;
}

export async function saveCheckpoint(
  sql: RepoSql,
  lsn: number,
  changesetId: string,
  files: Map<string, SnapFile>,
  now = Date.now()
): Promise<void> {
  await sql.sqlRun(`INSERT OR REPLACE INTO tree_checkpoints (lsn, changeset_id, created_at) VALUES (?, ?, ?)`, [
    lsn,
    changesetId,
    now,
  ]);
  await sql.sqlRun(`DELETE FROM tree_checkpoint_files WHERE lsn = ?`, [lsn]);
  for (const [path, file] of files) {
    await sql.sqlRun(
      `INSERT INTO tree_checkpoint_files (lsn, path, blob, kind, piece_cid) VALUES (?, ?, ?, ?, ?)`,
      [lsn, path, file.blob, file.kind, file.pieceCid]
    );
  }
}

export async function nearestCheckpointLsn(sql: RepoSql, lsn: number): Promise<number | null> {
  const row = await sql.sqlOne<{ lsn: number }>(
    `SELECT lsn FROM tree_checkpoints WHERE lsn <= ? ORDER BY lsn DESC LIMIT 1`,
    [lsn]
  );
  return row ? Number(row.lsn) : null;
}

/** Replay bodies with lsn in (fromExclusive, toInclusive]. Returns the row count. */
export async function replayDeltas(
  sql: RepoSql,
  files: Map<string, SnapFile>,
  fromExclusive: number,
  toInclusive: number
): Promise<number> {
  const rows = await sql.sqlAll<{ lsn: number; body: string }>(
    `SELECT lsn, body FROM changesets WHERE lsn > ? AND lsn <= ? ORDER BY lsn ASC`,
    [fromExclusive, toInclusive]
  );
  for (const row of rows) applyBody(files, String(row.body));
  return rows.length;
}

/**
 * Materialize the tree at `lsn` inside this database.
 * `deltas` is how many changeset bodies were read (at most the checkpoint interval
 * when checkpoints are present).
 */
export async function snapshotAt(
  sql: RepoSql,
  lsn: number
): Promise<{ files: Map<string, SnapFile>; deltas: number; checkpoint: number | null }> {
  const checkpoint = await nearestCheckpointLsn(sql, lsn);
  const files = checkpoint == null ? new Map<string, SnapFile>() : await loadCheckpoint(sql, checkpoint);
  const deltas = await replayDeltas(sql, files, checkpoint ?? 0, lsn);
  return { files, deltas, checkpoint };
}

/** One pass over the live log. Writes a checkpoint every `every` lsns and at `extra` lsns. */
export async function backfillCheckpoints(sql: RepoSql, every: number, extra: number[] = []): Promise<number> {
  const want = new Set(extra.filter((lsn) => lsn > 0));
  const rows = await sql.sqlAll<{ id: string; lsn: number; body: string }>(
    `SELECT id, lsn, body FROM changesets ORDER BY lsn ASC`
  );
  const files = new Map<string, SnapFile>();
  let written = 0;
  for (const row of rows) {
    applyBody(files, String(row.body));
    const lsn = Number(row.lsn);
    if (lsn % every === 0 || want.has(lsn)) {
      await saveCheckpoint(sql, lsn, String(row.id), files);
      written += 1;
    }
  }
  return written;
}

export async function ensureCheckpointAt(sql: RepoSql, lsn: number): Promise<void> {
  const existing = await sql.sqlOne<{ lsn: number }>(`SELECT lsn FROM tree_checkpoints WHERE lsn = ? LIMIT 1`, [lsn]);
  if (existing) return;
  const idRow = await sql.sqlOne<{ id: string }>(`SELECT id FROM changesets WHERE lsn = ? LIMIT 1`, [lsn]);
  if (!idRow) return;
  const built = await snapshotAt(sql, lsn);
  await saveCheckpoint(sql, lsn, String(idRow.id), built.files);
}

export type DirEntry = {
  name: string;
  kind: string;
  id: string;
  size: null;
  pieceCid?: string | null;
};

/** One directory of a snapshot, matching the engine-fail tree fallback. */
export function directoryEntries(
  files: Map<string, SnapFile>,
  cleaned: string
): DirEntry[] {
  const prefix = cleaned ? `${cleaned}/` : "";
  const children = new Map<string, { dir: boolean; blob?: string | null; kind?: string; pieceCid?: string | null }>();
  for (const [path, file] of files) {
    if (cleaned && !path.startsWith(prefix) && path !== cleaned) continue;
    const rest = cleaned ? (path === cleaned ? "" : path.startsWith(prefix) ? path.slice(prefix.length) : "") : path;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      children.set(rest, { dir: false, blob: file.blob, kind: file.kind, pieceCid: file.pieceCid });
    } else {
      const top = rest.slice(0, slash);
      if (!children.has(top)) children.set(top, { dir: true });
    }
  }
  return [...children.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, info]) => {
      const entry: DirEntry = {
        name,
        kind: info.dir ? "dir" : info.kind === "symlink" ? "symlink" : info.kind === "executable" ? "executable" : "file",
        id: info.dir ? "0".repeat(64) : info.blob ?? "0".repeat(64),
        size: null,
      };
      if (!info.dir) entry.pieceCid = info.pieceCid ?? null;
      return entry;
    });
}
