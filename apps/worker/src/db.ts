export type Row = Record<string, unknown>;

export type D1Env = {
  DB_SCIONHUB_TOP?: D1Database;
  ORGS_DB?: D1Database;
};

export function dbTop(env: D1Env): D1Database {
  const db = env.DB_SCIONHUB_TOP;
  if (!db) throw new Error("no D1 binding DB_SCIONHUB_TOP");
  return db;
}

export function dbOrgs(env: D1Env): D1Database {
  return env.ORGS_DB ?? dbTop(env);
}

export async function d1All<T extends Row>(db: D1Database, sql: string, params: unknown[] = []): Promise<T[]> {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params.map((p) => (p === undefined ? null : p))) : stmt;
  const res = await bound.all<T>();
  if (!res.success) {
    throw new Error(res.error || "D1 query failed");
  }
  return (res.results as T[]) ?? [];
}

export async function d1Run(db: D1Database, sql: string, params: unknown[] = []): Promise<void> {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params.map((p) => (p === undefined ? null : p))) : stmt;
  const res = await bound.run();
  if (!res.success) {
    throw new Error(res.error || "D1 exec failed");
  }
}

export function nowMs(): number {
  return Date.now();
}
