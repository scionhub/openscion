//! Standalone SQLite files for archived history.
//!
//! Node's built-in SQLite writes the chunk and opens it again for reads.
//! The Worker caches a few open files (LRU) and deletes the temp copy on
//! eviction. The bytes themselves live in piece storage, not in the live DO.

import type { RepoSql } from "./pieces";
import { HISTORY_DDL } from "./history_schema";

type Statement = {
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
};

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};

const ARCHIVE_CHANGES = `
CREATE TABLE IF NOT EXISTS changesets (
  id TEXT PRIMARY KEY,
  lsn INTEGER NOT NULL,
  root_tree TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  author TEXT,
  message TEXT,
  committed_at INTEGER,
  indexed INTEGER NOT NULL DEFAULT 1
)`;

async function openPath(path: string): Promise<SqliteDb> {
  const specifier = "node:sqlite";
  const mod = (await import(specifier)) as { DatabaseSync: new (path: string) => SqliteDb };
  return new mod.DatabaseSync(path);
}

function asSql(db: SqliteDb): RepoSql {
  return {
    async sqlAll<T extends Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> {
      const rows = db.prepare(statement).all(...params);
      return rows as T[];
    },
    async sqlOne<T extends Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T | null> {
      const row = db.prepare(statement).get(...params);
      return (row as T | undefined) ?? null;
    },
    async sqlRun(statement: string, params: unknown[] = []): Promise<void> {
      db.prepare(statement).run(...params);
    },
  };
}

export async function emptyArchiveSql(): Promise<{ sql: RepoSql; bytes(): Promise<Uint8Array>; close(): Promise<void> }> {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scn-arch-"));
  const file = path.join(dir, "history.sqlite");
  const db = await openPath(file);
  db.exec(ARCHIVE_CHANGES);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_changesets_lsn ON changesets(lsn)`);
  for (const statement of HISTORY_DDL) db.exec(statement);
  return {
    sql: asSql(db),
    async bytes() {
      db.close();
      return new Uint8Array(fs.readFileSync(file));
    },
    async close() {
      try {
        db.close();
      } catch {
        /* already closed by bytes() */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type OpenArchive = { sql: RepoSql; close(): void };

const OPEN_MAX = 4;
const openCache = new Map<string, { opened: OpenArchive; at: number; dir: string }>();

export async function openArchiveBytes(pieceCid: string, bytes: Uint8Array): Promise<OpenArchive> {
  const hit = openCache.get(pieceCid);
  if (hit) {
    hit.at = Date.now();
    return hit.opened;
  }
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scn-arch-open-"));
  const file = path.join(dir, "history.sqlite");
  fs.writeFileSync(file, bytes);
  const db = await openPath(file);
  const destroy = (): void => {
    const cached = openCache.get(pieceCid);
    if (cached) openCache.delete(pieceCid);
    try {
      db.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const opened: OpenArchive = {
    sql: asSql(db),
    close() {
      /* The LRU owns the file. Callers may finish a query and return. */
    },
  };
  (opened as OpenArchive & { destroy?: () => void }).destroy = destroy;
  openCache.set(pieceCid, { opened, at: Date.now(), dir });
  while (openCache.size > OPEN_MAX) {
    let oldest: string | null = null;
    let oldestAt = Infinity;
    for (const [cid, entry] of openCache) {
      if (cid === pieceCid) continue;
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldest = cid;
      }
    }
    if (!oldest) break;
    const victim = openCache.get(oldest);
    openCache.delete(oldest);
    (victim?.opened as OpenArchive & { destroy?: () => void }).destroy?.();
  }
  return opened;
}

/** Test hook: drop cached archive files. */
export function closeCachedArchives(): void {
  for (const entry of [...openCache.values()]) {
    (entry.opened as OpenArchive & { destroy?: () => void }).destroy?.();
  }
  openCache.clear();
}
