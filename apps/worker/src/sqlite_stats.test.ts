//! Measure helpers and sqlite-migrate / sqlite-stats response shape.

import type { RepoSql } from "./pieces";
import {
  DEFAULT_PAGE_SIZE,
  VACUUM_UNAVAILABLE,
  attemptReclaim,
  buildSqliteMigrateResponse,
  buildSqliteStatsResponse,
  firstPragmaNumber,
  readCommpSchemaVersion,
  readSqliteSize,
  schemaWasBelowV2,
  snapshotFromDatabaseSize,
  snapshotFromPragmas,
} from "./sqlite_stats";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

ok(firstPragmaNumber([], "page_count") === 0, "empty pragma rows are 0");
ok(firstPragmaNumber([{ page_count: 12 }], "page_count") === 12, "named pragma column");
ok(firstPragmaNumber([{ page_size: "4096" }], "page_size") === 4096, "string pragma value");
ok(firstPragmaNumber([{ n: 7 }], "freelist_count") === 7, "first numeric fallback");
ok(firstPragmaNumber([{ page_count: "nope", n: 3 }], "page_count") === 3, "non-numeric named falls back");

const snap = snapshotFromPragmas({
  page_count: 100,
  page_size: 4096,
  freelist_count: 10,
  commp_schema: "1",
});
ok(snap.file_bytes === 100 * 4096, "file_bytes is page_count * page_size");
ok(snap.used_bytes === 90 * 4096, "used_bytes subtracts freelist pages");
ok(snap.commp_schema === "1", "schema is passed through");
ok(snap.size_source === "pragma" && snap.freelist_readable, "pragma snapshot is labeled");

ok(snapshotFromPragmas({ page_count: 0, page_size: 4096, freelist_count: 0 }).commp_schema === null, "missing schema is null");

const fromDo = snapshotFromDatabaseSize({ database_bytes: 163840, page_size: 4096, commp_schema: "2" });
ok(fromDo.size_source === "databaseSize", "CF path is labeled databaseSize");
ok(fromDo.freelist_readable === false, "freelist is not readable on CF");
ok(fromDo.used_bytes === 163840 && fromDo.file_bytes === 163840, "databaseSize is used bytes");
ok(fromDo.page_count === 40, "page_count is used pages from databaseSize / page_size");
ok(fromDo.freelist_count === 0, "freelist stays 0 when unread");
ok(snapshotFromDatabaseSize({ database_bytes: 100 }).page_size === DEFAULT_PAGE_SIZE, "default page_size");

ok(schemaWasBelowV2(null), "missing schema needs migrate");
ok(schemaWasBelowV2(""), "empty schema needs migrate");
ok(schemaWasBelowV2("1"), "v1 needs migrate");
ok(schemaWasBelowV2("0"), "v0 needs migrate");
ok(!schemaWasBelowV2("2"), "v2 does not need migrate");
ok(!schemaWasBelowV2("3"), "schema >2 is already migrated");
ok(schemaWasBelowV2("nope"), "non-numeric schema needs migrate");

const before = snapshotFromDatabaseSize({ database_bytes: 819200, page_size: 4096, commp_schema: "1" });
const after = snapshotFromDatabaseSize({ database_bytes: 163840, page_size: 4096, commp_schema: "2" });
const migrate = buildSqliteMigrateResponse("andy", "synapse-201438", before, after);
ok(migrate.org === "andy" && migrate.repo === "synapse-201438", "org/repo echoed");
ok(migrate.before === before && migrate.after === after, "before/after snapshots");
ok(migrate.migrated === true, "migrated when schema was <2");
ok(migrate.vacuumed === false, "default reclaim does not fake vacuumed");
ok(migrate.vacuum_error === VACUUM_UNAVAILABLE, "vacuum_error explains ActorSqlite limit");
ok(migrate.delta_file_bytes === after.file_bytes - before.file_bytes, "delta_file_bytes");
ok(migrate.delta_used_bytes === after.used_bytes - before.used_bytes, "delta_used_bytes");
ok(migrate.delta_used_bytes < 0, "intern/migrate can reduce used bytes");

