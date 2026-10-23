export type Row = Record<string, unknown>;

/** Bindings for the two static D1 databases. `ORGS_DB` is optional so a
 *  deploy before `scionbase-orgs` exists keeps using the top DB. */
export type D1Env = {
  DB_SCIONHUB_TOP?: D1Database;
  ORGS_DB?: D1Database;
};

/** Identity and org-list tables that stay on `scionhub-top`. */
export const TOP_TABLES = [
  "users",
  "tokens",
  "orgs",
  "org_members",
  "memberships",
  "signup_attempts",
] as const;

/** Repo / PR / dataset tables that live on `scionbase-orgs`. */
export const ORGS_TABLES = [
  "repos",
  "pulls",
  "datasets",
  "providers",
  "pieces",
  "uploads",
] as const;

/** Top D1 (`scionhub-top`): users, tokens, orgs, memberships, signup. */
export function dbTop(env: D1Env): D1Database {
  const db = env.DB_SCIONHUB_TOP;
  if (!db) throw new Error("no D1 binding DB_SCIONHUB_TOP");
  return db;
}

/** Shared org D1 (`scionbase-orgs`). Falls back to top when unbound. */
export function dbOrgs(env: D1Env): D1Database {
  return env.ORGS_DB ?? dbTop(env);
}

/** `repos.id` is `org/name`; used when the `org` column is still empty. */
export function orgFromRepoId(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : id;
}

/** Attach `author_name` from a separately loaded users list (no cross-DB join). */
export function mergeAuthorNames<T extends { author_user_id: string }>(
  rows: T[],
  users: { id: string; name: string }[]
): (T & { author_name?: string })[] {
  const byId = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => {
    const name = byId.get(r.author_user_id);
    return name === undefined ? { ...r } : { ...r, author_name: name };
  });
}

export async function loadUsersById(
  db: D1Database,
  ids: string[]
): Promise<{ id: string; name: string }[]> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => "?").join(",");
  return d1All<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM users WHERE id IN (${placeholders})`,
    unique
  );
}

export async function d1All<T extends Row>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const bound =
    params.length > 0
      ? stmt.bind(...params.map((p) => (p === undefined ? null : p)))
      : stmt;
  const res = await bound.all<T>();
  if (!res.success) {
    throw new Error(res.error || "D1 query failed");
  }
  return (res.results as T[]) ?? [];
}

export async function d1Run(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<void> {
  const stmt = db.prepare(sql);
  const bound =
    params.length > 0
      ? stmt.bind(...params.map((p) => (p === undefined ? null : p)))
      : stmt;
  const res = await bound.run();
  if (!res.success) {
    throw new Error(res.error || "D1 exec failed");
  }
}

export function nowMs(): number {
  return Date.now();
}

export function uuid(): string {
  // RFC4122-ish v4 in a worker-safe way (not cryptographically unique, but fine for POC ids)
  // Use Web Crypto if present for better randomness.
  const hasCrypto =
    typeof globalThis !== "undefined" &&
    typeof (globalThis as any).crypto !== "undefined" &&
    typeof (globalThis as any).crypto.getRandomValues === "function";
  const rnd = hasCrypto
    ? (globalThis as any).crypto.getRandomValues(new Uint8Array(16))
    : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  rnd[6] = (rnd[6] & 0x0f) | 0x40; // version 4
  rnd[8] = (rnd[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(rnd, (b: number) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
