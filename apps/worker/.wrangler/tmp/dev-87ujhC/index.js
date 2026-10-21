var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-TZocOQ/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/db.ts
async function d1All(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params.map((p) => p === void 0 ? null : p)) : stmt;
  const res = await bound.all();
  if (!res.success) {
    throw new Error(res.error || "D1 query failed");
  }
  return res.results ?? [];
}
__name(d1All, "d1All");
async function d1Run(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params.map((p) => p === void 0 ? null : p)) : stmt;
  const res = await bound.run();
  if (!res.success) {
    throw new Error(res.error || "D1 exec failed");
  }
}
__name(d1Run, "d1Run");
function nowMs() {
  return Date.now();
}
__name(nowMs, "nowMs");
function uuid() {
  const hasCrypto = typeof globalThis !== "undefined" && typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function";
  const rnd = hasCrypto ? globalThis.crypto.getRandomValues(new Uint8Array(16)) : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  rnd[6] = rnd[6] & 15 | 64;
  rnd[8] = rnd[8] & 63 | 128;
  const hex = Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
__name(uuid, "uuid");

// src/pdp.ts
var PDPClient = class {
  options;
  constructor(options) {
    this.options = options;
  }
  async computeCommP(input) {
    if (this.options.baseUrl) {
    }
    const material = input.bytesBase64 ?? input.contentUrl ?? String(input.sizeBytes ?? Math.floor(Math.random() * 1e9));
    const pieceCid = await fakePieceCid(material);
    return { pieceCid };
  }
  async storePiece(input) {
    if (this.options.baseUrl) {
    }
    return {
      dealId: void 0,
      providerId: input.providerId ?? this.options.defaultProviderId,
      state: "queued"
    };
  }
};
__name(PDPClient, "PDPClient");
async function fakePieceCid(seed) {
  const data = new TextEncoder().encode(seed);
  if (!(typeof globalThis !== "undefined" && typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === "function")) {
    throw new Error("SubtleCrypto not available to compute placeholder CID");
  }
  const cryptoAny = globalThis.crypto;
  const digest = await cryptoAny.subtle.digest(
    "SHA-256",
    data
  );
  const b32 = toBase32(new Uint8Array(digest)).toLowerCase();
  return `baga${b32.slice(4, 59)}`;
}
__name(fakePieceCid, "fakePieceCid");
function toBase32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet.charAt(value >>> bits - 5 & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet.charAt(value << 5 - bits & 31);
  }
  return output;
}
__name(toBase32, "toBase32");

// src/index.ts
function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}
__name(json, "json");
function unauthorized() {
  return json({ error: "unauthorized" }, { status: 401 });
}
__name(unauthorized, "unauthorized");
function notFound(msg = "not found") {
  return json({ error: msg }, { status: 404 });
}
__name(notFound, "notFound");
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("invalid JSON");
  }
}
__name(readJson, "readJson");
function requireAdmin(request, env) {
  const want = env.ADMIN_TOKEN;
  if (!want)
    return false;
  const got = request.headers.get("authorization") || "";
  const m = got.match(/Bearer (.+)/i);
  if (!!m && m[1] === want)
    return true;
  const alt = request.headers.get("x-admin-token");
  if (alt && alt === want)
    return true;
  const q = new URL(request.url).searchParams.get("admin");
  if (q && q === want)
    return true;
  return false;
}
__name(requireAdmin, "requireAdmin");
function pdpClient(env) {
  return new PDPClient({
    baseUrl: env.PDP_BASE_URL,
    apiKey: env.SYNAPSE_API_KEY,
    defaultProviderId: env.DEFAULT_PROVIDER_ID
  });
}
__name(pdpClient, "pdpClient");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && (path === "/" || path === "/healthz")) {
        return json({
          name: "OpenScion Filecoin PDP POC",
          version: "0.1.0",
          orgs: ["filecoin-project"],
          pricing: {
            free_tier: "6 months or 1 GB, whichever comes first",
            paid: "$5/GB/month after",
            note: "POC only \u2014 no real billing; contact FilOz to discuss production"
          },
          links: {
            org: "/orgs/filecoin-project"
          }
        });
      }
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
      if (request.method === "GET" && path === "/orgs/filecoin-project/providers") {
        const rows = await d1All(
          env.DB_FILECOIN_PROJECT,
          "SELECT id, name, endpoint_url, region, status, created_at FROM providers ORDER BY created_at DESC"
        );
        return json({ providers: rows });
      }
      if (request.method === "POST" && path === "/orgs/filecoin-project/providers") {
        if (!requireAdmin(request, env))
          return unauthorized();
        const b = await readJson(request);
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
      if (request.method === "GET" && path === "/orgs/filecoin-project/datasets") {
        const rows = await d1All(
          env.DB_FILECOIN_PROJECT,
          "SELECT id, name, description, created_at FROM datasets ORDER BY created_at DESC"
        );
        return json({ datasets: rows });
      }
      if (request.method === "POST" && path === "/orgs/filecoin-project/datasets") {
        if (!requireAdmin(request, env))
          return unauthorized();
        const b = await readJson(request);
        if (!b.name)
          return json({ error: "name is required" }, { status: 400 });
        const id = uuid();
        await d1Run(
          env.DB_FILECOIN_PROJECT,
          `INSERT INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
          [id, b.name, b.description ?? null, nowMs()]
        );
        return json({ ok: true, id });
      }
      if (request.method === "POST" && path === "/orgs/filecoin-project/uploads") {
        const b = await readJson(request);
        if (!b.datasetId) {
          return json({ error: "datasetId is required" }, { status: 400 });
        }
        const ds = await d1All(
          env.DB_FILECOIN_PROJECT,
          "SELECT id FROM datasets WHERE id = ?",
          [b.datasetId]
        );
        if (ds.length === 0)
          return notFound("unknown dataset");
        const client = pdpClient(env);
        const pieceCid = b.pieceCid ?? (await client.computeCommP({
          bytesBase64: b.bytesBase64,
          contentUrl: b.contentUrl,
          sizeBytes: b.sizeBytes
        })).pieceCid;
        const existing = await d1All(
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
          note: "POC storage initiation \u2014 real PDP/Synapse integration required for production"
        });
      }
      const pieceMatch = path.match(/^\/orgs\/filecoin-project\/pieces\/([^/]+)$/);
      if (request.method === "GET" && pieceMatch) {
        const captured = pieceMatch[1];
        if (!captured)
          return notFound("unknown piece");
        const pieceCid = decodeURIComponent(captured);
        const rows = await d1All(
          env.DB_FILECOIN_PROJECT,
          `SELECT piece_cid, dataset_id, size_bytes, provider_id, status, created_at
           FROM pieces WHERE piece_cid = ?`,
          [pieceCid]
        );
        if (rows.length === 0)
          return notFound("unknown piece");
        return json(rows[0]);
      }
      if (request.method === "GET" && path === "/pricing") {
        return json({
          free_tier: "6 months or 1 GB, whichever comes first",
          paid: "$5/GB/month after",
          currency: ["USD", "ETH"],
          disclaimer: "This is a proof-of-concept. No real billing is performed. Contact FilOz to discuss production."
        });
      }
      return json({ error: "route not found" }, { status: 404 });
    } catch (err) {
      return json(
        { error: err.message ?? "internal error" },
        { status: 500 }
      );
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-TZocOQ/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-TZocOQ/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
