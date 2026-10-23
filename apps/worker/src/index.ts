import { d1All, d1Run, dbOrgs, dbTop, nowMs, uuid } from "./db";
import {
  DEFAULT_SHARED_DATASET_MAX_BYTES,
  SHARED_DATASET_ORG,
  getDatasetUsage,
  parseEnvInt,
  setOrgDatasetMode,
  sharedDatasetStatus,
} from "./dataset";
import { PDPClient } from "./pdp";
import { EngineContainer } from "./container";
import { D1Gateway } from "./d1";
import { RepoDO } from "./repo";
import { docsHtml } from "./docs";
import { handlePulls, engineFetch, remapCompareResponse } from "./pulls";
import { handleRepoCreate } from "./repos";
import { handleMe, handleOrgCreate } from "./orgs";
import { handleRepoDelete, handleRepoOwners, repoViewer, adminRecomputeUsage, adminBackfillBundleRefs, isRepoOwner } from "./owners";
import { applySettingsPatch, getRepoSettings, isMainRef, PROTECTED_MAIN_MESSAGE, refWriteTarget, saveRepoSettings } from "./settings";
import { fillEntrySizes, proxyEngine } from "./browse";
import {
  type Actor,
  authorizeMutation,
  guardSignup,
  isReadOnlyPost,
  loadActor,
  orgCanWrite,
  unauthorized,
} from "./authz";

export interface Env {
  DB_SCIONHUB_TOP: D1Database;
  ORGS_DB?: D1Database;
  ENGINE: DurableObjectNamespace;
  D1GW: DurableObjectNamespace;
  REPO: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  INTERNAL_SECRET?: string;
  PDP_BASE_URL?: string;
  PDP_PRIVATE_KEY?: string;
  PDP_CHAIN_ID?: string;
  PDP_SERVICE_CONTRACT?: string;
  PDP_PAYER?: string;
  PDP_PAYEE?: string;
  SYNAPSE_API_KEY?: string;
  SYNAPSE_PRIVATE_KEY?: string;
  SOURCE_TAG?: string;
  DEFAULT_PROVIDER_ID?: string;
  CONTAINER_URL?: string; // e.g., http://127.0.0.1:7878
  ADD_BATCH_WINDOW_SECS?: string;
  ADD_BATCH_MAX_PIECES?: string;
  SHARED_DATASET_MAX_BYTES?: string;
}

type JsonValue = unknown;

