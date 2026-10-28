//! Measure helpers and sqlite-migrate / sqlite-stats response shape.

import type { RepoSql } from "./pieces";
import {
  buildSqliteMigrateResponse,
  buildSqliteStatsResponse,
  firstPragmaNumber,
  readCommpSchemaVersion,
  readSqliteSize,
  runVacuum,
  schemaWasBelowV2,
  snapshotFromPragmas,
  VACUUM_SQL,
  vacuumFailedError,
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

ok(snapshotFromPragmas({ page_count: 0, page_size: 4096, freelist_count: 0 }).commp_schema === null, "missing schema is null");

ok(schemaWasBelowV2(null), "missing schema needs migrate");
ok(schemaWasBelowV2(""), "empty schema needs migrate");
ok(schemaWasBelowV2("1"), "v1 needs migrate");
ok(schemaWasBelowV2("0"), "v0 needs migrate");
ok(!schemaWasBelowV2("2"), "v2 does not need migrate");
ok(!schemaWasBelowV2("3"), "schema >2 is already migrated");
ok(schemaWasBelowV2("nope"), "non-numeric schema needs migrate");

const before = snapshotFromPragmas({
  page_count: 200,
  page_size: 4096,
  freelist_count: 80,
  commp_schema: "1",
});
const after = snapshotFromPragmas({
  page_count: 40,
  page_size: 4096,
  freelist_count: 0,
  commp_schema: "2",
});
const migrate = buildSqliteMigrateResponse("andy", "synapse-201438", before, after);
ok(migrate.org === "andy" && migrate.repo === "synapse-201438", "org/repo echoed");
ok(migrate.before === before && migrate.after === after, "before/after snapshots");
ok(migrate.migrated === true, "migrated when schema was <2");
ok(migrate.vacuumed === true, "vacuumed is true only on success path");
ok(migrate.delta_file_bytes === after.file_bytes - before.file_bytes, "delta_file_bytes");
ok(migrate.delta_used_bytes === after.used_bytes - before.used_bytes, "delta_used_bytes");
ok(migrate.delta_file_bytes < 0, "VACUUM reclaim is a negative file delta");

const already = buildSqliteMigrateResponse(
  "o",
  "r",
  snapshotFromPragmas({ page_count: 10, page_size: 4096, freelist_count: 0, commp_schema: "2" }),
  snapshotFromPragmas({ page_count: 10, page_size: 4096, freelist_count: 0, commp_schema: "2" })
);
ok(already.migrated === false, "already-v2 is not migrated");
ok(already.delta_file_bytes === 0 && already.delta_used_bytes === 0, "no-op deltas are zero");

const stats = buildSqliteStatsResponse("andy", "demo", snap);
ok(stats.org === "andy" && stats.repo === "demo", "stats org/repo");
ok(stats.page_count === 100 && stats.page_size === 4096, "stats includes pragmas");
ok(stats.used_bytes === snap.used_bytes && stats.file_bytes === snap.file_bytes, "stats includes computed bytes");
ok(stats.commp_schema === "1", "stats includes schema");

ok(VACUUM_SQL === "VACUUM", "VACUUM SQL is the SQLite statement");
ok(vacuumFailedError("not authorized") === "VACUUM failed: not authorized", "VACUUM error is explicit");

class MemPragmaSql implements RepoSql {
  schema: string | null = "1";
  throwMeta = false;
  throwVacuum: string | null = null;
  vacuums = 0;
  pragmas: Record<string, number> = { page_count: 50, page_size: 4096, freelist_count: 5 };

  async sqlAll<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.startsWith("PRAGMA ")) {
      const name = sql.slice("PRAGMA ".length).trim();
      return [{ [name]: this.pragmas[name] ?? 0 }] as T[];
    }
    if (sql.includes("FROM meta WHERE key")) {
      if (this.throwMeta) throw new Error("no such table: meta");
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

  async sqlRun(sql: string, _params: unknown[] = []): Promise<void> {
    if (sql === VACUUM_SQL) {
      if (this.throwVacuum) throw new Error(this.throwVacuum);
      this.vacuums += 1;
    }
  }
}

const mem = new MemPragmaSql();
const size = await readSqliteSize(mem);
ok(size.page_count === 50 && size.freelist_count === 5, "readSqliteSize reads pragmas");
ok(size.used_bytes === 45 * 4096 && size.file_bytes === 50 * 4096, "readSqliteSize computes bytes");
ok(size.commp_schema === "1", "readSqliteSize reads commp_schema");

mem.schema = null;
ok((await readCommpSchemaVersion(mem)) === null, "missing commp_schema row is null");
mem.throwMeta = true;
ok((await readCommpSchemaVersion(mem)) === null, "missing meta table is null");

await runVacuum(mem);
ok(mem.vacuums === 1, "runVacuum issues VACUUM");

mem.throwVacuum = "cannot VACUUM from a function";
let vacuumThrew = false;
try {
  await runVacuum(mem);
} catch (e) {
  vacuumThrew = (e as Error).message === "VACUUM failed: cannot VACUUM from a function";
}
ok(vacuumThrew, "VACUUM rejection is not reported as success");

console.log("sqlite stats ok");
