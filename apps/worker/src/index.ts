import { d1All, d1Run, nowMs, uuid } from "./db";
import { PDPClient } from "./pdp";
import { EngineContainer } from "./container";
import { D1Gateway } from "./d1";

export interface Env {
  DB_SCIONHUB_TOP: D1Database;
  ADMIN_TOKEN?: string;
  PDP_BASE_URL?: string;
  SYNAPSE_API_KEY?: string;
  SYNAPSE_PRIVATE_KEY?: string;
  SOURCE_TAG?: string;
  DEFAULT_PROVIDER_ID?: string;
  CONTAINER_URL?: string; // e.g., http://127.0.0.1:7878
}

type JsonValue = unknown;

function json(body: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

function notFound(msg = "not found"): Response {
  return json({ error: msg }, { status: 404 });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("invalid JSON");
  }
}

function requireAdmin(request: Request, env: Env): boolean {
  const want = env.ADMIN_TOKEN;
  if (!want) return false;
  const got = request.headers.get("authorization") || "";
  const m = got.match(/Bearer (.+)/i);
  if (!!m && m[1] === want) return true;
  const alt = request.headers.get("x-admin-token");
  if (alt && alt === want) return true;
  const q = new URL(request.url).searchParams.get("admin");
  if (q && q === want) return true;
  return false;
}

function pdpClient(env: Env): PDPClient {
  return new PDPClient({
    baseUrl: env.PDP_BASE_URL,
    apiKey: env.SYNAPSE_API_KEY,
    defaultProviderId: env.DEFAULT_PROVIDER_ID,
    privateKeyHex: env.SYNAPSE_PRIVATE_KEY,
    sourceTag: env.SOURCE_TAG
  });
}

function dbTop(env: Env): D1Database {
  const db = (env as any)["DB_SCIONHUB_TOP"] as D1Database | undefined;
  if (!db) throw new Error(`no D1 binding DB_SCIONHUB_TOP`);
  return db;
}