function json(body: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
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

export default {
  // Durable Object classes export for wrangler binding
  EngineContainer,
  D1Gateway,
  RepoDO,
  // Forward top-level OpenScion API to the Engine container
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, content-type, range, x-admin-token, x-scn-force-add-error",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    const resp = await (this as any).handle(request, env);
    if (resp.status === 101 || resp.headers.get("Access-Control-Allow-Origin")) return resp;
    const out = new Response(resp.body, resp);
    out.headers.set("Access-Control-Allow-Origin", "*");
    out.headers.set("Access-Control-Expose-Headers", "Location, Content-Range, Content-Length");
    return out;
  },

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && path === "/v1/admin/durability") {
        if (!requireAdmin(request, env)) return unauthorized();
        return await adminDurability(env, url);
      }
      const recompute = path.match(/^\/v1\/admin\/datasets\/([^/]+)\/recompute-usage$/);
      if (recompute && request.method === "POST") {
        if (!requireAdmin(request, env)) return unauthorized();
        return await adminRecomputeUsage(env, url, decodeURIComponent(recompute[1]!), engineFetch);
      }
      const backfill = path.match(/^\/v1\/admin\/repos\/([^/]+)\/([^/]+)\/backfill-bundle-refs$/);
      if (backfill && request.method === "POST") {
        if (!requireAdmin(request, env)) return unauthorized();
        return await adminBackfillBundleRefs(env, url, decodeURIComponent(backfill[1]!), decodeURIComponent(backfill[2]!));
      }
      const datasetMode = path.match(/^\/v1\/admin\/orgs\/([^/]+)\/dataset-mode$/);
      if (datasetMode && request.method === "POST") {
        if (!requireAdmin(request, env)) return unauthorized();
        const org = decodeURIComponent(datasetMode[1]!);
        const b = await readJson<{ mode?: string }>(request);
        if (b.mode !== "own" && b.mode !== "shared") {
          return json({ error: "mode must be own or shared" }, { status: 400 });
        }
        const saved = await setOrgDatasetMode(env, org, b.mode, Date.now());
        return json(saved);
      }
      if (path === "/v1/admin/test/force-add-error") {
        if (!requireAdmin(request, env)) return unauthorized();
        if (request.method === "POST") {
          const b = (await readJson<{ org?: string; kind?: string; once?: boolean }>(request));
          const id = env.ENGINE.idFromName("filecoin-project");
          const stub = env.ENGINE.get(id);
          return await stub.fetch(
            new Request(new URL("/__internal/force-add-error", url).toString(), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                org: b.org ?? "*",
                kind: b.kind ?? "lockup",
                once: b.once !== false,
              }),
            })
          );
        }
        if (request.method === "DELETE") {
          const id = env.ENGINE.idFromName("filecoin-project");
          const stub = env.ENGINE.get(id);
          return await stub.fetch(new Request(new URL("/__internal/force-add-error", url).toString(), { method: "DELETE" }));
        }
        return json({ error: "method not allowed" }, { status: 405 });
      }
      const wipe = path.match(/^\/v1\/admin\/repos\/([^/]+)\/([^/]+)\/reset$/);
      if (wipe && request.method === "POST") {
        if (!requireAdmin(request, env)) return unauthorized();
        const org = decodeURIComponent(wipe[1]!);
        const repo = decodeURIComponent(wipe[2]!);
        const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
        const h = new Headers();
        h.set("x-internal-secret", env.INTERNAL_SECRET || "");
        return await stub.fetch(new Request(new URL(`/__internal/do/${org}/${repo}/reset`, url).toString(), { method: "POST", headers: h }));
      }
      const adm = path.match(/^\/v1\/admin\/repos\/([^/]+)\/([^/]+)\/(pending|pending-status|kick|pending\/[^/]+|refs\/.+)$/);
      if (adm) {
        if (!requireAdmin(request, env)) return unauthorized();
        const org = decodeURIComponent(adm[1]!);
        const repo = decodeURIComponent(adm[2]!);
        const what = adm[3]!;
        const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
        const h = new Headers();
        h.set("x-internal-secret", env.INTERNAL_SECRET || "");
        let sub: string; let method = "GET";
        if (what.startsWith("pending/") && request.method === "DELETE") { sub = `pending-adds/${encodeURIComponent(decodeURIComponent(what.slice(8)))}`; method = "DELETE"; }
        else if (what === "pending") sub = "pending-adds";
        else if (what === "pending-status") sub = "pending-adds/status";
        else if (what === "kick") { sub = "kick"; method = "POST"; }
        else if (request.method === "PUT") {
          // Admin CAS: body { expected, new } forwarded to the engine ref endpoint.
          const body = await request.text();
          return await engineFetch(env, url, `/v1/repos/${org}/${repo}/${what}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
        } else if (request.method === "DELETE" && what.startsWith("refs/")) {
          // Drop the in-memory engine ref and the RepoDO row (engine DELETE does both).
          return await engineFetch(env, url, `/v1/repos/${org}/${repo}/${what}`, {
            method: "DELETE",
          });
        } else {
          if (request.method !== "DELETE") return new Response("method not allowed", { status: 405 });
          sub = `refs/${encodeURIComponent(what.slice(5))}`; method = "DELETE";
        }
        return await stub.fetch(new Request(new URL(`/__internal/do/${org}/${repo}/${sub}`, url).toString(), { method, headers: h }));
      }
      const br = path.match(/^\/v1\/repos\/([^/]+)\/([^/]+)\/branches$/);
      if (br && request.method === "GET") {
        const org = decodeURIComponent(br[1]!);
        const repo = decodeURIComponent(br[2]!);
        const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
        const h = new Headers();
        h.set("x-internal-secret", env.INTERNAL_SECRET || "");
        const r = await stub.fetch(new Request(new URL(`/__internal/do/${org}/${repo}/refs`, url).toString(), { method: "GET", headers: h }));
        if (!r.ok) return r;
        const j = (await r.json()) as { refs: { name: string; target: string; version: number }[] };
        const branches = (j.refs ?? [])
          .filter((x) => !x.name.startsWith("refs/tags/"))
          .map((x) => ({ name: x.name.replace(/^refs\/heads\//, ""), target: x.target }));
        return new Response(JSON.stringify({ branches }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "GET" && path === "/docs") {
        return new Response(docsHtml(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      const membership = path.match(/^\/v1\/orgs\/([^/]+)\/membership$/);
      if (membership && request.method === "GET") {
        const actor = await loadActor(env, request);
        if (!actor) return unauthorized();
        const org = decodeURIComponent(membership[1]!);
        const member = actor.admin || (await orgCanWrite(env, org, actor));
        return json({ org, username: actor.name, member, admin: actor.admin });
      }
      if (path.startsWith("/v1/")) {
        // Anonymous GETs and known POST reads (clone, resolve, login, signup).
        // All other writes require a token; org membership is not required for
        // user-namespace refs, blob uploads (size-capped), or opening a PR.
        const method = request.method.toUpperCase();
        const isMutating =
          (method === "POST" && !isReadOnlyPost(path)) ||
          method === "PUT" ||
          method === "PATCH" ||
          method === "DELETE";
        let actor: Actor | null = null;
        if (isMutating) {
          actor = await loadActor(env, request);
          if (!actor) return unauthorized();
          const authErr = await authorizeMutation(env, request, path, actor);
          if (authErr) return authErr;
          // Protect main: direct ref writes to main are refused; merges go through the engine directly.
          const refTarget = refWriteTarget(path);
          if (refTarget && isMainRef(refTarget[2])) {
            const s = await getRepoSettings(env, refTarget[0], refTarget[1]);
            if (s.protectMain) return Response.json({ error: PROTECTED_MAIN_MESSAGE, code: "MainProtected", message: PROTECTED_MAIN_MESSAGE }, { status: 409 });
          }
        }
        const settingsMatch = path.match(/^\/v1\/repos\/([^/]+)\/([^/]+)\/settings$/);
        if (settingsMatch) {
          const so = decodeURIComponent(settingsMatch[1]!);
          const sr = decodeURIComponent(settingsMatch[2]!);
          if (method === "GET") return Response.json(await getRepoSettings(env, so, sr));
          if (method === "PUT" || method === "PATCH") {
            if (!actor) return unauthorized();
            if (!actor.admin && !(await isRepoOwner(env, so, sr, actor.userId))) {
              return Response.json({ error: "only repo owners can change settings" }, { status: 403 });
            }
            const patch = applySettingsPatch(await getRepoSettings(env, so, sr), await request.json().catch(() => null));
            if (!patch.ok) return Response.json({ error: patch.error }, { status: 400 });
            await saveRepoSettings(env, so, sr, patch.settings, actor);
            return Response.json(patch.settings);
          }
          return new Response("method not allowed", { status: 405 });
        }
        if (method === "POST" && path === "/v1/auth/signup") {
          const blocked = await guardSignup(env, request);
          if (blocked) return blocked;
        }
        const pulls = await handlePulls(request, env, path, actor ?? (await loadActor(env, request)));
        if (pulls) return pulls;
        const created = await handleRepoCreate(request, env, path, actor);
        if (created) return created;
        const owners = await handleRepoOwners(
          request,
          env,
          path,
          actor ?? (await loadActor(env, request))
        );
        if (owners) return owners;
        const deleted = await handleRepoDelete(
          request,
          env,
          path,
          actor,
          url,
          engineFetch
        );
        if (deleted) return deleted;
        const orgCreated = await handleOrgCreate(request, env, path, actor);
        if (orgCreated) return orgCreated;
        const me = await handleMe(
          request,
          env,
          path,
          actor ?? (method === "GET" && path === "/v1/me" ? await loadActor(env, request) : null)
        );
        if (me) return me;
        // Catalog reads are served from the durable top D1 (the engine's catalog is in-memory).
        if (method === "GET" && path === "/v1/orgs") {
          const rows = await d1All<{ id: string }>(dbTop(env), "SELECT id FROM orgs ORDER BY id", []);
          return json(rows.map((r) => r.id));
        }
        const repoList = path.match(/^\/v1\/orgs\/([^/]+)\/repos$/);
        if (method === "GET" && repoList) {
          const org = decodeURIComponent(repoList[1]!);
          const rows = await listRepoNames(env, org);
          return json(rows);
        }
        const repoGet = path.match(/^\/v1\/repos\/([^/]+)\/([^/]+)$/);
        if (method === "GET" && repoGet) {
          const org = decodeURIComponent(repoGet[1]!);
          const repo = decodeURIComponent(repoGet[2]!);
          const rows = await d1All<{ name: string; visibility: string; created_at: number }>(
            dbOrgs(env),
            "SELECT name, visibility, created_at FROM repos WHERE id = ? LIMIT 1",
            [`${org}/${repo}`]
          );
          const row = rows[0];
          if (row) {
            const body: Record<string, unknown> = {
              org,
              name: row.name,
              visibility: row.visibility,
              created_at: row.created_at,
            };
            const viewerActor = actor ?? (await loadActor(env, request));
            if (viewerActor) {
              body.viewer = await repoViewer(env, org, repo, viewerActor);
            }
            return json(body);
          }
          // Catalog lives on ORGS_DB. Missing row means the repo was never
          // created here or was deleted; do not resurrect it from the engine.
          return notFound("not found");
        }
        const treeMatch = path.match(/^\/v1\/repos\/([^/]+)\/([^/]+)\/tree\/(.+)$/);
        if (method === "GET" && treeMatch) {
          const org = decodeURIComponent(treeMatch[1]!);
          const repo = decodeURIComponent(treeMatch[2]!);
          const resp = await proxyEngine(env, request, url);
          if (!resp.ok) return resp;
          const body = (await resp.json()) as { entries?: { kind?: string; size?: number | null; pieceCid?: string | null }[] };
          await fillEntrySizes(env, url, org, repo, body.entries ?? []);
          return json(body);
        }
        const createRepo = method === "PUT" ? path.match(/^\/v1\/repos\/([^/]+)\/([^/]+)$/) : null;
        // Route through the EngineContainer Durable Object; scope to the default org
        const id = env.ENGINE.idFromName("filecoin-project");
        const stub = env.ENGINE.get(id);
        const u = new URL(request.url);
        u.pathname = "/orgs/filecoin-project" + url.pathname;
        // Preserve method, headers, and the streaming body by passing the original request as init
        const resp = await stub.fetch(new Request(u.toString(), request));
        if (createRepo && resp.ok) {
          const org = decodeURIComponent(createRepo[1]!);
          const repo = decodeURIComponent(createRepo[2]!);
          await insertRepoRow(env, org, repo, Date.now());
        }
        if (method === "GET" && resp.ok && (/\/compare(\/|$)/.test(path) || /\/diff$/.test(path))) {
          return remapCompareResponse(resp);
        }
        return resp;
      }
      // Service root and health
      if (request.method === "GET" && (path === "/" || path === "/healthz")) {
        return json({
          name: "scionbase-server",
          version: "0.1.0",
          orgs: ["filecoin-project"],
          pricing: {
            free_tier: "6 months or 1 GB, whichever comes first",
            paid: "$5/GB/month after",
            note:
              "POC only — no real billing; contact FilOz to discuss production"
          },
          links: {
            org: "/orgs/filecoin-project",
            docs: "/docs"
          }
        });
      }
      // Internal DO pass-through
      const mDo = path.match(/^\/__internal\/do\/([^/]+)\/([^/]+)\/(.*)$/);
      if (mDo) {
        const org = decodeURIComponent(mDo[1]!);
        const repo = decodeURIComponent(mDo[2]!);
        const id = env.REPO.idFromName(`${org}/${repo}`);
        const stub = env.REPO.get(id);
        const headers = new Headers(request.headers);
        headers.set("x-internal-secret", env.INTERNAL_SECRET || "");
        const forwarded = new Request(new URL(`/__internal/do/${org}/${repo}/${mDo[3]}${url.search}`, url).toString(), {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text()
        });
        return await stub.fetch(forwarded);
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
          databases: ["d1:binding ORGS_DB (scionbase-orgs)", "d1:binding DB_SCIONHUB_TOP"],
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
        const db = dbOrgs(env);
        let rows: {
          id: string;
          name: string;
          endpoint_url: string | null;
          region: string | null;
          status: string;
          created_at: number;
        }[] = [];
        try {
          rows = await d1All(
            db,
            `SELECT id, name, endpoint_url, region, status, created_at FROM providers
              WHERE org = ? OR org IS NULL
              ORDER BY created_at DESC`,
            [org]
          );
        } catch {
          rows = await d1All(
            db,
            "SELECT id, name, endpoint_url, region, status, created_at FROM providers ORDER BY created_at DESC"
          );
        }
        return json({ providers: rows });
      }
      if (request.method === "POST" && provList) {
        const org = decodeURIComponent(provList[1]!);
        const db = dbOrgs(env);
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
        try {
          await d1Run(
            db,
            `INSERT OR REPLACE INTO providers (id, name, endpoint_url, region, status, created_at, org)
             VALUES (?, ?, ?, ?, COALESCE(?, 'active'), ?, ?)`,
            [b.id, b.name, b.endpointUrl ?? null, b.region ?? null, b.status, nowMs(), org]
          );
        } catch {
          await d1Run(
            db,
            `INSERT OR REPLACE INTO providers (id, name, endpoint_url, region, status, created_at)
             VALUES (?, ?, ?, ?, COALESCE(?, 'active'), ?)`,
            [b.id, b.name, b.endpointUrl ?? null, b.region ?? null, b.status, nowMs()]
          );
        }
        return json({ ok: true, id: b.id });
      }

      // Datasets
      const dsList = path.match(/^\/orgs\/([^/]+)\/datasets$/);
      if (request.method === "GET" && dsList) {
        const org = decodeURIComponent(dsList[1]!);
        const db = dbOrgs(env);
        let rows: { id: string; name: string; description: string | null; created_at: number }[] = [];
        try {
          rows = await d1All(
            db,
            "SELECT id, name, description, created_at FROM datasets WHERE org = ? ORDER BY created_at DESC",
            [org]
          );
        } catch {
          rows = await d1All(
            db,
            "SELECT id, name, description, created_at FROM datasets ORDER BY created_at DESC"
          );
        }
        return json({ datasets: rows });
      }
      if (request.method === "POST" && dsList) {
        const org = decodeURIComponent(dsList[1]!);
        const db = dbOrgs(env);
        if (!requireAdmin(request, env)) return unauthorized();
        type Body = { name: string; description?: string };
        const b = await readJson<Body>(request);
        if (!b.name) return json({ error: "name is required" }, { status: 400 });
        try {
          const existing = await d1All<{ id: string }>(
            db,
            "SELECT id FROM datasets WHERE org = ? ORDER BY created_at ASC LIMIT 1",
            [org]
          );
          if (existing[0]) {
            return json({ ok: true, id: existing[0].id, org, reused: true });
          }
        } catch {
          /* column may be missing on older DBs */
        }
        const id = uuid();
        try {
          await d1Run(
            db,
            `INSERT INTO datasets (id, name, description, org, created_at) VALUES (?, ?, ?, ?, ?)`,
            [id, b.name, b.description ?? null, org, nowMs()]
          );
        } catch {
          await d1Run(
            db,
            `INSERT INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
            [id, b.name, b.description ?? null, nowMs()]
          );
        }
        return json({ ok: true, id, org });
      }

      // Uploads: register or initiate storage for a piece
      const uploads = path.match(/^\/orgs\/([^/]+)\/uploads$/);
      if (request.method === "POST" && uploads) {
        const org = decodeURIComponent(uploads[1]!);
        const db = dbOrgs(env);
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
          try {
            await d1Run(
              db,
              `INSERT OR IGNORE INTO datasets (id, name, description, org, created_at) VALUES (?, ?, ?, ?, ?)`,
              ["default", "default", "auto-created default dataset", org, nowMs()]
            );
          } catch {
            await d1Run(
              db,
              `INSERT OR IGNORE INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
              ["default", "default", "auto-created default dataset", nowMs()]
            );
          }
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
          try {
            await d1Run(
              db,
              `INSERT INTO pieces (piece_cid, dataset_id, size_bytes, provider_id, status, created_at, org)
               VALUES (?, ?, ?, ?, 'registered', ?, ?)`,
              [
                pieceCid,
                b.datasetId,
                b.sizeBytes ?? null,
                b.providerId ?? env.DEFAULT_PROVIDER_ID ?? null,
                nowMs(),
                org,
              ]
            );
          } catch {
            await d1Run(
              db,
              `INSERT INTO pieces (piece_cid, dataset_id, size_bytes, provider_id, status, created_at)
               VALUES (?, ?, ?, ?, 'registered', ?)`,
              [
                pieceCid,
                b.datasetId,
                b.sizeBytes ?? null,
                b.providerId ?? env.DEFAULT_PROVIDER_ID ?? null,
                nowMs(),
              ]
            );
          }
        }

        // Kick storage (real via Synapse when configured; else queued)
        const store = await client.storePiece({
          pieceCid,
          providerId: b.providerId,
          bytesBase64: b.bytesBase64
        });

        const uploadId = uuid();
        try {
          await d1Run(
            db,
            `INSERT INTO uploads (id, piece_cid, source, state, error, created_at, org)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              uploadId,
              pieceCid,
              b.bytesBase64 ? "inline" : b.contentUrl ? "url" : b.pieceCid ? "reference" : "unspecified",
              store.state,
              store.error ?? null,
              nowMs(),
              org,
            ]
          );
        } catch {
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
              nowMs(),
            ]
          );
        }

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
        const db = dbOrgs(env);
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

