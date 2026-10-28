/** Canonical COMMP PieceCID table for per-repo Durable Object SQLite.
 *
 * Schema version 2 (`meta.commp_schema`): one `pieces(id, commp)` row per
 * CID this repo has ever used. Bundles, members, pending adds, and the tip
 * `file_pieces` map store integer FKs — they never re-store the CID string.
 *
 * External APIs still speak COMMP strings (`bafk…`). Intern on write, JOIN
 * on read. Blake3 `objects.id` is VCS content addressing (trees/changesets),
 * not Filecoin piece identity, and is left alone.
 */

export const COMMP_SCHEMA_VERSION = "2";
export const COMMP_SCHEMA_KEY = "commp_schema";

export type RepoSql = {
  sqlAll<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  sqlOne<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  sqlRun(sql: string, params?: unknown[]): Promise<void>;
  /** CF `SqlStorage.databaseSize` — used pages × page size. */
  databaseSize?: () => number;
  /** Commit implicit DO writes (`storage.sync` + event-loop yield). */
  syncWrites?: () => Promise<void>;
};

/** DDL for the v2 COMMP identity tables. Applied one statement at a time. */
export const COMMP_DDL = [
  `CREATE TABLE IF NOT EXISTS pieces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        commp TEXT NOT NULL UNIQUE
      )`,
  `CREATE TABLE IF NOT EXISTS bundles (
        piece_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(piece_id) REFERENCES pieces(id) ON DELETE CASCADE
      )`,
  `CREATE TABLE IF NOT EXISTS bundle_members (
        bundle_id INTEGER NOT NULL,
        piece_id INTEGER NOT NULL,
        "offset" INTEGER NOT NULL,
        length INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(bundle_id, piece_id),
        FOREIGN KEY(bundle_id) REFERENCES bundles(piece_id) ON DELETE CASCADE,
        FOREIGN KEY(piece_id) REFERENCES pieces(id)
      )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_member_piece_unique ON bundle_members(piece_id)`,
  `CREATE TABLE IF NOT EXISTS pending_adds (
        piece_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
        status TEXT,
        reason TEXT,
        size_bytes INTEGER,
        FOREIGN KEY(piece_id) REFERENCES pieces(id) ON DELETE CASCADE
      )`,
  `CREATE TABLE IF NOT EXISTS file_pieces (
        path TEXT PRIMARY KEY,
        piece_id INTEGER NOT NULL,
        FOREIGN KEY(piece_id) REFERENCES pieces(id)
      )`,
] as const;

export function normalizeCommp(commp: string): string {
  const cid = commp.trim();
  if (!cid) throw new Error("empty commp");
  return cid;
}

/** Insert-or-lookup a COMMP string; returns the integer primary key. */
export async function internPiece(sql: RepoSql, commp: string): Promise<number> {
  const cid = normalizeCommp(commp);
  await sql.sqlRun(`INSERT OR IGNORE INTO pieces (commp) VALUES (?)`, [cid]);
  const row = await sql.sqlOne<{ id: number }>(`SELECT id FROM pieces WHERE commp = ? LIMIT 1`, [cid]);
  if (row == null || row.id == null) throw new Error("intern piece failed");
  return Number(row.id);
}

export type FileMapUpsert = { path: string; pieceCid: string };

/** Apply tip-map upserts and deletes. Paths are repo-relative, no leading slash. */
export async function applyFileMap(
  sql: RepoSql,
  upserts: FileMapUpsert[],
  deletes: string[]
): Promise<{ upserted: number; deleted: number }> {
  let upserted = 0;
  for (const row of upserts) {
    const path = row.path.trim().replace(/^\/+/, "");
    if (!path) continue;
    const id = await internPiece(sql, row.pieceCid);
    await sql.sqlRun(`INSERT OR REPLACE INTO file_pieces (path, piece_id) VALUES (?, ?)`, [path, id]);
    upserted += 1;
  }
  let deleted = 0;
  for (const raw of deletes) {
    const path = raw.trim().replace(/^\/+/, "");
    if (!path) continue;
    await sql.sqlRun(`DELETE FROM file_pieces WHERE path = ?`, [path]);
    deleted += 1;
  }
  return { upserted, deleted };
}

export async function listFileMap(sql: RepoSql): Promise<FileMapUpsert[]> {
  const rows = await sql.sqlAll<{ path: string; commp: string }>(
    `SELECT f.path AS path, p.commp AS commp
       FROM file_pieces f
       JOIN pieces p ON p.id = f.piece_id
      ORDER BY f.path ASC`
  );
  return rows.map((r) => ({ path: String(r.path), pieceCid: String(r.commp) }));
}

