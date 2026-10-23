// Durable Object Container that fronts the Rust engine container.
// Uses the Durable Object Container API available via `this.ctx.container`.
import { Container } from "@cloudflare/containers";
import { forcedLockupMessage } from "./durability";

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
    const init: RequestInit = {
      method: request.method,
      headers: (() => {
        const h = new Headers(request.headers);
        h.set("x-org", parts[2]!);
        h.set("x-worker-internal", "1");
        return h;
      })(),
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "manual"
    };
    const resp = await this.containerFetch(new URL(targetPath, "http://container").toString(), init);
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
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

export interface Env { INTERNAL_SECRET?: string }
