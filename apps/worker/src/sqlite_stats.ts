/** RepoDO SQLite size snapshot via `sql.databaseSize` (PRAGMA page_count is AUTH). */

import { COMMP_SCHEMA_KEY, type RepoSql } from "./pieces";

export const DEFAULT_PAGE_SIZE = 4096;

/**
 * ActorSqlite `BEGIN`s every non-readonly statement (including VACUUM) before
 * it runs, so `VACUUM` always fails with SQLITE_ERROR. `PRAGMA incremental_vacuum`
 * is SQLITE_AUTH. Do not fake `vacuumed: true`.
 */
export const VACUUM_UNAVAILABLE =
  "VACUUM is impossible on Cloudflare Durable Object SQLite: ActorSqlite BEGIN-wraps every non-readonly statement before it runs; PRAGMA incremental_vacuum is SQLITE_AUTH. sql.databaseSize is (page_count-freelist_count)*page_size; commit via storage.sync so auto_vacuum can apply before the after snapshot";

export type SizeSource = "databaseSize" | "pragma";

export type SqliteSizeSnapshot = {
  page_count: number;
  page_size: number;
  freelist_count: number;
  used_bytes: number;
  file_bytes: number;
  commp_schema: string | null;
  /** How bytes were obtained. `databaseSize` is the live CF path. */
  size_source: SizeSource;
  /**
   * False on CF: `PRAGMA freelist_count` is SQLITE_AUTH, and
   * `databaseSize` already subtracts freelist pages.
   */
  freelist_readable: boolean;
};

export type ReclaimResult = { vacuumed: true } | { vacuumed: false; error: string };

export type SqliteMigrateResponse = {
  org: string;
  repo: string;
  before: SqliteSizeSnapshot;
  after: SqliteSizeSnapshot;
  migrated: boolean;
  /** True only when VACUUM actually succeeded. Never faked. */
  vacuumed: boolean;
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
    size_source: "pragma",
    freelist_readable: true,
  };
}

/** CF `sql.databaseSize` is `(page_count - freelist_count) * page_size`. */
export function snapshotFromDatabaseSize(input: {
  database_bytes: number;
  page_size?: number;
  commp_schema?: string | null;
}): SqliteSizeSnapshot {
  const page_size = input.page_size && input.page_size > 0 ? Number(input.page_size) : DEFAULT_PAGE_SIZE;
  const used_bytes = Math.max(0, Number(input.database_bytes) || 0);
  return {
    page_count: page_size > 0 ? Math.floor(used_bytes / page_size) : 0,
    page_size,
    freelist_count: 0,
    used_bytes,
    file_bytes: used_bytes,
    commp_schema: input.commp_schema ?? null,
    size_source: "databaseSize",
    freelist_readable: false,
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
  reclaim: ReclaimResult = { vacuumed: false, error: VACUUM_UNAVAILABLE }
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
  if (!reclaim.vacuumed) body.vacuum_error = reclaim.error;
  return body;
}

export function buildSqliteStatsResponse(
  org: string,
  repo: string,
  snap: SqliteSizeSnapshot
): SqliteStatsResponse {
  return { org, repo, ...snap };
}

/**
 * Yield a real I/O turn so workerd `ActorSqlite` can `kj::yield()` and
 * COMMIT the implicit write transaction.
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
  const commp_schema = await readCommpSchemaVersion(sql);
  const page_size = (await readPragmaNumber(sql, "page_size")) || DEFAULT_PAGE_SIZE;
  if (typeof sql.databaseSize === "function") {
    return snapshotFromDatabaseSize({
      database_bytes: sql.databaseSize(),
      page_size,
      commp_schema,
    });
  }
  // Unit-test / non-CF fallback. Live DO rejects page_count and freelist_count (SQLITE_AUTH).
  const page_count = await readPragmaNumber(sql, "page_count");
  const freelist_count = await readPragmaNumber(sql, "freelist_count");
  return snapshotFromPragmas({ page_count, page_size, freelist_count, commp_schema });
}

/**
 * Flush implicit writes so auto_vacuum can apply. Does not run VACUUM —
 * that cannot succeed on ActorSqlite. Never reports vacuumed:true.
 */
export async function attemptReclaim(sql: RepoSql): Promise<ReclaimResult> {
  await commitImplicitWrites(sql);
  return { vacuumed: false, error: VACUUM_UNAVAILABLE };
}