const already = buildSqliteMigrateResponse(
  "o",
  "r",
  snapshotFromDatabaseSize({ database_bytes: 40960, commp_schema: "2" }),
  snapshotFromDatabaseSize({ database_bytes: 40960, commp_schema: "2" })
);
ok(already.migrated === false, "already-v2 is not migrated");
ok(already.delta_file_bytes === 0 && already.delta_used_bytes === 0, "no-op deltas are zero");
ok(already.vacuumed === false, "already-v2 still cannot VACUUM");

const fakeOk = buildSqliteMigrateResponse("o", "r", before, after, { vacuumed: true });
ok(fakeOk.vacuumed === true && fakeOk.vacuum_error === undefined, "explicit success keeps vacuumed");

const stats = buildSqliteStatsResponse("andy", "demo", fromDo);
ok(stats.org === "andy" && stats.repo === "demo", "stats org/repo");
ok(stats.page_count === 40 && stats.page_size === 4096, "stats includes derived pages");
ok(stats.used_bytes === 163840 && stats.size_source === "databaseSize", "stats includes databaseSize");

ok(VACUUM_UNAVAILABLE.includes("BEGIN-wraps"), "unavailable reason mentions BEGIN wrap");
ok(VACUUM_UNAVAILABLE.includes("SQLITE_AUTH"), "unavailable reason mentions incremental AUTH");

class AuthPragmaSql implements RepoSql {
  schema: string | null = "1";
  bytes = 204800;
  syncs = 0;

  databaseSize(): number {
    return this.bytes;
  }

  async syncWrites(): Promise<void> {
    this.syncs += 1;
  }

  async sqlAll<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql === "PRAGMA page_size") return [{ page_size: 4096 }] as T[];
    if (sql === "PRAGMA page_count" || sql === "PRAGMA freelist_count") {
      throw new Error("not authorized: SQLITE_AUTH");
    }
    if (sql.includes("FROM meta WHERE key")) {
      const key = String(params[0]);
      if (key === "commp_schema" && this.schema != null) return [{ value: this.schema }] as T[];
      return [];
    }
    return [];
  }

  async sqlOne<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.sqlAll<T>(sql, params);
    return rows[0] ?? null;
  }

  async sqlRun(_sql: string, _params: unknown[] = []): Promise<void> {}
}

const live = new AuthPragmaSql();
const liveSize = await readSqliteSize(live);
ok(liveSize.size_source === "databaseSize", "AUTH pragmas still use databaseSize");
ok(liveSize.used_bytes === 204800 && liveSize.file_bytes === 204800, "lotus-sized DO is not zero");
ok(liveSize.page_count === 50, "page_count derived from databaseSize");
ok(liveSize.page_size === 4096, "page_size PRAGMA is allowed");
ok(liveSize.freelist_readable === false, "freelist not claimed");
ok(liveSize.commp_schema === "1", "schema still read from meta");

live.schema = null;
ok((await readCommpSchemaVersion(live)) === null, "missing commp_schema row is null");

const reclaim = await attemptReclaim(live);
ok(reclaim.vacuumed === false, "attemptReclaim never fakes vacuumed");
ok(reclaim.error === VACUUM_UNAVAILABLE, "attemptReclaim states VACUUM is impossible");
ok(live.syncs === 1, "attemptReclaim commits implicit writes");

class PragmaOnlySql implements RepoSql {
  async sqlAll<T extends Record<string, unknown>>(sql: string, _params?: unknown[]): Promise<T[]> {
    if (sql.startsWith("PRAGMA ")) {
      const name = sql.slice("PRAGMA ".length).trim();
      const vals: Record<string, number> = { page_count: 50, page_size: 4096, freelist_count: 5 };
      return [{ [name]: vals[name] ?? 0 }] as T[];
    }
    return [];
  }
  async sqlOne<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    return (await this.sqlAll<T>(sql, params))[0] ?? null;
  }
  async sqlRun(): Promise<void> {}
}

const pragmaSize = await readSqliteSize(new PragmaOnlySql());
ok(pragmaSize.size_source === "pragma", "tests without databaseSize keep pragma fallback");
ok(pragmaSize.used_bytes === 45 * 4096 && pragmaSize.file_bytes === 50 * 4096, "pragma fallback computes both");

console.log("sqlite stats ok");
