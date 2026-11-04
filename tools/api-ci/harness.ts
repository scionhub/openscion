//! In-process Worker + real Rust engine. Same route handlers as production.

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RepoDO } from "../../apps/worker/src/repo.ts";
import { D1Gateway } from "../../apps/worker/src/d1.ts";
import worker from "../../apps/worker/src/index.ts";
import { applySqlDir, MemoryD1, seedProtectedRepos, sqlStorage } from "./d1.ts";

export type Harness = {
  workerUrl: string;
  engineUrl: string;
  adminToken: string;
  internalSecret: string;
  promoteAdmin: (username: string) => void;
  stop: () => Promise<void>;
};

type ForceFlag = { org?: string; kind?: string; once?: boolean };

const WORKER_ROOT = join(import.meta.dirname, "../../apps/worker");

function repoRoot(): string {
  return join(import.meta.dirname, "../..");
}

export function findEngineBin(): string {
  const env = process.env.OPENSCION_SERVER;
  if (env) return env;
  const candidates = [
    "/usr/local/bin/openscion-server",
    join(repoRoot(), "target/release/openscion-server"),
    join(repoRoot(), "target/debug/openscion-server"),
  ];
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  throw new Error(
    "openscion-server binary not found. Build with `cargo build -p openscion-server` or set OPENSCION_SERVER."
  );
}

function doState(sql: DatabaseSync): { storage: { sql: ReturnType<typeof sqlStorage>; setAlarm: () => void; get: () => unknown; put: () => void; delete: () => void } } {
  const mem = new Map<string, unknown>();
  return {
    storage: {
      sql: sqlStorage(sql),
      setAlarm() {},
      get(key?: string) {
        return mem.get(String(key));
      },
      put(key?: string, value?: unknown) {
        mem.set(String(key), value);
      },
      delete(key?: string) {
        mem.delete(String(key));
      },
    },
  };
}

class EngineStub {
  private force: ForceFlag | null = null;

  constructor(private readonly engineUrl: string) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__internal/force-add-error") {
      if (request.method === "POST") {
        const b = (await request.json()) as ForceFlag;
        this.force = { org: b.org ?? "*", kind: b.kind ?? "lockup", once: b.once !== false };
        return Response.json({ ok: true });
      }
      if (request.method === "DELETE") {
        this.force = null;
        return Response.json({ ok: true });
      }
      if (request.method === "GET") {
        return Response.json({ flag: this.force });
      }
      return new Response("method not allowed", { status: 405 });
    }

    const parts = url.pathname.split("/");
    if (parts.length < 3 || parts[1] !== "orgs") {
      return new Response("bad route", { status: 400 });
    }
    const restPath = "/" + parts.slice(3).join("/");
    const targetPath = restPath + url.search;

    if (restPath.includes("/v1/admin/add-pieces") && request.method === "POST") {
      const forced = await this.maybeForce(request);
      if (forced) return forced;
    }

    const headers = new Headers(request.headers);
    headers.set("x-org", parts[2]!);
    headers.set("x-worker-internal", "1");
    const init: RequestInit = {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    };
    return fetch(new URL(targetPath, this.engineUrl).toString(), init);
  }

  private async maybeForce(request: Request): Promise<Response | null> {
    const header = request.headers.get("x-scn-force-add-error");
    let kind: string | null = null;
    let consume = false;
    if (header === "lockup" || header === "InsufficientLockupFunds") {
      kind = "lockup";
    } else if (this.force) {
      const peek = (await request.clone().json().catch(() => ({}))) as { org?: string };
      if (!this.force.org || this.force.org === "*" || this.force.org === peek.org) {
        kind = this.force.kind ?? "lockup";
        consume = this.force.once !== false;
      }
    }
    if (!kind) return null;
    if (consume) this.force = null;
    return Response.json(
      {
        code: "AddPiecesFailed",
        message: `InsufficientLockupFunds: forced ${kind} (CI; no wallet used)`,
      },
      { status: 502 }
    );
  }
}

