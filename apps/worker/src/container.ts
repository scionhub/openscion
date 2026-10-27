// Durable Object Container that fronts the Rust engine container.
// Uses the Durable Object Container API available via `this.ctx.container`.
import { Container } from "@cloudflare/containers";
import {
  acquireRepoLease,
  parseRefExpected,
  recordRepoTip,
  REF_LEASE_MS,
  releaseRepoLease,
  staleRepoTips,
} from "./cas";
import { dbOrgs, type D1Env } from "./db";
import { forcedLockupMessage } from "./durability";
import {
  fetchRepoSnapshot,
  hydrateEngine,
  isRepoWrite,
  persistEngineWrite,
  persistKind,
  persistUploadedObjects,
  refNameFromPath,
  repoScope,
} from "./restore";

type ForceFlag = { org?: string; kind?: string; once?: boolean };

export class EngineContainer extends Container<Env> {
  override defaultPort = 7878;
  override sleepAfter = "30s";

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__internal/force-add-error") {
      const storage = (this as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
      if (request.method === "POST") {
        const b = (await request.json()) as ForceFlag;
        await storage.put("force_add_error", {
          org: b.org ?? "*",
          kind: b.kind ?? "lockup",
          once: b.once !== false,
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "DELETE") {
        await storage.delete("force_add_error");
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "GET") {
        const flag = (await storage.get("force_add_error")) ?? null;
        return new Response(JSON.stringify({ flag }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("method not allowed", { status: 405 });
    }
    // Expect /orgs/{org}/...
    const parts = url.pathname.split("/");
    if (parts.length < 3 || parts[1] !== "orgs") {
      return new Response("bad route", { status: 400 });
    }
    const restPath = "/" + parts.slice(3).join("/");
    const targetPath = restPath + url.search;
    if (restPath.includes("/v1/admin/add-pieces") && request.method === "POST") {
      const forced = await this.maybeForceAddError(request);
      if (forced) return forced;
    }
    // Start container if needed and proxy to default port; pass Worker env and origin
    await (this as any).startAndWaitForPorts({
      startOptions: { envVars: {
        INTERNAL_SECRET: (this.env as any).INTERNAL_SECRET ?? "",
        WORKER_BASE_URL: url.origin,
        ...(this.env as any).ADMIN_TOKEN ? { ADMIN_TOKEN: (this.env as any).ADMIN_TOKEN } : {},
        ...(this.env as any).PDP_BASE_URL ? { PDP_BASE_URL: (this.env as any).PDP_BASE_URL } : {},
        ...(this.env as any).PDP_PRIVATE_KEY ? { PDP_PRIVATE_KEY: (this.env as any).PDP_PRIVATE_KEY } : {},
        ...(this.env as any).PDP_CHAIN_ID ? { PDP_CHAIN_ID: (this.env as any).PDP_CHAIN_ID } : {},
        ...(this.env as any).PDP_SERVICE_CONTRACT ? { PDP_SERVICE_CONTRACT: (this.env as any).PDP_SERVICE_CONTRACT } : {},
        ...(this.env as any).PDP_PAYER ? { PDP_PAYER: (this.env as any).PDP_PAYER } : {},
        ...(this.env as any).PDP_PAYEE ? { PDP_PAYEE: (this.env as any).PDP_PAYEE } : {}
      } }
    });
    const bodyBuf = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request.arrayBuffer();
    const scoped = repoScope(restPath);
    const toContainer: (path: string, init: RequestInit) => Promise<Response> = (path, init) =>
      this.containerFetch(new URL(path, "http://container").toString(), init);
    const kind = persistKind(request.method, restPath);
    const tipWrite = kind === "ref" || kind === "ref-delete";
    let leaseHolder: string | null = null;
    if (scoped && isRepoWrite(request.method, restPath)) {
      const snapshot = await fetchRepoSnapshot(this.env, url, scoped.org, scoped.repo).catch(
        () => ({ changesets: [], refs: [] })
      );
      if (tipWrite) {
        leaseHolder = crypto.randomUUID();
        const db = orgsDb(this.env);
        if (db) {
          const got = await acquireRepoLease(db, scoped.org, scoped.repo, leaseHolder, REF_LEASE_MS);
          if (!got) {
            return jsonError("repo is busy", 409);
          }
          const stale = await staleRepoTips(db, scoped.org, scoped.repo, snapshot.refs);
          if (stale.length > 0) {
            await releaseRepoLease(db, scoped.org, scoped.repo, leaseHolder);
            return jsonError("stale repository snapshot", 409);
          }
        }
      }
      await hydrateEngine(this.env, scoped.org, scoped.repo, snapshot, toContainer).catch((err) => {
        console.error("[hydrate]", scoped.org, scoped.repo, err);
      });
    }
    const init: RequestInit = {
      method: request.method,
      headers: (() => {
        const h = new Headers(request.headers);
        h.set("x-org", parts[2]!);
        h.set("x-worker-internal", "1");
        return h;
      })(),
      body: bodyBuf,
      redirect: "manual"
    };
    try {
      const resp = await this.containerFetch(new URL(targetPath, "http://container").toString(), init);
      if (scoped && kind && resp.ok) {
        const respBuf = await resp.arrayBuffer();
        const expected = kind === "ref" && bodyBuf
          ? parseRefExpected(safeJson(bodyBuf))
          : undefined;
        if (kind === "ref") {
          const value = safeJson(respBuf) as { name?: string; target?: string; version?: number };
          const db = orgsDb(this.env);
          if (db && value.name && value.target && value.version != null) {
            await recordRepoTip(db, scoped.org, scoped.repo, value.name, value.target, value.version);
          }
        }
        await persistEngineWrite(
          this.env,
          url,
          scoped.org,
          scoped.repo,
          kind,
          refNameFromPath(restPath) ?? undefined,
          respBuf,
          toContainer,
          { expected }
        ).catch((err) => {
          console.error("[persist]", scoped.org, scoped.repo, kind, err);
        });
        if (kind === "bundles" && bodyBuf) {
          await persistUploadedObjects(this.env, url, scoped.org, scoped.repo, bodyBuf).catch((err) => {
            console.error("[persist-objects]", scoped.org, scoped.repo, err);
          });
        }
        return new Response(respBuf, { status: resp.status, headers: resp.headers });
      }
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } finally {
      if (scoped && leaseHolder) {
        const db = orgsDb(this.env);
        if (db) await releaseRepoLease(db, scoped.org, scoped.repo, leaseHolder);
      }
    }
  }

  private async maybeForceAddError(request: Request): Promise<Response | null> {
    const header = request.headers.get("x-scn-force-add-error");
    const storage = (this as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
    const flag = (await storage.get("force_add_error")) as ForceFlag | undefined;
    let kind: string | null = null;
    let consume = false;
    if (header === "lockup" || header === "InsufficientLockupFunds") {
      kind = "lockup";
    } else if (flag) {
      const peek = (await request.clone().json().catch(() => ({}))) as { org?: string };
      if (!flag.org || flag.org === "*" || flag.org === peek.org) {
        kind = flag.kind ?? "lockup";
        consume = flag.once !== false;
      }
    }
    if (!kind) return null;
    if (consume) await storage.delete("force_add_error");
    const message = forcedLockupMessage(kind);
    return new Response(JSON.stringify({ code: "AddPiecesFailed", message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

export interface Env extends D1Env {
  INTERNAL_SECRET?: string;
  REPO?: DurableObjectNamespace;
}

function orgsDb(env: Env): D1Database | null {
  try {
    return dbOrgs(env);
  } catch {
    return null;
  }
}

function safeJson(buf: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