async function listRepoNames(env: Env, org: string): Promise<string[]> {
  try {
    const rows = await d1All<{ name: string }>(
      dbOrgs(env),
      "SELECT name FROM repos WHERE org = ? ORDER BY name",
      [org]
    );
    if (rows.length > 0) return rows.map((r) => r.name);
  } catch {
    /* org column missing on top-DB fallback */
  }
  const rows = await d1All<{ name: string }>(
    dbOrgs(env),
    "SELECT name FROM repos WHERE id LIKE ? ORDER BY name",
    [org + "/%"]
  );
  return rows.map((r) => r.name);
}

async function insertRepoRow(env: Env, org: string, repo: string, createdAt: number): Promise<void> {
  const db = dbOrgs(env);
  const id = `${org}/${repo}`;
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO repos (id, name, visibility, created_at, org) VALUES (?, ?, 'public', ?, ?)"
      )
      .bind(id, repo, createdAt, org)
      .run();
  } catch {
    await db
      .prepare("INSERT OR IGNORE INTO repos (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)")
      .bind(id, repo, createdAt)
      .run();
  }
}

async function adminDurability(env: Env, origin: URL): Promise<Response> {
  const rows = await d1All<{ id: string }>(dbOrgs(env), "SELECT id FROM repos ORDER BY id", []);
  const repos: unknown[] = [];
  for (const row of rows) {
    const slash = row.id.indexOf("/");
    if (slash < 1) continue;
    const org = row.id.slice(0, slash);
    const repo = row.id.slice(slash + 1);
    const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
    const h = new Headers();
    h.set("x-internal-secret", env.INTERNAL_SECRET || "");
    const r = await stub.fetch(
      new Request(new URL(`/__internal/do/${org}/${repo}/pending-adds/status`, origin).toString(), {
        method: "GET",
        headers: h,
      })
    );
    if (!r.ok) continue;
    const st = (await r.json()) as {
      lastError?: string | null;
      pending?: number;
      oldestAgeMs?: number;
      nextDrainAt?: number | null;
      stale?: unknown[];
      reasons?: unknown[];
    };
    if (!(st.pending || st.lastError || (st.stale && st.stale.length))) continue;
    repos.push({
      org,
      repo,
      pending: st.pending ?? 0,
      oldestAgeMs: st.oldestAgeMs ?? 0,
      nextDrainAt: st.nextDrainAt ?? null,
      stale: st.stale ?? [],
      lastError: st.lastError ?? null,
      reasons: st.reasons ?? [],
    });
  }
  const threshold = parseEnvInt(env.SHARED_DATASET_MAX_BYTES, DEFAULT_SHARED_DATASET_MAX_BYTES);
  const bytes = await getDatasetUsage(env, SHARED_DATASET_ORG);
  return json({
    repos,
    sharedDataset: sharedDatasetStatus(bytes, threshold),
  });
}

// Explicit named exports for Durable Object classes
export { EngineContainer, D1Gateway, RepoDO };
