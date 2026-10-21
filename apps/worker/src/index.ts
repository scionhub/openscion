import { d1All, d1Run, nowMs, uuid } from "./db";
import { PDPClient } from "./pdp";

export interface Env {
  DB_FILECOIN_PROJECT: D1Database;
  ADMIN_TOKEN?: string;
  PDP_BASE_URL?: string;
  SYNAPSE_API_KEY?: string;
  DEFAULT_PROVIDER_ID?: string;
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
    defaultProviderId: env.DEFAULT_PROVIDER_ID
  });
}

export default {
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

      // Org landing (single org in POC)
      if (request.method === "GET" && path === "/orgs/filecoin-project") {
        return json({
          org: "filecoin-project",
          databases: ["d1:scionhub-filecoin-project"],
          apis: {
            providers: "/orgs/filecoin-project/providers",
            datasets: "/orgs/filecoin-project/datasets",
            uploads: "/orgs/filecoin-project/uploads",
            pieces: "/orgs/filecoin-project/pieces/{pieceCid}"
          }
        });
      }

      // Providers
      if (
        request.method === "GET" &&
        path === "/orgs/filecoin-project/providers"
      ) {
        const rows = await d1All<{
          id: string;
          name: string;
          endpoint_url: string | null;
          region: string | null;
          status: string;
          created_at: number;
        }>(
          env.DB_FILECOIN_PROJECT,
          "SELECT id, name, endpoint_url, region, status, created_at FROM providers ORDER BY created_at DESC"
        );
        return json({ providers: rows });
      }
      if (
        request.method === "POST" &&
        path === "/orgs/filecoin-project/providers"
      ) {
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
          env.DB_FILECOIN_PROJECT,
          `INSERT OR REPLACE INTO providers (id, name, endpoint_url, region, status, created_at)
           VALUES (?, ?, ?, ?, COALESCE(?, 'active'), ?)`,
          [b.id, b.name, b.endpointUrl ?? null, b.region ?? null, b.status, nowMs()]
        );
        return json({ ok: true, id: b.id });
      }

      // Datasets
      if (
        request.method === "GET" &&
        path === "/orgs/filecoin-project/datasets"
      ) {
        const rows = await d1All<{
          id: string;
          name: string;
          description: string | null;
          created_at: number;
        }>(
          env.DB_FILECOIN_PROJECT,
          "SELECT id, name, description, created_at FROM datasets ORDER BY created_at DESC"
        );
        return json({ datasets: rows });
      }
      if (
        request.method === "POST" &&
        path === "/orgs/filecoin-project/datasets"
      ) {
        if (!requireAdmin(request, env)) return unauthorized();
        type Body = { name: string; description?: string };
        const b = await readJson<Body>(request);
        if (!b.name) return json({ error: "name is required" }, { status: 400 });
        const id = uuid();
        await d1Run(
          env.DB_FILECOIN_PROJECT,
          `INSERT INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
          [id, b.name, b.description ?? null, nowMs()]
        );
        return json({ ok: true, id });
      }

      // Uploads: register or initiate storage for a piece
      if (request.method === "POST" && path === "/orgs/filecoin-project/uploads") {
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
        // Confirm dataset exists
        const ds = await d1All<{ id: string }>(
          env.DB_FILECOIN_PROJECT,
          "SELECT id FROM datasets WHERE id = ?",
          [b.datasetId]
        );
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
          env.DB_FILECOIN_PROJECT,
          "SELECT piece_cid FROM pieces WHERE piece_cid = ?",
          [pieceCid]
        );
        if (existing.length === 0) {
          await d1Run(
            env.DB_FILECOIN_PROJECT,
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

        // Kick storage (POC: queued state)
        const store = await client.storePiece({
          pieceCid,
          providerId: b.providerId
        });

        const uploadId = uuid();
        await d1Run(
          env.DB_FILECOIN_PROJECT,
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
          env.DB_FILECOIN_PROJECT,
          `UPDATE pieces SET status = ?, provider_id = COALESCE(?, provider_id) WHERE piece_cid = ?`,
          [store.state, store.providerId ?? null, pieceCid]
        );

        return json({
          ok: true,
          uploadId,
          pieceCid,
          state: store.state,
          note:
            "POC storage initiation — real PDP/Synapse integration required for production"
        });
      }

      // Fetch a piece record
      const pieceMatch = path.match(/^\/orgs\/filecoin-project\/pieces\/([^/]+)$/);
      if (request.method === "GET" && pieceMatch) {
        const captured = pieceMatch[1];
        if (!captured) return notFound("unknown piece");
        const pieceCid = decodeURIComponent(captured);
        const rows = await d1All<{
          piece_cid: string;
          dataset_id: string;
          size_bytes: number | null;
          provider_id: string | null;
          status: string;
          created_at: number;
        }>(
          env.DB_FILECOIN_PROJECT,
          `SELECT piece_cid, dataset_id, size_bytes, provider_id, status, created_at
           FROM pieces WHERE piece_cid = ?`,
          [pieceCid]
        );
        if (rows.length === 0) return notFound("unknown piece");
        return json(rows[0]);
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

      return json({ error: "route not found" }, { status: 404 });
    } catch (err) {
      return json(
        { error: (err as Error).message ?? "internal error" },
        { status: 500 }
      );
    }
  }
};
