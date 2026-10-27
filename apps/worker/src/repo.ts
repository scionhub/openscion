// Durable Object for per-repo metadata (refs, changesets, bundle map) stored in DO SQLite.
// Keyed by idFromName("<org>/<repo>") at the Worker front. Guarded by INTERNAL_SECRET.

import { RESET_TABLES, staleAction } from "./durability";
import type { D1Env } from "./db";
import {
  DEFAULT_ADD_BATCH_MAX_PIECES,
  DEFAULT_ADD_BATCH_WINDOW_SECS,
  addDatasetUsage,
  loadDatasetResolution,
  paddedBundleSize,
  parseEnvInt,
  shouldDrainBatch,
} from "./dataset";
import { recordBundleRef } from "./repo_delete";
import { applyFileMap, ensureCommpSchema, internPiece, listFileMap } from "./pieces";

type Row = Record<string, unknown>;
type Env = D1Env & {
  INTERNAL_SECRET?: string;
  ENGINE?: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  ADD_BATCH_WINDOW_SECS?: string;
  ADD_BATCH_MAX_PIECES?: string;
  SHARED_DATASET_MAX_BYTES?: string;
};

function batchWindowMs(env: Env): number {
  return parseEnvInt(env.ADD_BATCH_WINDOW_SECS, DEFAULT_ADD_BATCH_WINDOW_SECS) * 1000;
}

function batchMaxPieces(env: Env): number {
  return parseEnvInt(env.ADD_BATCH_MAX_PIECES, DEFAULT_ADD_BATCH_MAX_PIECES);
}

/** One-row tip + tree: ref primary key, then the changeset it names. */
export const TIP_TREE_SQL = `
  SELECT r.name, r.target, r.version, COALESCE(r.root_tree, c.root_tree) AS root_tree
  FROM refs r
  LEFT JOIN changesets c ON c.id = r.target
  WHERE r.name = ?
  LIMIT 1
`;

export type BundleMemberRow = {
  bundleCid: string;
  pieceCid: string;
  offset: number;
  length: number;
};

type FileMapBodyRow = { path?: string; pieceCid?: string };

/**
 * Keep each member pieceCID in exactly one bundle. `find` already returns
 * `LIMIT 1`; relocating a piece without deleting the old row left the
 * lookup nondeterministic.
 */
export function relocateBundleMember(
  rows: BundleMemberRow[],
  next: BundleMemberRow
): BundleMemberRow[] {
  return [...rows.filter((row) => row.pieceCid !== next.pieceCid), next];
}