export default {
  // Durable Object classes export for wrangler binding
  EngineContainer,
  D1Gateway,
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      // Service root and health
      if (request.method === "GET" && (path === "/" || path === "/healthz")) {
        return json({
          name: "OpenScion Filecoin PDP POC",
          version: "0.1.0",
          orgs: ["filecoin-project"],
          pricing: {
            free_tier: "6 months or 1 GB, whichever comes first",
            paid: "$5/GB/month after",
            note:
              "POC only — no real billing; contact FilOz to discuss production"
          },
          links: {
            org: "/orgs/filecoin-project"
          }
        });
      }

      // Proxy to Rust engine (Cloudflare Container) for health check
      const engineHealth = path.match(/^\/orgs\/([^/]+)\/engine\/health$/);
      if (request.method === "GET" && engineHealth) {
        const base = env.CONTAINER_URL;
        if (!base) return json({ error: "container not configured" }, { status: 503 });
        const resp = await fetch(`${base}/healthz`);
        return new Response(await resp.text(), {
          status: resp.status,
          headers: { "content-type": "text/plain" }
        });
      }

      // Org landing
      const orgMatch = path.match(/^\/orgs\/([^/]+)$/);
      if (request.method === "GET" && orgMatch) {
        const org = decodeURIComponent(orgMatch[1]!);
        return json({
          org,
          databases: [`d1:binding DB_${org.replace(/-/g, "_").toUpperCase()}`],
          apis: {
            providers: `/orgs/${org}/providers`,
            datasets: `/orgs/${org}/datasets`,
            uploads: `/orgs/${org}/uploads`,
            pieces: `/orgs/${org}/pieces/{pieceCid}`
          }
        });
      }

      // Providers
      const provList = path.match(/^\/orgs\/([^/]+)\/providers$/);
      if (request.method === "GET" && provList) {
        const org = decodeURIComponent(provList[1]!);
        const db = dbTop(env);
        const rows = await d1All<{
          id: string;
          name: string;
          endpoint_url: string | null;
          region: string | null;
          status: string;
          created_at: number;
        }>(
          db,
          "SELECT id, name, endpoint_url, region, status, created_at FROM providers ORDER BY created_at DESC"
        );
        return json({ providers: rows });
      }
      if (request.method === "POST" && provList) {
        const org = decodeURIComponent(provList[1]!);
        const db = dbTop(env);
        if (!requireAdmin(request, env)) return unauthorized();
        type Body = {
          id: string;
          name: string;
          endpointUrl?: string;
          region?: string;
          status?: "active" | "inactive";
        };
        const b = await readJson<Body>(request);
        if (!b.id || !b.name) {
          return json({ error: "id and name are required" }, { status: 400 });
        }
        await d1Run(
          db,
          `INSERT OR REPLACE INTO providers (id, name, endpoint_url, region, status, created_at)
           VALUES (?, ?, ?, ?, COALESCE(?, 'active'), ?)`,
          [b.id, b.name, b.endpointUrl ?? null, b.region ?? null, b.status, nowMs()]
        );
        return json({ ok: true, id: b.id });
      }

      // Datasets
      const dsList = path.match(/^\/orgs\/([^/]+)\/datasets$/);
      if (request.method === "GET" && dsList) {
        const org = decodeURIComponent(dsList[1]!);
        const db = dbTop(env);
        const rows = await d1All<{
          id: string;
          name: string;
          description: string | null;
          created_at: number;
        }>(
          db,
          "SELECT id, name, description, created_at FROM datasets ORDER BY created_at DESC"
        );
        return json({ datasets: rows });
      }
      if (request.method === "POST" && dsList) {
        const org = decodeURIComponent(dsList[1]!);
        const db = dbTop(env);
        if (!requireAdmin(request, env)) return unauthorized();
        type Body = { name: string; description?: string };
        const b = await readJson<Body>(request);
        if (!b.name) return json({ error: "name is required" }, { status: 400 });
        const id = uuid();
        await d1Run(
          db,
          `INSERT INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
          [id, b.name, b.description ?? null, nowMs()]
        );
        return json({ ok: true, id });
      }

      // Uploads: register or initiate storage for a piece
      const uploads = path.match(/^\/orgs\/([^/]+)\/uploads$/);
      if (request.method === "POST" && uploads) {
        const org = decodeURIComponent(uploads[1]!);
        const db = dbTop(env);
        type Body = {
          datasetId: string;
          // Either provide a known PieceCID, or provide inputs to compute CommP (POC: stubbed)
          pieceCid?: string;
          bytesBase64?: string;
          contentUrl?: string;
          sizeBytes?: number;
          providerId?: string;
        };
        const b = await readJson<Body>(request);
        if (!b.datasetId) {
          return json({ error: "datasetId is required" }, { status: 400 });
        }
        // Confirm dataset exists (auto-create a well-known 'default' id)
        let ds = await d1All<{ id: string }>(
          db,
          "SELECT id FROM datasets WHERE id = ?",
          [b.datasetId]
        );
        if (ds.length === 0 && b.datasetId === "default") {
          await d1Run(
            db,
            `INSERT OR IGNORE INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
            ["default", "default", "auto-created default dataset", nowMs()]
          );
          ds = await d1All<{ id: string }>(
            db,
            "SELECT id FROM datasets WHERE id = ?",
            [b.datasetId]
          );
        }
        if (ds.length === 0) return notFound("unknown dataset");

        const client = pdpClient(env);
        const pieceCid =
          b.pieceCid ??
          (await client.computeCommP({
            bytesBase64: b.bytesBase64,
            contentUrl: b.contentUrl,
            sizeBytes: b.sizeBytes
          })).pieceCid;

        // Insert piece if missing
        const existing = await d1All<{ piece_cid: string }>(
          db,
          "SELECT piece_cid FROM pieces WHERE piece_cid = ?",
          [pieceCid]
        );
        if (existing.length === 0) {
          await d1Run(
            db,
            `INSERT INTO pieces (piece_cid, dataset_id, size_bytes, provider_id, status, created_at)
             VALUES (?, ?, ?, ?, 'registered', ?)`,
            [
              pieceCid,
              b.datasetId,
              b.sizeBytes ?? null,
              b.providerId ?? env.DEFAULT_PROVIDER_ID ?? null,
              nowMs()
            ]
          );
        }

        // Kick storage (real via Synapse when configured; else queued)
        const store = await client.storePiece({
          pieceCid,
          providerId: b.providerId,
          bytesBase64: b.bytesBase64
        });

        const uploadId = uuid();
        await d1Run(
          db,
          `INSERT INTO uploads (id, piece_cid, source, state, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uploadId,
            pieceCid,
            b.bytesBase64 ? "inline" : b.contentUrl ? "url" : b.pieceCid ? "reference" : "unspecified",
            store.state,
            store.error ?? null,
            nowMs()
          ]
        );

        // Update piece status/provider if we have them
        await d1Run(
          db,
          `UPDATE pieces SET status = ?, provider_id = COALESCE(?, provider_id) WHERE piece_cid = ?`,
          [store.state, store.providerId ?? null, pieceCid]
        );

        return json({
          ok: true,
          uploadId,
          pieceCid,
          state: store.state,
          note: client ? undefined : "POC storage initiation (mock mode)"
        });
      }

      // Fetch a piece record
      const pieceMatch = path.match(/^\/orgs\/([^/]+)\/pieces\/([^/]+)$/);
      if (request.method === "GET" && pieceMatch) {
        const org = decodeURIComponent(pieceMatch[1]!);
        const pieceCid = decodeURIComponent(pieceMatch[2]!);
        const db = dbForOrg(env, org);
        const rows = await d1All<{
          piece_cid: string;
          dataset_id: string;
          size_bytes: number | null;
          provider_id: string | null;
          status: string;
          created_at: number;
        }>(
          db,
          `SELECT piece_cid, dataset_id, size_bytes, provider_id, status, created_at
           FROM pieces WHERE piece_cid = ?`,
          [pieceCid]
        );
        if (rows.length === 0) return notFound("unknown piece");
        return json(rows[0]);
      }
      // Retrieve bytes for a piece (when Synapse is configured)
      const pieceBytes = path.match(/^\/orgs\/([^/]+)\/pieces\/([^/]+)\/bytes$/);
      if (request.method === "GET" && pieceBytes) {
        const pieceCid = decodeURIComponent(pieceBytes[2]!);
        const client = pdpClient(env);
        try {
          const bytes = await client.downloadPiece(pieceCid);
          const buf = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(buf).set(bytes);
          return new Response(buf, {
            headers: { "content-type": "application/octet-stream" }
          });
        } catch (e) {
          return json({ error: (e as Error).message }, { status: 400 });
        }
      }

      // Pricing endpoint
      if (request.method === "GET" && path === "/pricing") {
        return json({
          free_tier: "6 months or 1 GB, whichever comes first",
          paid: "$5/GB/month after",
          currency: ["USD", "ETH"],
          disclaimer:
            "This is a proof-of-concept. No real billing is performed. Contact FilOz to discuss production."
        });
      }

      // Internal D1 gateway
      const internal = path.match(/^\/__internal\/d1\/([^/]+)\/.*$/);
      if (internal) {
        const id = (env as any).D1GW.idFromName(internal[1]);
        const stub = (env as any).D1GW.get(id);
        return await stub.fetch(request);
      }
      // Fallback: forward org-scoped routes to the Engine container DO
      const orgScoped = path.match(/^\/orgs\/([^/]+)\/.*$/);
      if (orgScoped) {
        const id = (env as any).ENGINE.idFromName(orgScoped[1]);
        const stub = (env as any).ENGINE.get(id);
        return await stub.fetch(request);
      }
      return json({ error: "route not found" }, { status: 404 });
    } catch (err) {
      return json(
        { error: (err as Error).message ?? "internal error" },
        { status: 500 }
      );
    }
  }
};
