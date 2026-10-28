//! In-memory D1 and RepoDO SQLite, backed by `node:sqlite`.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type D1Meta = { changes: number };

export class MemoryD1 {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this.db, sql);
  }
}

class MemoryStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): MemoryStatement {
    return new MemoryStatement(this.db, this.sql, params);
  }

  async all<T>(): Promise<{ success: boolean; results?: T[]; error?: string }> {
    try {
      const stmt = this.db.prepare(this.sql);
      const rows = stmt.all(...(this.params as never[])) as T[];
      return { success: true, results: rows };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  async first<T>(): Promise<T | null> {
    const res = await this.all<T>();
    return res.results?.[0] ?? null;
  }

  async run(): Promise<{ success: boolean; error?: string; meta: D1Meta }> {
    try {
      const stmt = this.db.prepare(this.sql);
      const info = stmt.run(...(this.params as never[])) as { changes?: number };
      return { success: true, meta: { changes: Number(info.changes ?? 0) } };
    } catch (e) {
      return { success: false, error: (e as Error).message, meta: { changes: 0 } };
    }
  }
}

/** Cloudflare DO `storage.sql.exec(sql, ...params).toArray()`. */
export function sqlStorage(db: DatabaseSync): { exec: (sql: string, ...params: unknown[]) => { toArray: () => unknown[] } } {
  return {
    exec(sql: string, ...params: unknown[]) {
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...(params as never[]));
        return { toArray: () => rows as unknown[] };
      }
      if (params.length === 0) {
        db.exec(sql);
        return { toArray: () => [] };
      }
      db.prepare(sql).run(...(params as never[]));
      return { toArray: () => [] };
    },
  };
}

export function applySqlDir(d1: MemoryD1, dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    try {
      d1.exec(sql);
    } catch (e) {
      const msg = (e as Error).message;
      // Some ALTERs are idempotent in spirit; a fresh DB should not hit this.
      if (/duplicate column/i.test(msg)) continue;
      throw new Error(`${file}: ${msg}`);
    }
  }
}

export function seedProtectedRepos(orgs: MemoryD1, now: number): void {
  for (const name of ["curio", "lotus"]) {
    orgs.db
      .prepare(
        "INSERT OR IGNORE INTO repos (id, name, visibility, created_at, created_by, org) VALUES (?, ?, 'public', ?, NULL, 'filecoin-project')"
      )
      .run(`filecoin-project/${name}`, name, now);
  }
}