export class RepoDO {
  constructor(readonly state: DurableObjectState, readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = request.headers.get("x-internal-secret") || "";
    if (!this.env.INTERNAL_SECRET || secret !== (this.env.INTERNAL_SECRET as string)) {
      return new Response("forbidden", { status: 403 });
    }
    await this.ensureSchema();
    const m = url.pathname.match(/^\/__internal\/do\/([^/]+)\/([^/]+)\/(refs|changesets|bundle-map|bundles|pending-adds|reset|kick|objects|file-map)(?:\/([^/]+))?$/);
    if (!m) return new Response("bad route", { status: 400 });
    const area = m[3]!;
    const arg = m[4] ? decodeURIComponent(m[4]!) : undefined;
    // Persist org/repo meta for alarm use
    const org = decodeURIComponent(m[1]!);
    const repo = decodeURIComponent(m[2]!);
    await this.sqlRun(`INSERT OR REPLACE INTO meta (key, value) VALUES ('org', ?), ('repo', ?)`, [org, repo]);
    try {
      if (area === "reset" && request.method === "POST") {
        const cleared: string[] = [];
        for (const t of RESET_TABLES) {
          try {
            await this.sqlRun(`DELETE FROM ${t}`);
            cleared.push(t);
          } catch { /* table may not exist yet */ }
        }
        try {
          await this.sqlRun(`UPDATE pending_status SET last_error = NULL, updated_at = strftime('%s','now')*1000`);
        } catch { /* ignore */ }
        return json({ ok: true, cleared });
      }
      if (area === "kick" && request.method === "POST") {
        await this.sqlRun(`UPDATE pending_adds SET next_at = 0`);
        await this.sqlRun(`INSERT OR REPLACE INTO meta (key, value) VALUES ('force_drain', '1')`);
        await this.state.storage.setAlarm(Date.now() + 100);
        return json({ ok: true });
      }
      if (area === "refs") {
        if (request.method === "DELETE" && arg) {
          await this.sqlRun(`DELETE FROM refs WHERE name = ?`, [arg]);
          return json({ ok: true, deleted: arg });
        }
        if (request.method === "GET" && arg) {
          const rows = await this.sqlAll<{
            name: string;
            target: string;
            version: number;
            root_tree: string | null;
          }>(TIP_TREE_SQL, [arg]);
          if (rows.length === 0) return new Response("not found", { status: 404 });
          return json(rows[0]);
        }
        if (request.method === "GET") {
          const rows = await this.sqlAll<{
            name: string;
            target: string;
            version: number;
            root_tree: string | null;
          }>(
            `SELECT r.name, r.target, r.version, COALESCE(r.root_tree, c.root_tree) AS root_tree
             FROM refs r
             LEFT JOIN changesets c ON c.id = r.target
             ORDER BY r.name ASC`
          );
          return json({ refs: rows });
        }
        if (request.method === "POST") {
          const b = (await request.json()) as {
            name?: string;
            target?: string;
            version?: number;
            expected?: string | null;
          };
          if (!b.name || !b.target || b.version == null) {
            return json({ error: "name, target, and version required" }, { status: 400 });
          }
          const tip = await this.sqlOne<{ root_tree: string }>(
            `SELECT root_tree FROM changesets WHERE id = ? LIMIT 1`,
            [b.target]
          );
          const existing = await this.sqlOne<{ name: string; target: string; version: number }>(
            `SELECT name, target, version FROM refs WHERE name = ? LIMIT 1`,
            [b.name]
          );
          if (existing?.target === b.target) {
            return json({ ok: true, idempotent: true, root_tree: tip?.root_tree ?? null });
          }
          if (!existing) {
            if (b.expected != null && b.expected !== "") {
              return json({ error: "ref conflict", current: null }, { status: 409 });
            }
            await this.sqlRun(
              `INSERT OR IGNORE INTO refs (name,target,version,root_tree,updated_at) VALUES (?,?,?,?,strftime('%s','now')*1000)`,
              [b.name, b.target, b.version, tip?.root_tree ?? null]
            );
          } else if (b.expected !== undefined) {
            await this.sqlRun(
              `UPDATE refs SET target = ?, version = ?, root_tree = ?, updated_at = strftime('%s','now')*1000
               WHERE name = ? AND (target = ? OR target = ?)`,
              [b.target, b.version, tip?.root_tree ?? null, b.name, b.expected, b.target]
            );
          } else {
            await this.sqlRun(
              `UPDATE refs SET target = ?, version = ?, root_tree = ?, updated_at = strftime('%s','now')*1000
               WHERE name = ? AND (target = ? OR version = ?)`,
              [b.target, b.version, tip?.root_tree ?? null, b.name, b.target, b.version - 1]
            );
          }
          const wrote = await this.sqlOne<{ target: string }>(
            `SELECT target FROM refs WHERE name = ? LIMIT 1`,
            [b.name]
          );
          if (!wrote || wrote.target !== b.target) {
            return json({ error: "ref conflict", current: wrote?.target ?? existing?.target ?? null }, { status: 409 });
          }
          return json({ ok: true, root_tree: tip?.root_tree ?? null });
        }
      } else if (area === "changesets") {
        if (request.method === "GET" && arg) {
          const rows = await this.sqlAll<{ id: string; lsn: number; root_tree: string; body: string }>(
            `SELECT id,lsn,root_tree,body FROM changesets WHERE id = ? LIMIT 1`,
            [arg]
          );
          if (rows.length === 0) return new Response("not found", { status: 404 });
          const row = rows[0]!;
          return json({ id: row.id, lsn: row.lsn, root_tree: row.root_tree, changeset: JSON.parse(String(row.body)) });
        }
        if (request.method === "GET" && !arg) {
          const rows = await this.sqlAll<{ id: string; lsn: number; root_tree: string; body: string }>(
            `SELECT id,lsn,root_tree,body FROM changesets ORDER BY lsn ASC`
          );
          const changesets = rows.map((r) => ({
            id: r.id,
            lsn: r.lsn,
            root_tree: r.root_tree,
            changeset: JSON.parse(String(r.body)),
          }));
          return json({ changesets });
        }
        if (request.method === "POST") {
          const b = (await request.json()) as {
            id: string;
            lsn: number;
            root_tree: string;
            changeset: unknown;
          };
          await this.sqlRun(
            `INSERT OR IGNORE INTO changesets (id,lsn,root_tree,body,created_at) VALUES (?,?,?,?,strftime('%s','now')*1000)`,
            [b.id, b.lsn, b.root_tree, JSON.stringify(b.changeset)]
          );
          return json({ ok: true });
        }
      } else if (area === "file-map") {
        if (request.method === "GET") {
          return json({ files: await listFileMap(this) });
        }
        if (request.method === "POST") {
          const b = (await request.json()) as {
            upserts?: Record<string, string> | FileMapBodyRow[];
            deletes?: string[];
            files?: FileMapBodyRow[];
          };
          const upserts: { path: string; pieceCid: string }[] = [];
          if (Array.isArray(b.files)) {
            for (const row of b.files) {
              if (row?.path && row?.pieceCid) upserts.push({ path: row.path, pieceCid: row.pieceCid });
            }
          }
          if (Array.isArray(b.upserts)) {
            for (const row of b.upserts) {
              if (row?.path && row?.pieceCid) upserts.push({ path: row.path, pieceCid: row.pieceCid });
            }
          } else if (b.upserts && typeof b.upserts === "object") {
            for (const [path, pieceCid] of Object.entries(b.upserts)) {
              if (typeof pieceCid === "string") upserts.push({ path, pieceCid });
            }
          }
          const result = await applyFileMap(this, upserts, b.deletes ?? []);
          return json({ ok: true, ...result });
        }
      } else if (area === "bundle-map") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        type Member = { pieceCid: string; offset: number; length: number };
        const b = (await request.json()) as { bundleCid: string; members: Member[] };
        if (!b.bundleCid || !Array.isArray(b.members)) return json({ error: "bundleCid and members required" }, { status: 400 });
        const bundleId = await internPiece(this, b.bundleCid);
        await this.sqlRun(`INSERT OR IGNORE INTO bundles (piece_id, created_at) VALUES (?, strftime('%s','now')*1000)`, [bundleId]);
        for (const m of b.members) {
          const memberId = await internPiece(this, m.pieceCid);
          // One location per member COMMP: drop any older mapping first.
          await this.sqlRun(
            `DELETE FROM bundle_members WHERE piece_id = ? AND bundle_id != ?`,
            [memberId, bundleId]
          );
          await this.sqlRun(
            `INSERT OR REPLACE INTO bundle_members (bundle_id, piece_id, "offset", length, created_at)
             VALUES (?, ?, ?, ?, strftime('%s','now')*1000)`,
            [bundleId, memberId, m.offset, m.length]
          );
        }
        await recordBundleRef(this.env, org, repo, b.bundleCid);
        return json({ ok: true, bundleCid: b.bundleCid, members: b.members.length });
      } else if (area === "bundles") {
        if (request.method === "GET" && !arg) {
          const rows = await this.sqlAll<{ commp: string }>(
            `SELECT p.commp AS commp FROM bundles b JOIN pieces p ON p.id = b.piece_id ORDER BY b.created_at ASC`
          );
          return json({ bundles: rows.map((r) => r.commp) });
        }
        if (request.method === "GET" && arg === "export") {
          const bundles = await this.sqlAll<{ commp: string }>(
            `SELECT p.commp AS commp FROM bundles b JOIN pieces p ON p.id = b.piece_id ORDER BY b.created_at ASC`
          );
          const members = await this.sqlAll<{
            bundle_commp: string;
            piece_commp: string;
            offset: number;
            length: number;
          }>(
            `SELECT bp.commp AS bundle_commp, mp.commp AS piece_commp, m."offset" AS "offset", m.length AS length
               FROM bundle_members m
               JOIN pieces bp ON bp.id = m.bundle_id
               JOIN pieces mp ON mp.id = m.piece_id`
          );
          const by = new Map<string, { pieceCid: string; offset: number; length: number }[]>();
          for (const b of bundles) by.set(b.commp, []);
          for (const m of members) {
            const list = by.get(m.bundle_commp) ?? [];
            list.push({ pieceCid: m.piece_commp, offset: Number(m.offset), length: Number(m.length) });
            by.set(m.bundle_commp, list);
          }
          return json({
            bundles: [...by.entries()].map(([bundleCid, members]) => ({ bundleCid, members })),
          });
        }
        if (request.method === "GET" && arg === "find") {
          const subCid = url.searchParams.get("pieceCid");
          if (!subCid) return json({ error: "pieceCid required" }, { status: 400 });
          const rows = await this.sqlAll<{ bundle_commp: string; offset: number; length: number }>(
            `SELECT bp.commp AS bundle_commp, m."offset" AS "offset", m.length AS length
               FROM bundle_members m
               JOIN pieces mp ON mp.id = m.piece_id
               JOIN pieces bp ON bp.id = m.bundle_id
              WHERE mp.commp = ?
              LIMIT 1`,
            [subCid]
          );
          if (rows.length === 0) return new Response("not found", { status: 404 });
          const r = rows[0]!;
          return json({ bundleCid: r.bundle_commp, offset: r.offset, length: r.length });
        }
        if (request.method === "POST" && arg === "resolve") {
          const body = (await request.json()) as { pieceCids: string[] };
          const ids = body.pieceCids ?? [];
          if (ids.length === 0) return json({ results: [] });
          // DO SQLite caps bound parameters at 100 per statement: chunk.
          const rows: { piece_commp: string; bundle_commp: string; offset: number; length: number }[] = [];
          for (let i = 0; i < ids.length; i += 90) {
            const chunk = ids.slice(i, i + 90);
            const placeholders = chunk.map(() => "?").join(",");
            rows.push(...(await this.sqlAll<{ piece_commp: string; bundle_commp: string; offset: number; length: number }>(
              `SELECT mp.commp AS piece_commp, bp.commp AS bundle_commp, m."offset" AS "offset", m.length AS length
                 FROM bundle_members m
                 JOIN pieces mp ON mp.id = m.piece_id
                 JOIN pieces bp ON bp.id = m.bundle_id
                WHERE mp.commp IN (${placeholders})`,
              chunk
            )));
          }
          return json({
            results: rows.map((r) => ({
              pieceCid: r.piece_commp,
              bundleCid: r.bundle_commp,
              offset: r.offset,
              length: r.length
            }))
          });
        }
      } else if (area === "objects") {
        const maxBytes = 1_048_576;
        if (request.method === "POST" && !arg) {
          const b = (await request.json()) as { id?: string; bytesBase64?: string };
          if (!b.id || typeof b.bytesBase64 !== "string") {
            return json({ error: "id and bytesBase64 required" }, { status: 400 });
          }
          let bytes: Uint8Array;
          try {
            bytes = Uint8Array.from(atob(b.bytesBase64), (c) => c.charCodeAt(0));
          } catch {
            return json({ error: "invalid bytesBase64" }, { status: 400 });
          }
          if (bytes.length > maxBytes) return json({ error: "object too large" }, { status: 400 });
          await this.sqlRun(
            `INSERT OR REPLACE INTO objects (id, bytes, created_at) VALUES (?, ?, strftime('%s','now')*1000)`,
            [b.id, bytes]
          );
          return json({ ok: true, id: b.id, length: bytes.length });
        }
        if (request.method === "GET" && arg) {
          const rows = await this.sqlAll<{ bytes: ArrayBuffer | number[] | string }>(
            `SELECT bytes FROM objects WHERE id = ? LIMIT 1`,
            [arg]
          );
          if (rows.length === 0) return new Response("not found", { status: 404 });
          const raw = rows[0]!.bytes;
          const bytes =
            raw instanceof ArrayBuffer
              ? new Uint8Array(raw)
              : typeof raw === "string"
                ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
                : Uint8Array.from(raw as number[]);
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          return json({ id: arg, bytesBase64: btoa(bin), length: bytes.length });
        }
      } else if (area === "pending-adds") {
        if (request.method === "DELETE" && arg && arg !== "status") {
          // Admin: drop an unrecoverable queued bundle (e.g. test junk).
          await this.sqlRun(
            `DELETE FROM pending_adds WHERE piece_id = (SELECT id FROM pieces WHERE commp = ?)`,
            [arg]
          );
          return json({ ok: true, deleted: arg });
        }
        if (request.method === "POST" && !arg) {
          // Body: { bundleCid: string; subPieceCids?: string[] }
          // Member COMMPs live in bundle_members; subPieceCids is accepted for
          // old callers and ignored.
          const b = (await request.json()) as { bundleCid: string; subPieceCids?: string[] };
          if (!b.bundleCid) {
            return json({ error: "bundleCid required" }, { status: 400 });
          }
          const bundleId = await internPiece(this, b.bundleCid);
          const members = await this.sqlAll<{ length: number }>(
            `SELECT length FROM bundle_members WHERE bundle_id = ?`,
            [bundleId]
          );
          const sizeBytes = paddedBundleSize(
            members.reduce((sum, m) => sum + Number(m.length || 0), 0)
          );
          await this.sqlRun(
            `INSERT OR REPLACE INTO pending_adds (piece_id, created_at, attempts, next_at, size_bytes) VALUES (
              ?,
              strftime('%s','now')*1000,
              COALESCE((SELECT attempts FROM pending_adds WHERE piece_id = ?), 0),
              strftime('%s','now')*1000,
              ?
            )`,
            [bundleId, bundleId, sizeBytes]
          );
          await this.state.storage.setAlarm(Date.now() + 1000);
          return json({ ok: true });
        }
        if (request.method === "GET" && !arg) {
          const rows = await this.sqlAll<{
            bundle_commp: string;
            created_at: number;
            attempts: number;
            status: string | null;
            reason: string | null;
            piece_id: number;
          }>(
            `SELECT p.commp AS bundle_commp, pa.created_at, pa.attempts, pa.status, pa.reason, pa.piece_id
               FROM pending_adds pa
               JOIN pieces p ON p.id = pa.piece_id
              ORDER BY pa.created_at ASC`
          );
          const pending = [];
          for (const r of rows) {
            const members = await this.sqlAll<{ commp: string }>(
              `SELECT mp.commp AS commp
                 FROM bundle_members m
                 JOIN pieces mp ON mp.id = m.piece_id
                WHERE m.bundle_id = ?`,
              [r.piece_id]
            );
            pending.push({
              bundleCid: r.bundle_commp,
              subPieceCids: members.map((m) => m.commp),
              createdAt: r.created_at,
              attempts: r.attempts,
              status: r.status,
              reason: r.reason,
            });
          }
          return json({ pending });
        }
        if (request.method === "GET" && arg === "status") {
          const row = await this.sqlOne<{ last_error: string | null }>(`SELECT last_error FROM pending_status LIMIT 1`);
          const pending = await this.sqlAll<{
            bundle_commp: string;
            created_at: number;
            status: string | null;
            reason: string | null;
          }>(
            `SELECT p.commp AS bundle_commp, pa.created_at, pa.status, pa.reason
               FROM pending_adds pa
               JOIN pieces p ON p.id = pa.piece_id
              ORDER BY pa.created_at ASC`
          );
          const now = Date.now();
          const active = pending.filter((p) => p.status !== "stale");
          const oldest = active[0]?.created_at ?? pending[0]?.created_at;
          const kick = await this.sqlOne<{ value: string }>(`SELECT value FROM meta WHERE key = 'force_drain'`);
          const decision = shouldDrainBatch({
            nowMs: now,
            oldestCreatedAt: oldest != null ? Number(oldest) : null,
            pendingCount: active.length,
            windowMs: batchWindowMs(this.env),
            maxPieces: batchMaxPieces(this.env),
            force: kick?.value === "1",
          });
          return json({
            lastError: row?.last_error ?? null,
            pending: pending.length,
            oldestAgeMs: oldest != null ? Math.max(0, now - Number(oldest)) : 0,
            nextDrainAt: decision.nextDrainAt,
            stale: pending
              .filter((p) => p.status === "stale")
              .map((p) => ({
                bundleCid: p.bundle_commp,
                reason: p.reason,
                createdAt: p.created_at,
              })),
            reasons: pending
              .filter((p) => p.reason)
              .map((p) => ({
                bundleCid: p.bundle_commp,
                status: p.status,
                reason: p.reason,
              })),
          });
        }
        if (request.method === "POST" && arg === "success") {
          const b = (await request.json()) as { bundleCid: string };
          if (!b.bundleCid) return json({ error: "bundleCid required" }, { status: 400 });
          await this.sqlRun(
            `DELETE FROM pending_adds WHERE piece_id = (SELECT id FROM pieces WHERE commp = ?)`,
            [b.bundleCid]
          );
          await this.sqlRun(`UPDATE pending_status SET last_error = NULL, updated_at = strftime('%s','now')*1000`);
          return json({ ok: true });
        }
      }
      return new Response("method not allowed", { status: 405 });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 500 });
    }
  }

  async ensureSchema(): Promise<void> {
    const db = (this.state.storage as any).sql;
    // Refs table
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS refs (
        name TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        root_tree TEXT
      )`
    );
    try { db.exec?.(`ALTER TABLE refs ADD COLUMN root_tree TEXT`); } catch { /* exists */ }
    try {
      db.exec?.(
        `UPDATE refs SET root_tree = (
           SELECT c.root_tree FROM changesets c WHERE c.id = refs.target
         ) WHERE root_tree IS NULL`
      );
    } catch { /* changesets may not exist yet on first boot */ }
    // Changesets table
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS changesets (
        id TEXT PRIMARY KEY,
        lsn INTEGER NOT NULL,
        root_tree TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    );
    await db.exec?.(`CREATE INDEX IF NOT EXISTS idx_changesets_lsn ON changesets(lsn)`);
    try { db.exec?.(`CREATE UNIQUE INDEX IF NOT EXISTS idx_changesets_lsn_unique ON changesets(lsn)`); } catch { /* duplicates */ }
    // COMMP identity + bundle/file maps (v2). Migrates v1 string columns in place.
    await ensureCommpSchema(this);
    // Small-file browse fallback when the piece map has no row. Not the storage plane.
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        created_at INTEGER NOT NULL
      )`
    );
    await db.exec?.(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS pending_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_error TEXT,
        updated_at INTEGER NOT NULL
      )`
    );
    await db.exec?.(
      `INSERT OR IGNORE INTO pending_status (id, last_error, updated_at) VALUES (1, NULL, strftime('%s','now')*1000)`
    );
  }

  async sqlAll<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = (this.state.storage as any).sql;
    return db.exec(sql, ...params).toArray() as T[];
  }

  async sqlOne<T extends Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.sqlAll<T>(sql, params);
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  async sqlRun(sql: string, params: unknown[] = []): Promise<void> {
    const db = (this.state.storage as any).sql;
    db.exec(sql, ...params);
  }
}

// Alarm: process pending_adds in batches, calling container admin add-pieces
// and backing off on failure. Best-effort; durable state ensures retries.
(RepoDO as any).prototype.alarm = async function alarm(this: RepoDO) {
  try {
    await this.ensureSchema();
    const orgRow = await this.sqlOne<{ value: string }>(`SELECT value FROM meta WHERE key = 'org'`);
    const org = orgRow?.value;
    if (!org) return;
    const now = Date.now();
    const windowMs = batchWindowMs(this.env);
    const maxPieces = batchMaxPieces(this.env);
    await runDurabilityWatchdog(this, now, windowMs);
    const kick = await this.sqlOne<{ value: string }>(`SELECT value FROM meta WHERE key = 'force_drain'`);
    const force = kick?.value === "1";
    if (force) {
      await this.sqlRun(`DELETE FROM meta WHERE key = 'force_drain'`);
    }
    const pending = await this.sqlAll<{
      bundle_commp: string;
      created_at: number;
      next_at: number;
      size_bytes: number | null;
    }>(
      `SELECT p.commp AS bundle_commp, pa.created_at, pa.next_at, pa.size_bytes
         FROM pending_adds pa
         JOIN pieces p ON p.id = pa.piece_id
        WHERE COALESCE(pa.status, '') != 'stale'
        ORDER BY pa.created_at ASC`
    );
    const ready = force ? pending : pending.filter((p) => Number(p.next_at) <= now);
    const oldest = (force ? pending[0]?.created_at : ready[0]?.created_at) ?? pending[0]?.created_at;
    const decision = shouldDrainBatch({
      nowMs: now,
      oldestCreatedAt: oldest != null ? Number(oldest) : null,
      pendingCount: force ? pending.length : ready.length,
      windowMs,
      maxPieces,
      force,
    });
    if (!decision.drain) {
      let alarmAt = decision.nextDrainAt ?? now + 30_000;
      const nextRetry = pending
        .map((p) => Number(p.next_at))
        .filter((t) => t > now)
        .sort((a, b) => a - b)[0];
      if (nextRetry != null) alarmAt = Math.min(alarmAt, nextRetry);
      await this.state.storage.setAlarm(Math.max(now + 1000, alarmAt));
      return;
    }
    const due = (force ? pending : ready).slice(0, decision.take);
    const pieces = due.map((r) => r.bundle_commp);
    if (!(this.env.ENGINE as DurableObjectNamespace | undefined) || pieces.length === 0) return;
    // One engine container serves every org. add-pieces targets the resolved
    // dataset org (shared platform dataset by default; never create in shared mode).
    const resolved = await loadDatasetResolution(this.env, org);
    const platformOrg = "filecoin-project";
    const id = (this.env.ENGINE as DurableObjectNamespace).idFromName(platformOrg);
    const stub = (this.env.ENGINE as DurableObjectNamespace).get(id);
    const headers = new Headers({ "content-type": "application/json" });
    if (this.env.ADMIN_TOKEN) headers.set("x-admin-token", this.env.ADMIN_TOKEN);
    const resp = await stub.fetch(
      new Request(`http://engine/orgs/${platformOrg}/v1/admin/add-pieces`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          org: resolved.datasetOrg,
          pieces,
          allow_create: resolved.allowCreate,
        }),
      })
    );
    if (resp.ok) {
      let addedBytes = 0;
      for (const r of due) {
        addedBytes += await bundleSizeBytes(this, r.bundle_commp, r.size_bytes);
        await this.sqlRun(
          `DELETE FROM pending_adds WHERE piece_id = (SELECT id FROM pieces WHERE commp = ?)`,
          [r.bundle_commp]
        );
      }
      await addDatasetUsage(this.env, resolved.datasetOrg, addedBytes, Date.now());
      await this.sqlRun(`UPDATE pending_status SET last_error = NULL, updated_at = ?`, [Date.now()]);
      const more = await this.sqlOne<{ c: number }>(
        `SELECT COUNT(1) as c FROM pending_adds WHERE COALESCE(status, '') != 'stale'`
      );
      if ((more?.c ?? 0) > 0) {
        await this.state.storage.setAlarm(Date.now() + 2000);
      }
      return;
    }
    const text = await resp.text();
    let err = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { message?: string; code?: string };
      if (parsed.message) err = parsed.message.slice(0, 400);
    } catch { /* keep raw */ }
    await this.sqlRun(`UPDATE pending_status SET last_error = ?, updated_at = ?`, [err, Date.now()]);
    for (const r of due) {
      // backoff = min(1h, 30s * 2^attempts_next)
      const row = await this.sqlOne<{ attempts: number }>(
        `SELECT pa.attempts AS attempts
           FROM pending_adds pa
           JOIN pieces p ON p.id = pa.piece_id
          WHERE p.commp = ?`,
        [r.bundle_commp]
      );
      const attemptsNext = (row?.attempts ?? 0) + 1;
      const delay = Math.min(3600_000, 30_000 * Math.pow(2, attemptsNext));
      await this.sqlRun(
        `UPDATE pending_adds SET attempts = ?, next_at = ?, reason = ?
          WHERE piece_id = (SELECT id FROM pieces WHERE commp = ?)`,
        [attemptsNext, Date.now() + delay, err, r.bundle_commp]
      );
    }
    await this.state.storage.setAlarm(Date.now() + 30_000);
  } catch (e) {
    await this.sqlRun(`UPDATE pending_status SET last_error = ?, updated_at = ?`, [
      (e as Error).message?.slice(0, 300) ?? "alarm error",
      Date.now()
    ]);
    await this.state.storage.setAlarm(Date.now() + 60_000);
  }
};

