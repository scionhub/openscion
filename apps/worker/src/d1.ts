import { d1All, d1Run, uuid } from "./db";

export class D1Gateway {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = request.headers.get("x-internal-secret") || "";
    if (!this.env.INTERNAL_SECRET || secret !== (this.env.INTERNAL_SECRET as string)) {
      return new Response("forbidden", { status: 403 });
    }
    const m = url.pathname.match(
      /^\/__internal\/d1\/([^/]+)\/(providers|datasets|upload|pieces|locate|staging|auth)(?:\/(.+))?$/
    );
    if (!m) return new Response("bad route", { status: 400 });
    const org = decodeURIComponent(m[1]!);
    const area = m[2]!;
    const arg = m[3] ? decodeURIComponent(m[3]!) : undefined;
    const db = dbTop(this.env);
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
          offset?: number;
          length?: number;
        };
        await d1Run(
          db,
          `INSERT OR IGNORE INTO datasets (id,name,description,created_at) VALUES (?,?,NULL,strftime('%s','now')*1000)`,
          [b.datasetId, b.datasetId]
        );
        await d1Run(
          db,
          `INSERT OR IGNORE INTO pieces (piece_cid,dataset_id,size_bytes,provider_id,status,created_at) VALUES (?,?,?,?,?,strftime('%s','now')*1000)`,
          [b.pieceCid, b.datasetId, b.sizeBytes ?? null, b.providerId ?? null, b.state ?? "registered"]
        );
        if (b.objectId && (b.length ?? b.sizeBytes) !== undefined) {
          const offset = b.offset ?? 0;
          const length = b.length ?? (b.sizeBytes as number);
          await d1Run(
            db,
            `INSERT OR REPLACE INTO object_locations (object_id,piece_cid,"offset",length,provider_id,created_at) VALUES (?,?,?,?,?,strftime('%s','now')*1000)`,
            [b.objectId, b.pieceCid, offset, length, b.providerId ?? null]
          );
        }
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
      } else if (area === "locate") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        const body = (await request.json()) as { ids: string[] };
        const placeholders = body.ids.map(() => "?").join(",");
        const q =
          `SELECT ol.object_id as objectId, ol.piece_cid as pieceCid, ol."offset" as "offset", ol.length as length, ` +
          `p.provider_id as providerId, pr.endpoint_url as providerUrl, p.size_bytes as pieceSize ` +
          `FROM object_locations ol ` +
          `JOIN pieces p ON p.piece_cid = ol.piece_cid ` +
          `LEFT JOIN providers pr ON pr.id = COALESCE(ol.provider_id, p.provider_id) ` +
          `WHERE ol.object_id IN (${placeholders})`;
        const rows = body.ids.length > 0 ? await d1All(db, q, body.ids) : [];
        return json({ locations: rows });
      } else if (area === "staging") {
        // Subroutes: /staging/object (POST), /staging/object/{id} (GET), /staging/pending (GET), /staging/delete (POST)
        const sub = url.pathname.replace(/^\/__internal\/d1\/[^/]+\/staging\/?/, "");
        if (request.method === "POST" && sub === "object") {
          const b = (await request.json()) as {
            objectId: string;
            chunkIndex: number;
            totalLength: number;
            bytesBase64: string;
          };
          await d1Run(
            db,
            `INSERT OR IGNORE INTO staging_meta (object_id,total_length,created_at) VALUES (?,?,strftime('%s','now')*1000)`,
            [b.objectId, b.totalLength]
          );
          const bytes = Uint8Array.from(atob(b.bytesBase64), (c) => c.charCodeAt(0));
          await d1Run(
            db,
            `INSERT OR REPLACE INTO staging_objects (object_id,chunk_index,bytes,created_at) VALUES (?,?,?,strftime('%s','now')*1000)`,
            [b.objectId, b.chunkIndex, bytes]
          );
          return json({ ok: true });
        }
        if (request.method === "GET" && sub === "pending") {
          // return objects staged but not sealed (no mapping in object_locations)
          const rows = await d1All(
            db,
            `SELECT m.object_id as objectId, m.total_length as totalLength, m.created_at as createdAt
             FROM staging_meta m
             LEFT JOIN object_locations ol ON ol.object_id = m.object_id
             WHERE ol.object_id IS NULL
             ORDER BY m.created_at ASC`
          );
          return json({ pending: rows });
        }
        const objMatch = sub.match(/^object\/([^/]+)$/);
        if (request.method === "GET" && objMatch) {
          const id = decodeURIComponent(objMatch[1]!);
          const chunks = await d1All<{ bytes: ArrayBuffer }>(
            db,
            `SELECT bytes FROM staging_objects WHERE object_id = ? ORDER BY chunk_index ASC`,
            [id]
          );
          const total = chunks.reduce((acc, c) => acc + c.bytes.byteLength, 0);
          const out = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            out.set(new Uint8Array(c.bytes), offset);
            offset += c.bytes.byteLength;
          }
          return new Response(out, { headers: { "content-type": "application/octet-stream" } });
        }
        if (request.method === "POST" && sub === "delete") {
          const b = (await request.json()) as { objectIds: string[] };
          for (const id of b.objectIds) {
            await d1Run(db, `DELETE FROM staging_meta WHERE object_id = ?`, [id]);
          }
          return json({ ok: true, deleted: b.objectIds.length });
        }
        return new Response("bad staging route", { status: 400 });
      } else if (area === "auth") {
        const sub = url.pathname.replace(/^\/__internal\/d1\/[^/]+\/auth\/?/, "");
        const db = dbTop(this.env);
        if (request.method === "GET" && sub === "user") {
          const name = url.searchParams.get("name");
          if (!name) return json({ error: "name required" }, { status: 400 });
          const rows = await d1All<{ id: string; name: string; password_hash: string; admin: number }>(
            db,
            `SELECT id,name,password_hash,admin FROM users WHERE name = ? LIMIT 1`,
            [name]
          );
          if (rows.length === 0) return new Response("not found", { status: 404 });
          return json(rows[0]);
        }
        if (request.method === "POST" && sub === "user") {
          // Admin-only create user: { id?, name, password_hash, admin? }
          const body = (await request.json()) as { id?: string; name: string; password_hash: string; admin?: boolean };
          if (!body.name || !body.password_hash) return json({ error: "name and password_hash required" }, { status: 400 });
          const id = body.id ?? uuid();
          await d1Run(
            db,
            `INSERT INTO users (id,name,password_hash,admin,created_at) VALUES (?,?,?,?,strftime('%s','now')*1000)`,
            [id, body.name, body.password_hash, body.admin ? 1 : 0]
          );
          return json({ ok: true, id });
        }
        if (request.method === "POST" && sub === "token") {
          // Store a hashed token: { user_id, token_hash }
          const body = (await request.json()) as { user_id: string; token_hash: string };
          if (!body.user_id || !body.token_hash) return json({ error: "user_id and token_hash required" }, { status: 400 });
          const id = uuid();
          await d1Run(
            db,
            `INSERT INTO tokens (id,user_id,token_hash,created_at,revoked) VALUES (?,?,?,?,0)`,
            [id, body.user_id, body.token_hash, Date.now()]
          );
          return json({ ok: true, id });
        }
        if (request.method === "POST" && sub === "validate") {
          // Validate a hashed token: { token_hash }
          const body = (await request.json()) as { token_hash: string };
          if (!body.token_hash) return json({ error: "token_hash required" }, { status: 400 });
          const rows = await d1All<{ user_id: string; name: string; admin: number }>(
            db,
            `SELECT u.id as user_id, u.name, u.admin FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked = 0 LIMIT 1`,
            [body.token_hash]
          );
          if (rows.length === 0) return new Response("forbidden", { status: 403 });
          return json({ ok: true, user: rows[0] });
        }
        return new Response("bad auth route", { status: 400 });
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

function dbTop(env: Env): D1Database {
  const db = (env as any)["DB_SCIONHUB_TOP"] as D1Database | undefined;
  if (!db) throw new Error(`no D1 binding DB_SCIONHUB_TOP`);
  return db;
}

export interface Env {
  INTERNAL_SECRET?: string;
  [key: string]: unknown;
}
