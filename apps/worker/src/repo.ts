// Durable Object for per-repo metadata (refs, changesets) stored in DO SQLite.
// Keyed by idFromName("<org>/<repo>") at the Worker front. Guarded by INTERNAL_SECRET.

type Row = Record<string, unknown>;

export class RepoDO {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = request.headers.get("x-internal-secret") || "";
    if (!this.env.INTERNAL_SECRET || secret !== (this.env.INTERNAL_SECRET as string)) {
      return new Response("forbidden", { status: 403 });
    }
    await this.ensureSchema();
    const m = url.pathname.match(/^\/__internal\/do\/([^/]+)\/([^/]+)\/(refs|changesets)(?:\/([^/]+))?$/);
    if (!m) return new Response("bad route", { status: 400 });
    const area = m[3]!;
    const arg = m[4] ? decodeURIComponent(m[4]!) : undefined;
    try {
      if (area === "refs") {
        if (request.method === "GET" && arg) {
          const rows = await this.sqlAll<{ name: string; target: string; version: number }>(
            `SELECT name,target,version FROM refs WHERE name = ? LIMIT 1`,
            [arg]
          );
          if (rows.length === 0) return new Response("not found", { status: 404 });
          return json(rows[0]);
        }
        if (request.method === "GET") {
          const rows = await this.sqlAll<{ name: string; target: string; version: number }>(
            `SELECT name,target,version FROM refs ORDER BY name ASC`
          );
          return json({ refs: rows });
        }
        if (request.method === "POST") {
          const b = (await request.json()) as { name: string; target: string; version: number };
          await this.sqlRun(
            `INSERT OR REPLACE INTO refs (name,target,version,updated_at) VALUES (?,?,?,strftime('%s','now')*1000)`,
            [b.name, b.target, b.version]
          );
          return json({ ok: true });
        }
      } else if (area === "changesets") {
        if (request.method === "GET" && arg) {
          const rows = await this.sqlAll<{ id: string; lsn: number; root_tree: string; body: string }>(
            `SELECT id,lsn,root_tree,body FROM changesets WHERE id = ? LIMIT 1`,
            [arg]
          );
          if (rows.length === 0) return new Response("not found", { status: 404 });
          const row = rows[0]!;
          return json({ id: row.id, lsn: row.lsn, root_tree: row.root_tree, changeset: JSON.parse(String(row.body)) });
        }
        if (request.method === "POST") {
          const b = (await request.json()) as {
            id: string;
            lsn: number;
            root_tree: string;
            changeset: unknown;
          };
          await this.sqlRun(
            `INSERT OR IGNORE INTO changesets (id,lsn,root_tree,body,created_at) VALUES (?,?,?,?,strftime('%s','now')*1000)`,
            [b.id, b.lsn, b.root_tree, JSON.stringify(b.changeset)]
          );
          return json({ ok: true });
        }
      }
      return new Response("method not allowed", { status: 405 });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 500 });
    }
  }

  private async ensureSchema(): Promise<void> {
    const db = (this.state.storage as any).sql;
    // Refs table
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS refs (
        name TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );
    // Changesets table
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS changesets (
        id TEXT PRIMARY KEY,
        lsn INTEGER NOT NULL,
        root_tree TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    );
    await db.exec?.(`CREATE INDEX IF NOT EXISTS idx_changesets_lsn ON changesets(lsn)`);
  }

  private async sqlAll<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = (this.state.storage as any).sql;
    const stmt = db.prepare?.(sql);
    const bound = params.length > 0 ? stmt.bind?.(...params) : stmt;
    const res = await bound?.all();
    if (!res || res.error) throw new Error(res?.error || "RepoDO sql all failed");
    return (res.results as T[]) ?? [];
  }

  private async sqlRun(sql: string, params: unknown[] = []): Promise<void> {
    const db = (this.state.storage as any).sql;
    const stmt = db.prepare?.(sql);
    const bound = params.length > 0 ? stmt.bind?.(...params) : stmt;
    const res = await bound?.run();
    if (!res || res.error) throw new Error(res?.error || "RepoDO sql run failed");
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

