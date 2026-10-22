// Durable Object for per-repo metadata (refs, changesets, bundle map) stored in DO SQLite.
// Keyed by idFromName("<org>/<repo>") at the Worker front. Guarded by INTERNAL_SECRET.

type Row = Record<string, unknown>;
type Env = { INTERNAL_SECRET?: string; ENGINE?: DurableObjectNamespace; ADMIN_TOKEN?: string };

export class RepoDO {
  constructor(readonly state: DurableObjectState, readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = request.headers.get("x-internal-secret") || "";
    if (!this.env.INTERNAL_SECRET || secret !== (this.env.INTERNAL_SECRET as string)) {
      return new Response("forbidden", { status: 403 });
    }
    await this.ensureSchema();
    const m = url.pathname.match(/^\/__internal\/do\/([^/]+)\/([^/]+)\/(refs|changesets|bundle-map|bundles|pending-adds|reset|kick)(?:\/([^/]+))?$/);
    if (!m) return new Response("bad route", { status: 400 });
    const area = m[3]!;
    const arg = m[4] ? decodeURIComponent(m[4]!) : undefined;
    // Persist org/repo meta for alarm use
    const org = decodeURIComponent(m[1]!);
    const repo = decodeURIComponent(m[2]!);
    await this.sqlRun(`INSERT OR REPLACE INTO meta (key, value) VALUES ('org', ?), ('repo', ?)`, [org, repo]);
    try {
      if (area === "reset" && request.method === "POST") {
        for (const t of ["refs", "changesets", "bundle_members", "bundles", "pending_adds"]) {
          try { this.sqlRun(`DELETE FROM ${t}`); } catch {}
        }
        return json({ ok: true });
      }
      if (area === "kick" && request.method === "POST") {
        await this.sqlRun(`UPDATE pending_adds SET next_at = 0`);
        await this.state.storage.setAlarm(Date.now() + 100);
        return json({ ok: true });
      }
      if (area === "refs") {
        if (request.method === "DELETE" && arg) {
          await this.sqlRun(`DELETE FROM refs WHERE name = ?`, [arg]);
          return json({ ok: true, deleted: arg });
        }
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
        if (request.method === "GET" && !arg) {
          const rows = await this.sqlAll<{ id: string; lsn: number; root_tree: string; body: string }>(
            `SELECT id,lsn,root_tree,body FROM changesets ORDER BY lsn ASC`
          );
          const changesets = rows.map((r) => ({
            id: r.id,
            lsn: r.lsn,
            root_tree: r.root_tree,
            changeset: JSON.parse(String(r.body)),
          }));
          return json({ changesets });
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
      } else if (area === "bundle-map") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        type Member = { pieceCid: string; offset: number; length: number };
        const b = (await request.json()) as { bundleCid: string; members: Member[] };
        if (!b.bundleCid || !Array.isArray(b.members)) return json({ error: "bundleCid and members required" }, { status: 400 });
        await this.sqlRun(`INSERT OR IGNORE INTO bundles (piece_cid, created_at) VALUES (?, strftime('%s','now')*1000)`, [b.bundleCid]);
        for (const m of b.members) {
          await this.sqlRun(
            `INSERT OR REPLACE INTO bundle_members (bundle_piece_cid, piece_cid, "offset", length, created_at)
             VALUES (?, ?, ?, ?, strftime('%s','now')*1000)`,
            [b.bundleCid, m.pieceCid, m.offset, m.length]
          );
        }
        return json({ ok: true, bundleCid: b.bundleCid, members: b.members.length });
      } else if (area === "bundles") {
        if (request.method === "GET" && arg === "find") {
          const subCid = url.searchParams.get("pieceCid");
          if (!subCid) return json({ error: "pieceCid required" }, { status: 400 });
          const rows = await this.sqlAll<{ bundle_piece_cid: string; offset: number; length: number }>(
            `SELECT bundle_piece_cid, "offset", length FROM bundle_members WHERE piece_cid = ? LIMIT 1`,
            [subCid]
          );
          if (rows.length === 0) return new Response("not found", { status: 404 });
          const r = rows[0]!;
          return json({ bundleCid: r.bundle_piece_cid, offset: r.offset, length: r.length });
        }
        if (request.method === "POST" && arg === "resolve") {
          const body = (await request.json()) as { pieceCids: string[] };
          const ids = body.pieceCids ?? [];
          if (ids.length === 0) return json({ results: [] });
          // DO SQLite caps bound parameters at 100 per statement: chunk.
          const rows: { piece_cid: string; bundle_piece_cid: string; offset: number; length: number }[] = [];
          for (let i = 0; i < ids.length; i += 90) {
            const chunk = ids.slice(i, i + 90);
            const placeholders = chunk.map(() => "?").join(",");
            rows.push(...(await this.sqlAll<{ piece_cid: string; bundle_piece_cid: string; offset: number; length: number }>(
              `SELECT piece_cid, bundle_piece_cid, "offset", length FROM bundle_members WHERE piece_cid IN (${placeholders})`,
              chunk
            )));
          }
          return json({
            results: rows.map((r) => ({
              pieceCid: r.piece_cid,
              bundleCid: r.bundle_piece_cid,
              offset: r.offset,
              length: r.length
            }))
          });
        }
      } else if (area === "pending-adds") {
        if (request.method === "POST" && !arg) {
          // Body: { bundleCid: string; subPieceCids: string[] }
          const b = (await request.json()) as { bundleCid: string; subPieceCids: string[] };
          if (!b.bundleCid || !Array.isArray(b.subPieceCids)) {
            return json({ error: "bundleCid and subPieceCids required" }, { status: 400 });
          }
          await this.sqlRun(
            `INSERT OR REPLACE INTO pending_adds (bundle_piece_cid, sub_pieces, created_at, attempts, next_at) VALUES (
              ?,
              ?,
              strftime('%s','now')*1000,
              COALESCE((SELECT attempts FROM pending_adds WHERE bundle_piece_cid = ?), 0),
              strftime('%s','now')*1000 + 1000
            )`,
            [b.bundleCid, JSON.stringify(b.subPieceCids), b.bundleCid]
          );
          await this.state.storage.setAlarm(Date.now() + 1000);
          return json({ ok: true });
        }
        if (request.method === "GET" && !arg) {
          const rows = await this.sqlAll<{ bundle_piece_cid: string; sub_pieces: string; created_at: number }>(
            `SELECT bundle_piece_cid, sub_pieces, created_at FROM pending_adds ORDER BY created_at ASC`
          );
          return json({
            pending: rows.map((r) => ({
              bundleCid: r.bundle_piece_cid,
              subPieceCids: JSON.parse(String(r.sub_pieces))
            }))
          });
        }
        if (request.method === "GET" && arg === "status") {
          const row = await this.sqlOne<{ last_error: string | null }>(`SELECT last_error FROM pending_status LIMIT 1`);
          return json({ lastError: row?.last_error ?? null });
        }
        if (request.method === "POST" && arg === "success") {
          const b = (await request.json()) as { bundleCid: string };
          if (!b.bundleCid) return json({ error: "bundleCid required" }, { status: 400 });
          await this.sqlRun(`DELETE FROM pending_adds WHERE bundle_piece_cid = ?`, [b.bundleCid]);
          await this.sqlRun(`UPDATE pending_status SET last_error = NULL, updated_at = strftime('%s','now')*1000`);
          return json({ ok: true });
        }
      }
      return new Response("method not allowed", { status: 405 });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 500 });
    }
  }

  async ensureSchema(): Promise<void> {
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
    // Bundle mapping: aggregate piece -> member sub-pieces and their ranges
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS bundles (
        piece_cid TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`
    );
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS bundle_members (
        bundle_piece_cid TEXT NOT NULL,
        piece_cid TEXT NOT NULL,
        "offset" INTEGER NOT NULL,
        length INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(bundle_piece_cid, piece_cid),
        FOREIGN KEY(bundle_piece_cid) REFERENCES bundles(piece_cid) ON DELETE CASCADE
      )`
    );
    await db.exec?.(`CREATE INDEX IF NOT EXISTS idx_bundle_member_piece ON bundle_members(piece_cid)`);
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS pending_adds (
        bundle_piece_cid TEXT PRIMARY KEY,
        sub_pieces TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
      )`
    );
    await db.exec?.(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await db.exec?.(
      `CREATE TABLE IF NOT EXISTS pending_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_error TEXT,
        updated_at INTEGER NOT NULL
      )`
    );
    await db.exec?.(
      `INSERT OR IGNORE INTO pending_status (id, last_error, updated_at) VALUES (1, NULL, strftime('%s','now')*1000)`
    );
  }

  async sqlAll<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = (this.state.storage as any).sql;
    return db.exec(sql, ...params).toArray() as T[];
  }

  async sqlOne<T extends Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.sqlAll<T>(sql, params);
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  async sqlRun(sql: string, params: unknown[] = []): Promise<void> {
    const db = (this.state.storage as any).sql;
    db.exec(sql, ...params);
  }
}

// Alarm: process pending_adds in batches, calling container admin add-pieces
// and backing off on failure. Best-effort; durable state ensures retries.
(RepoDO as any).prototype.alarm = async function alarm(this: RepoDO) {
  try {
    await this.ensureSchema();
    const orgRow = await this.sqlOne<{ value: string }>(`SELECT value FROM meta WHERE key = 'org'`);
    const org = orgRow?.value;
    if (!org) return;
    const now = Date.now();
    const due = await this.sqlAll<{ bundle_piece_cid: string }>(
      `SELECT bundle_piece_cid FROM pending_adds WHERE next_at <= ? ORDER BY created_at ASC LIMIT 64`,
      [now]
    );
    if (due.length === 0) return;
    const pieces = due.map((r) => r.bundle_piece_cid);
    if (!(this.env.ENGINE as any)) return;
    // One engine container (max_instances 1) serves every org; the dataset is per org
    // (clientDataSetId = sha256(org)), created lazily on the first add.
    const platformOrg = "filecoin-project";
    const id = (this.env.ENGINE as any).idFromName(platformOrg);
    const stub = (this.env.ENGINE as any).get(id);
    const headers = new Headers({ "content-type": "application/json" });
    if (this.env.ADMIN_TOKEN) headers.set("x-admin-token", this.env.ADMIN_TOKEN);
    const resp = await stub.fetch(
      new Request(`http://engine/orgs/${platformOrg}/v1/admin/add-pieces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ org, pieces })
      })
    );
    if (resp.ok) {
      for (const r of due) {
        await this.sqlRun(`DELETE FROM pending_adds WHERE bundle_piece_cid = ?`, [r.bundle_piece_cid]);
      }
      await this.sqlRun(`UPDATE pending_status SET last_error = NULL, updated_at = ?`, [Date.now()]);
      const more = await this.sqlOne<{ c: number }>(`SELECT COUNT(1) as c FROM pending_adds`);
      if ((more?.c ?? 0) > 0) {
        await this.state.storage.setAlarm(Date.now() + 2000);
      }
      return;
    }
    const text = await resp.text();
    const err = text.slice(0, 300);
    await this.sqlRun(`UPDATE pending_status SET last_error = ?, updated_at = ?`, [err, Date.now()]);
    for (const r of due) {
      // backoff = min(1h, 30s * 2^attempts_next)
      const row = await this.sqlOne<{ attempts: number }>(
        `SELECT attempts FROM pending_adds WHERE bundle_piece_cid = ?`,
        [r.bundle_piece_cid]
      );
      const attemptsNext = (row?.attempts ?? 0) + 1;
      const delay = Math.min(3600_000, 30_000 * Math.pow(2, attemptsNext));
      await this.sqlRun(
        `UPDATE pending_adds SET attempts = ?, next_at = ? WHERE bundle_piece_cid = ?`,
        [attemptsNext, Date.now() + delay, r.bundle_piece_cid]
      );
    }
    await this.state.storage.setAlarm(Date.now() + 30_000);
  } catch (e) {
    await this.sqlRun(`UPDATE pending_status SET last_error = ?, updated_at = ?`, [
      (e as Error).message?.slice(0, 300) ?? "alarm error",
      Date.now()
    ]);
    await this.state.storage.setAlarm(Date.now() + 60_000);
  }
};

function json(body: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