async function bundleSizeBytes(
  repo: RepoDO,
  pieceCid: string,
  stored: number | null | undefined
): Promise<number> {
  if (stored != null && Number(stored) > 0) return paddedBundleSize(Number(stored));
  const members = await repo.sqlAll<{ length: number }>(
    `SELECT m.length AS length
       FROM bundle_members m
       JOIN pieces p ON p.id = m.bundle_id
      WHERE p.commp = ?`,
    [pieceCid]
  );
  return paddedBundleSize(members.reduce((sum, m) => sum + Number(m.length || 0), 0));
}

async function runDurabilityWatchdog(repo: RepoDO, now: number, windowMs: number): Promise<void> {
  const old = await repo.sqlAll<{
    bundle_commp: string;
    created_at: number;
    status: string | null;
    reason: string | null;
  }>(
    `SELECT p.commp AS bundle_commp, pa.created_at, pa.status, pa.reason
       FROM pending_adds pa
       JOIN pieces p ON p.id = pa.piece_id
      WHERE pa.created_at < ?`,
    [now - Math.max(windowMs, 1)]
  );
  for (const row of old) {
    const decision = staleAction(
      {
        bundleCid: row.bundle_commp,
        createdAt: Number(row.created_at),
        status: row.status,
        reason: row.reason,
      },
      now,
      await bundleBytesAvailable(repo, row.bundle_commp),
      windowMs
    );
    if (!decision) continue;
    if (decision.action === "retry") {
      await repo.sqlRun(
        `UPDATE pending_adds SET next_at = 0, status = NULL, reason = ?
          WHERE piece_id = (SELECT id FROM pieces WHERE commp = ?)`,
        [decision.reason, row.bundle_commp]
      );
    } else {
      await repo.sqlRun(
        `UPDATE pending_adds SET status = 'stale', reason = ?
          WHERE piece_id = (SELECT id FROM pieces WHERE commp = ?)`,
        [decision.reason, row.bundle_commp]
      );
    }
  }
}

async function bundleBytesAvailable(repo: RepoDO, pieceCid: string): Promise<boolean> {
  if (!(repo.env.ENGINE as DurableObjectNamespace | undefined)) return false;
  try {
    const platformOrg = "filecoin-project";
    const id = (repo.env.ENGINE as DurableObjectNamespace).idFromName(platformOrg);
    const stub = (repo.env.ENGINE as DurableObjectNamespace).get(id);
    const headers = new Headers();
    if (repo.env.ADMIN_TOKEN) headers.set("x-admin-token", repo.env.ADMIN_TOKEN);
    const resp = await stub.fetch(
      new Request(`http://engine/orgs/${platformOrg}/v1/filecoin/pieces/${encodeURIComponent(pieceCid)}/bytes`, {
        method: "GET",
        headers,
      })
    );
    return resp.ok;
  } catch {
    return false;
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