export async function lookupFilePiece(sql: RepoSql, path: string): Promise<string | null> {
  const cleaned = path.trim().replace(/^\/+/, "");
  if (!cleaned) return null;
  const row = await sql.sqlOne<{ commp: string }>(
    `SELECT p.commp AS commp
       FROM file_pieces f
       JOIN pieces p ON p.id = f.piece_id
      WHERE f.path = ?
      LIMIT 1`,
    [cleaned]
  );
  return row?.commp ? String(row.commp) : null;
}

type ColInfo = { name?: string };

async function tableColumns(sql: RepoSql, table: string): Promise<string[]> {
  const rows = await sql.sqlAll<ColInfo>(`PRAGMA table_info(${table})`);
  return rows.map((r) => String(r.name ?? "")).filter(Boolean);
}

async function tableExists(sql: RepoSql, table: string): Promise<boolean> {
  const row = await sql.sqlOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    [table]
  );
  return !!row?.name;
}

/** Extract `pcid:<path>` entries from a changeset JSON body. */
export function pcidEntriesFromChangesetBody(body: string): FileMapUpsert[] {
  let parsed: { metadata?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body) as { metadata?: Record<string, unknown> };
  } catch {
    return [];
  }
  const out: FileMapUpsert[] = [];
  const meta = parsed.metadata ?? {};
  for (const [key, value] of Object.entries(meta)) {
    if (!key.startsWith("pcid:")) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    const path = key.slice("pcid:".length);
    if (!path) continue;
    out.push({ path, pieceCid: value });
  }
  return out;
}

/**
 * Reconstruct the tip path→COMMP map from leftover changeset `pcid:`
 * snapshots. Old clients wrote a full snapshot on every commit, so the
 * newest body that still has `pcid:` keys is the tip. Incremental bodies
 * (post-cutover, empty metadata) are skipped.
 */
export function foldPcidSnapshots(rows: { lsn: number; body: string }[]): Map<string, string> {
  const sorted = [...rows].sort((a, b) => a.lsn - b.lsn);
  let latest: FileMapUpsert[] = [];
  for (const row of sorted) {
    const entries = pcidEntriesFromChangesetBody(row.body);
    if (entries.length > 0) latest = entries;
  }
  return new Map(latest.map((e) => [e.path, e.pieceCid]));
}

async function internAll(sql: RepoSql, cids: Iterable<string>): Promise<void> {
  for (const cid of cids) {
    if (!cid || !String(cid).trim()) continue;
    try {
      await internPiece(sql, String(cid));
    } catch {
      /* skip empty / bad */
    }
  }
}

/**
 * Bring this DO up to `commp_schema=2`. Safe to call on every request:
 * already-v2 DOs just CREATE IF NOT EXISTS. v1 string-keyed tables are
 * renamed, interned, and recreated with FKs. Live `pcid:` changeset
 * metadata is folded into `file_pieces` once so calibnet tips stay readable.
 */
