import { d1All, d1Run } from "./db";

export class D1Gateway {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = request.headers.get("x-internal-secret") || url.searchParams.get("s") || "";
    if (!this.env.INTERNAL_SECRET || secret !== (this.env.INTERNAL_SECRET as string)) {
      return new Response("forbidden", { status: 403 });
    }
    const m = url.pathname.match(/^\/__internal\/d1\/([^/]+)\/(providers|datasets|upload|pieces)(?:\/([^/]+))?$/);
    if (!m) return new Response("bad route", { status: 400 });
    const org = decodeURIComponent(m[1]!);
    const area = m[2]!;
    const arg = m[3] ? decodeURIComponent(m[3]!) : undefined;
    const db = dbForOrg(this.env, org);
    try {
      if (area === "providers") {
        if (request.method === "GET") {
          const rows = await d1All(db, "SELECT id,name,endpoint_url,region,status,created_at FROM providers ORDER BY created_at DESC");
          return json({ providers: rows });
        }
        if (request.method === "POST") {
          const b = (await request.json()) as {
            id: string;
            name: string;
            endpointUrl?: string;
            region?: string;
            status?: string;
          };
          await d1Run(
            db,
            `INSERT OR REPLACE INTO providers (id,name,endpoint_url,region,status,created_at) VALUES (?,?,?,?,COALESCE(?, 'active'),strftime('%s','now')*1000)`,
            [b.id, b.name, b.endpointUrl ?? null, b.region ?? null, b.status]
          );
          return json({ ok: true, id: b.id });
        }
      } else if (area === "datasets") {
        if (request.method === "GET") {
          const rows = await d1All(db, "SELECT id,name,description,created_at FROM datasets ORDER BY created_at DESC");
          return json({ datasets: rows });
        }
        if (request.method === "POST") {
          const b = (await request.json()) as { id: string; name: string; description?: string };
          await d1Run(db, `INSERT OR REPLACE INTO datasets (id,name,description,created_at) VALUES (?,?,?,strftime('%s','now')*1000)`, [
            b.id,
            b.name,
            b.description ?? null
          ]);
          return json({ ok: true, id: b.id });
        }
      } else if (area === "upload") {
        const b = (await request.json()) as {
          pieceCid: string;
          datasetId: string;
          sizeBytes?: number;
          providerId?: string;
          state?: string;
          error?: string;
          uploadId: string;
          source?: string;
          objectId?: string;
        };
        await d1Run(
          db,
          `INSERT OR IGNORE INTO pieces (piece_cid,dataset_id,size_bytes,provider_id,status,created_at,object_id) VALUES (?,?,?,?,?,strftime('%s','now')*1000,?)`,
          [b.pieceCid, b.datasetId, b.sizeBytes ?? null, b.providerId ?? null, b.state ?? "registered", b.objectId ?? null]
        );
        await d1Run(
          db,
          `INSERT INTO uploads (id,piece_cid,source,state,error,created_at) VALUES (?,?,?,?,?,strftime('%s','now')*1000)`,
          [b.uploadId, b.pieceCid, b.source ?? "api", b.state ?? "queued", b.error ?? null]
        );
        return json({ ok: true, pieceCid: b.pieceCid });
      } else if (area === "pieces" && arg) {
        const rows = await d1All(
          db,
          `SELECT piece_cid,dataset_id,size_bytes,provider_id,status,created_at FROM pieces WHERE piece_cid = ?`,
          [arg]
        );
        if (rows.length === 0) return new Response("not found", { status: 404 });
        return json(rows[0]);
      }
      return new Response("method not allowed", { status: 405 });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 500 });
    }
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

function dbForOrg(env: Env, org: string): D1Database {
  const key = `DB_${org.replace(/-/g, "_").toUpperCase()}` as keyof Env;
  const db = (env as any)[key] as D1Database | undefined;
  if (!db) throw new Error(`no D1 binding for org ${org}`);
  return db;
}

export interface Env {
  INTERNAL_SECRET?: string;
  [key: string]: unknown;
}