function namespace<T extends { fetch: (req: Request) => Promise<Response> }>(
  make: (name: string) => T
): DurableObjectNamespace {
  const stubs = new Map<string, T>();
  return {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    idFromString(id: string) {
      return { name: id } as unknown as DurableObjectId;
    },
    newUniqueId() {
      return { name: crypto.randomUUID() } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = (id as unknown as { name: string }).name;
      let stub = stubs.get(name);
      if (!stub) {
        stub = make(name);
        stubs.set(name, stub);
      }
      return stub as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = `${r.status} ${await r.text()}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`engine did not become ready at ${url}: ${last}`);
}

export async function startHarness(): Promise<Harness> {
  const adminToken = `ci-admin-${crypto.randomUUID()}`;
  const internalSecret = `ci-internal-${crypto.randomUUID()}`;
  const bin = findEngineBin();

  const top = new MemoryD1();
  const orgs = new MemoryD1();
  applySqlDir(top, join(WORKER_ROOT, "migrations/top"));
  applySqlDir(orgs, join(WORKER_ROOT, "migrations/orgs"));
  seedProtectedRepos(orgs, Date.now());

  const workerPort = await freePort();
  const enginePort = await freePort();
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  const engineUrl = `http://127.0.0.1:${enginePort}`;

  const env: Record<string, unknown> = {
    DB_SCIONHUB_TOP: top,
    ORGS_DB: orgs,
    ADMIN_TOKEN: adminToken,
    INTERNAL_SECRET: internalSecret,
    // Intentionally unset: PDP_* / SYNAPSE_* so mock storage and engine
    // add/remove-pieces never touch a write wallet.
  };

  const engine = new EngineStub(engineUrl);
  env.ENGINE = namespace(() => engine);

  const repoSql = new Map<string, DatabaseSync>();
  env.REPO = namespace((name) => {
    let sql = repoSql.get(name);
    if (!sql) {
      sql = new DatabaseSync(":memory:");
      repoSql.set(name, sql);
    }
    return new RepoDO(doState(sql) as unknown as DurableObjectState, env as never);
  });

  const d1gw = new D1Gateway(doState(new DatabaseSync(":memory:")) as unknown as DurableObjectState, env as never);
  env.D1GW = namespace(() => d1gw);

  const child: ChildProcess = spawn(bin, ["--listen", `127.0.0.1:${enginePort}`], {
    env: {
      ...process.env,
      OPENSCION_LISTEN: `127.0.0.1:${enginePort}`,
      WORKER_BASE_URL: workerUrl,
      INTERNAL_SECRET: internalSecret,
      ADMIN_TOKEN: adminToken,
      // Do not pass PDP_BASE_URL / PDP_PRIVATE_KEY: engine stays in mock mode.
      PDP_BASE_URL: "",
      PDP_PRIVATE_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let engineLog = "";
  child.stdout?.on("data", (c) => {
    engineLog += String(c);
  });
  child.stderr?.on("data", (c) => {
    engineLog += String(c);
  });
  child.on("exit", (code, signal) => {
    if (code && code !== 0) {
      console.error(`openscion-server exited ${code} ${signal ?? ""}\n${engineLog.slice(-2000)}`);
    }
  });

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", workerUrl);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) headers.set(k, v.join(", "));
        else headers.set(k, v);
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: body && req.method !== "GET" && req.method !== "HEAD" ? new Uint8Array(body) : undefined,
      });
      const response = await worker.fetch(request, env as never);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: (e as Error).message ?? "harness error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(workerPort, "127.0.0.1", () => resolve());
  });

  try {
    await waitHttp(`${engineUrl}/healthz`, 20_000);
  } catch (e) {
    server.close();
    child.kill("SIGTERM");
    throw e;
  }

  return {
    workerUrl,
    engineUrl,
    adminToken,
    internalSecret,
    promoteAdmin(username: string) {
      top.db.prepare("UPDATE users SET admin = 1 WHERE name = ?").run(username);
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
