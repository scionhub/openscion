/** RepoDO SQLite size snapshot: page pragmas, used vs file bytes, COMMP schema. */

import { COMMP_SCHEMA_KEY, type RepoSql } from "./pieces";

/** `VACUUM` as issued after `ensureCommpSchema` so freelist reclaim is visible. */
export const VACUUM_SQL = "VACUUM";

/** Freelist reclaim that SQLite allows inside a transaction (needs incremental auto_vacuum). */
export const INCREMENTAL_VACUUM_SQL = "PRAGMA incremental_vacuum";

export type SqliteSizeSnapshot = {
  page_count: number;
  page_size: number;
  freelist_count: number;
  used_bytes: number;
  file_bytes: number;
  commp_schema: string | null;
};

export type ReclaimKind = "vacuum" | "incremental_vacuum";

export type ReclaimResult =
  | { vacuumed: true; kind: ReclaimKind }
  | { vacuumed: false; error: string };

export type SqliteMigrateResponse = {
  org: string;
  repo: string;
  before: SqliteSizeSnapshot;
  after: SqliteSizeSnapshot;
  migrated: boolean;
  /** True only when a reclaim statement actually succeeded. Never faked. */
  vacuumed: boolean;
  /** Which reclaim statement ran; omitted when neither succeeded. */
  reclaim?: ReclaimKind;
  /** Present when `vacuumed` is false. */
  vacuum_error?: string;
  delta_file_bytes: number;
  delta_used_bytes: number;
};

export type SqliteStatsResponse = SqliteSizeSnapshot & {
  org: string;
  repo: string;
};

/** Pull a numeric PRAGMA value from `sql.exec().toArray()` row shapes. */
export function firstPragmaNumber(rows: Record<string, unknown>[], name: string): number {
  const row = rows[0];
  if (!row) return 0;
  const named = row[name];
  if (named != null && Number.isFinite(Number(named))) return Number(named);
  for (const v of Object.values(row)) {
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
}

export function snapshotFromPragmas(input: {
  page_count: number;
  page_size: number;
  freelist_count: number;
  commp_schema?: string | null;
}): SqliteSizeSnapshot {
  const page_count = Number(input.page_count) || 0;
  const page_size = Number(input.page_size) || 0;
  const freelist_count = Number(input.freelist_count) || 0;
  return {
    page_count,
    page_size,
    freelist_count,
    used_bytes: (page_count - freelist_count) * page_size,
    file_bytes: page_count * page_size,
    commp_schema: input.commp_schema ?? null,
  };
}

/** True when `meta.commp_schema` is missing or a number less than 2. */
export function schemaWasBelowV2(schema: string | null | undefined): boolean {
  if (schema == null || schema === "") return true;
  const n = Number(schema);
  if (!Number.isFinite(n)) return true;
  return n < 2;
}

export function buildSqliteMigrateResponse(
  org: string,
  repo: string,
  before: SqliteSizeSnapshot,
  after: SqliteSizeSnapshot,
  reclaim: ReclaimResult = { vacuumed: true, kind: "vacuum" }
): SqliteMigrateResponse {
  const body: SqliteMigrateResponse = {
    org,
    repo,
    before,
    after,
    migrated: schemaWasBelowV2(before.commp_schema),
    vacuumed: reclaim.vacuumed,
    delta_file_bytes: after.file_bytes - before.file_bytes,
    delta_used_bytes: after.used_bytes - before.used_bytes,
  };
  if (reclaim.vacuumed) body.reclaim = reclaim.kind;
  else body.vacuum_error = reclaim.error;
  return body;
}

export function buildSqliteStatsResponse(
  org: string,
  repo: string,
  snap: SqliteSizeSnapshot
): SqliteStatsResponse {
  return { org, repo, ...snap };
}

export function vacuumFailedError(cause: string): string {
  return `VACUUM failed: ${cause}`;
}

export function isInTransactionVacuumError(message: string): boolean {
  return /cannot vacuum from within a transaction/i.test(message);
}

/**
 * Yield a real I/O turn so workerd `ActorSqlite` can `kj::yield()` and
 * COMMIT the implicit write transaction. A resolved-Promise `await` is
 * only a microtask and does not commit.
 */
export async function yieldEventLoop(): Promise<void> {
  const sched = (globalThis as { scheduler?: { wait?: (ms: number) => Promise<void> } }).scheduler;
  if (typeof sched?.wait === "function") {
    await sched.wait(0);
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function commitImplicitWrites(sql: RepoSql): Promise<void> {
  if (sql.syncWrites) await sql.syncWrites();
  else await yieldEventLoop();
}

export async function readCommpSchemaVersion(sql: RepoSql): Promise<string | null> {
  try {
    const row = await sql.sqlOne<{ value: string }>(
      `SELECT value FROM meta WHERE key = ? LIMIT 1`,
      [COMMP_SCHEMA_KEY]
    );
    return row?.value != null && String(row.value).length > 0 ? String(row.value) : null;
  } catch {
    // meta table may not exist on an untouched or empty DO.
    return null;
  }
}

async function readPragmaNumber(sql: RepoSql, name: string): Promise<number> {
  try {
    const rows = await sql.sqlAll<Record<string, unknown>>(`PRAGMA ${name}`);
    return firstPragmaNumber(rows, name);
  } catch {
    return 0;
  }
}

export async function readSqliteSize(sql: RepoSql): Promise<SqliteSizeSnapshot> {
  const page_count = await readPragmaNumber(sql, "page_count");
  const page_size = await readPragmaNumber(sql, "page_size");
  const freelist_count = await readPragmaNumber(sql, "freelist_count");
  const commp_schema = await readCommpSchemaVersion(sql);
  return snapshotFromPragmas({ page_count, page_size, freelist_count, commp_schema });
}

/**
 * Commit implicit DO writes, then `VACUUM`. If the runtime still wraps
 * VACUUM in BEGIN, try `PRAGMA incremental_vacuum`. Does not report
 * success unless a reclaim statement actually ran.
 */
export async function attemptReclaim(sql: RepoSql): Promise<ReclaimResult> {
  await commitImplicitWrites(sql);
  try {
    await sql.sqlRun(VACUUM_SQL);
    return { vacuumed: true, kind: "vacuum" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isInTransactionVacuumError(msg)) {
      return { vacuumed: false, error: vacuumFailedError(msg) };
    }
    try {
      await commitImplicitWrites(sql);
      await sql.sqlRun(INCREMENTAL_VACUUM_SQL);
      return { vacuumed: true, kind: "incremental_vacuum" };
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      return {
        vacuumed: false,
        error: vacuumFailedError(
          `${msg}; incremental_vacuum also failed: ${msg2}`
        ),
      };
    }
  }
}

/** @deprecated Use `attemptReclaim`. Throws when reclaim cannot run. */
export async function runVacuum(sql: RepoSql): Promise<void> {
  const result = await attemptReclaim(sql);
  if (!result.vacuumed) throw new Error(result.error);
}
