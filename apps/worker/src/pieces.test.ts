//! COMMP intern, tip-map apply, and `pcid:` snapshot fold.

import {
  COMMP_DDL,
  COMMP_SCHEMA_VERSION,
  applyFileMap,
  foldPcidSnapshots,
  internPiece,
  listFileMap,
  lookupFilePiece,
  normalizeCommp,
  pcidEntriesFromChangesetBody,
  type RepoSql,
} from "./pieces";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

ok(normalizeCommp("  bafkabc  ") === "bafkabc", "trim commp");
let threw = false;
try {
  normalizeCommp("   ");
} catch {
  threw = true;
}
ok(threw, "empty commp is rejected");

ok(
  COMMP_DDL.some((s) => s.includes("CREATE TABLE IF NOT EXISTS pieces")),
  "ddl creates pieces"
);
ok(
  COMMP_DDL.some((s) => s.includes("file_pieces")),
  "ddl creates file_pieces"
);
ok(COMMP_SCHEMA_VERSION === "2", "schema version is 2");

const parsed = pcidEntriesFromChangesetBody(
  JSON.stringify({
    metadata: { "pcid:README.md": "bafk1", "review": "skip", "pcid:src/lib.rs": "bafk2" },
  })
);
ok(parsed.length === 2, "pcid entries skip non-pcid keys");
ok(parsed.some((e) => e.path === "README.md" && e.pieceCid === "bafk1"), "readme entry");

const folded = foldPcidSnapshots([
  { lsn: 1, body: JSON.stringify({ metadata: { "pcid:a.txt": "old", "pcid:keep.txt": "k" } }) },
  { lsn: 2, body: JSON.stringify({ metadata: { "pcid:a.txt": "new", "pcid:keep.txt": "k" } }) },
  { lsn: 3, body: JSON.stringify({ metadata: {} }) },
]);
ok(folded.get("a.txt") === "new", "newest snapshot wins");
ok(folded.get("keep.txt") === "k", "unchanged path kept from last snapshot");
ok(!folded.has("gone"), "missing path stays missing");

/** Tiny in-memory stand-in for RepoDO sql helpers. */
class MemSql implements RepoSql {
  pieces = new Map<string, number>();
  filePieces = new Map<string, number>();
  next = 1;

  async sqlAll<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.includes("FROM file_pieces") && sql.includes("JOIN pieces") && sql.includes("ORDER BY")) {
      const out: T[] = [];
      for (const [path, id] of [...this.filePieces.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const commp = [...this.pieces.entries()].find(([, n]) => n === id)?.[0];
        if (commp) out.push({ path, commp } as T);
      }
      return out;
    }
    if (sql.includes("FROM file_pieces") && sql.includes("WHERE f.path")) {
      const path = String(params[0]);
      const id = this.filePieces.get(path);
      if (id == null) return [];
      const commp = [...this.pieces.entries()].find(([, n]) => n === id)?.[0];
      return commp ? ([{ commp }] as T[]) : [];
    }
    if (sql.includes("FROM pieces WHERE commp")) {
      const id = this.pieces.get(String(params[0]));
      return id != null ? ([{ id }] as T[]) : [];
    }
    return [];
  }

  async sqlOne<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.sqlAll<T>(sql, params);
    return rows[0] ?? null;
  }

  async sqlRun(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.startsWith("INSERT OR IGNORE INTO pieces")) {
      const cid = String(params[0]);
      if (!this.pieces.has(cid)) this.pieces.set(cid, this.next++);
      return;
    }
    if (sql.startsWith("INSERT OR REPLACE INTO file_pieces")) {
      this.filePieces.set(String(params[0]), Number(params[1]));
      return;
    }
    if (sql.startsWith("DELETE FROM file_pieces")) {
      this.filePieces.delete(String(params[0]));
    }
  }
}

const db = new MemSql();
const a = await internPiece(db, "bafk-a");
const a2 = await internPiece(db, "bafk-a");
const b = await internPiece(db, "bafk-b");
ok(a === a2, "intern is idempotent");
ok(a !== b, "distinct COMMPs get distinct ids");

await applyFileMap(
  db,
  [
    { path: "/README.md", pieceCid: "bafk-a" },
    { path: "src/lib.rs", pieceCid: "bafk-b" },
  ],
  []
);
ok((await lookupFilePiece(db, "README.md")) === "bafk-a", "file-map lookup strips slash");
ok((await lookupFilePiece(db, "src/lib.rs")) === "bafk-b", "second path");
await applyFileMap(db, [], ["src/lib.rs"]);
ok((await lookupFilePiece(db, "src/lib.rs")) === null, "delete drops path");
const listed = await listFileMap(db);
ok(listed.length === 1 && listed[0]!.path === "README.md", "list is remaining tip paths");

console.log("pieces commp ok");
