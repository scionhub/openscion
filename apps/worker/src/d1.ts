import { d1All, d1Run } from "./db";

export class D1Gateway {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = request.headers.get("x-internal-secret") || url.searchParams.get("s") || "";
    if (!this.env.INTERNAL_SECRET || secret !== (this.env.INTERNAL_SECRET as string)) {
      return new Response("forbidden", { status: 403 });
    }
    const m = url.pathname.match(
      /^\/__internal\/d1\/([^/]+)\/(providers|datasets|upload|pieces|locate|staging)(?:\/([^/]+))?$/
    );
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
          offset?: number;
          length?: number;
        };
        await d1Run(
          db,
          `INSERT OR IGNORE INTO pieces (piece_cid,dataset_id,size_bytes,provider_id,status,created_at,object_id) VALUES (?,?,?,?,?,strftime('%s','now')*1000,?)`,
          [b.pieceCid, b.datasetId, b.sizeBytes ?? null, b.providerId ?? null, b.state ?? "registered", b.objectId ?? null]
        );
        if (b.objectId && (b.length ?? b.sizeBytes) !== undefined) {
          const offset = b.offset ?? 0;
          const length = b.length ?? (b.sizeBytes as number);
          await d1Run(
            db,
            `INSERT OR REPLACE INTO object_locations (object_id,piece_cid,offset,length,provider_id,created_at) VALUES (?,?,?,?,?,strftime('%s','now')*1000)`,
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
          `SELECT ol.object_id as objectId, ol.piece_cid as pieceCid, ol.offset as offset, ol.length as length, ` +
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