export async function ensureCommpSchema(sql: RepoSql): Promise<void> {
  await sql.sqlRun(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await sql.sqlRun(`CREATE TABLE IF NOT EXISTS pieces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        commp TEXT NOT NULL UNIQUE
      )`);

  const schema = await sql.sqlOne<{ value: string }>(
    `SELECT value FROM meta WHERE key = ? LIMIT 1`,
    [COMMP_SCHEMA_KEY]
  );
  const bundlesCols = (await tableExists(sql, "bundles")) ? await tableColumns(sql, "bundles") : [];
  const isV1 = bundlesCols.includes("piece_cid");
  const isV2 = bundlesCols.includes("piece_id") || schema?.value === COMMP_SCHEMA_VERSION;

  if (isV1) {
    await migrateV1ToV2(sql);
  } else if (!isV2) {
    for (const stmt of COMMP_DDL) {
      await sql.sqlRun(stmt);
    }
  } else {
    for (const stmt of COMMP_DDL) {
      await sql.sqlRun(stmt);
    }
  }

  await sql.sqlRun(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [
    COMMP_SCHEMA_KEY,
    COMMP_SCHEMA_VERSION,
  ]);
}

async function migrateV1ToV2(sql: RepoSql): Promise<void> {
  // Drop a half-finished retry, then intern every CID string we know about.
  for (const t of ["bundle_members_v2", "bundles_v2", "pending_adds_v2"]) {
    if (await tableExists(sql, t)) {
      await sql.sqlRun(`DROP TABLE ${t}`);
    }
  }

  const bundleCids = await sql.sqlAll<{ piece_cid: string }>(`SELECT piece_cid FROM bundles`);
  const memberCids = await sql.sqlAll<{ bundle_piece_cid: string; piece_cid: string }>(
    `SELECT bundle_piece_cid, piece_cid FROM bundle_members`
  );
  const pendingCids = await sql.sqlAll<{ bundle_piece_cid: string; sub_pieces?: string }>(
    `SELECT bundle_piece_cid, sub_pieces FROM pending_adds`
  );
  const cids = new Set<string>();
  for (const r of bundleCids) cids.add(String(r.piece_cid));
  for (const r of memberCids) {
    cids.add(String(r.bundle_piece_cid));
    cids.add(String(r.piece_cid));
  }
  for (const r of pendingCids) {
    cids.add(String(r.bundle_piece_cid));
    if (r.sub_pieces) {
      try {
        const arr = JSON.parse(String(r.sub_pieces)) as unknown;
        if (Array.isArray(arr)) {
          for (const x of arr) if (typeof x === "string") cids.add(x);
        }
      } catch {
        /* ignore */
      }
    }
  }
  await internAll(sql, cids);

  await sql.sqlRun(
    `CREATE TABLE bundles_v2 (
        piece_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(piece_id) REFERENCES pieces(id) ON DELETE CASCADE
      )`
  );
  await sql.sqlRun(
    `INSERT INTO bundles_v2 (piece_id, created_at)
     SELECT p.id, b.created_at FROM bundles b JOIN pieces p ON p.commp = b.piece_cid`
  );

  await sql.sqlRun(
    `CREATE TABLE bundle_members_v2 (
        bundle_id INTEGER NOT NULL,
        piece_id INTEGER NOT NULL,
        "offset" INTEGER NOT NULL,
        length INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(bundle_id, piece_id),
        FOREIGN KEY(bundle_id) REFERENCES bundles_v2(piece_id) ON DELETE CASCADE,
        FOREIGN KEY(piece_id) REFERENCES pieces(id)
      )`
  );
  await sql.sqlRun(
    `INSERT OR IGNORE INTO bundle_members_v2 (bundle_id, piece_id, "offset", length, created_at)
     SELECT bp.id, mp.id, m."offset", m.length, m.created_at
       FROM bundle_members m
       JOIN pieces bp ON bp.commp = m.bundle_piece_cid
       JOIN pieces mp ON mp.commp = m.piece_cid`
  );
  try {
    await sql.sqlRun(`CREATE UNIQUE INDEX idx_bundle_member_piece_unique ON bundle_members_v2(piece_id)`);
  } catch {
    /* leftover duplicate member CIDs: keep first via INSERT OR IGNORE */
  }

  await sql.sqlRun(
    `CREATE TABLE pending_adds_v2 (
        piece_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
        status TEXT,
        reason TEXT,
        size_bytes INTEGER,
        FOREIGN KEY(piece_id) REFERENCES pieces(id) ON DELETE CASCADE
      )`
  );
  await sql.sqlRun(
    `INSERT OR IGNORE INTO pending_adds_v2 (piece_id, created_at, attempts, next_at, status, reason, size_bytes)
     SELECT p.id, pa.created_at, pa.attempts, pa.next_at, pa.status, pa.reason, pa.size_bytes
       FROM pending_adds pa
       JOIN pieces p ON p.commp = pa.bundle_piece_cid`
  );

  await sql.sqlRun(`DROP TABLE bundle_members`);
  await sql.sqlRun(`DROP TABLE pending_adds`);
  await sql.sqlRun(`DROP TABLE bundles`);
  await sql.sqlRun(`ALTER TABLE bundles_v2 RENAME TO bundles`);
  await sql.sqlRun(`ALTER TABLE bundle_members_v2 RENAME TO bundle_members`);
  await sql.sqlRun(`ALTER TABLE pending_adds_v2 RENAME TO pending_adds`);

  await sql.sqlRun(
    `CREATE TABLE IF NOT EXISTS file_pieces (
        path TEXT PRIMARY KEY,
        piece_id INTEGER NOT NULL,
        FOREIGN KEY(piece_id) REFERENCES pieces(id)
      )`
  );

  // Reconstruct the tip path→COMMP map from leftover changeset `pcid:` snapshots
  // so a live calibnet repo stays browseable after the cutover.
  let changesets: { lsn: number; body: string }[] = [];
  try {
    changesets = await sql.sqlAll<{ lsn: number; body: string }>(
      `SELECT lsn, body FROM changesets ORDER BY lsn ASC`
    );
  } catch {
    changesets = [];
  }
  const tip = foldPcidSnapshots(changesets);
  for (const [path, pieceCid] of tip) {
    try {
      const id = await internPiece(sql, pieceCid);
      await sql.sqlRun(`INSERT OR REPLACE INTO file_pieces (path, piece_id) VALUES (?, ?)`, [path, id]);
    } catch {
      /* skip */
    }
  }
}
