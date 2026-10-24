export type Row = Record<string, unknown>;

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
