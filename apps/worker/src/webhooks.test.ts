//! /hooks and /webhooks are the same collection; list JSON includes both keys.

import { DELIVERY_DDL, handleWebhooks, hookListJson, postWithRetry } from "./webhooks";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

const listed = hookListJson([{ id: "h1", url: "https://ex.example/hook", events: ["issue"], created_at: 1 }]);
ok(listed.hooks.length === 1 && listed.webhooks.length === 1, "both keys present");
ok(listed.hooks[0] === listed.webhooks[0], "hooks and webhooks share the same items");

const env = {
  DB_SCIONHUB_TOP: {
    prepare() {
      throw new Error("no webhooks table");
    },
  },
} as unknown as { DB_SCIONHUB_TOP: D1Database };

const get = async (path: string, method = "GET"): Promise<Response | null> =>
  handleWebhooks(new Request(`https://x${path}`, { method }), env, path);

const hooks = await get("/v1/repos/acme/web/hooks");
ok(hooks?.status === 200, "/hooks GET is 200");
const hooksBody = (await hooks!.json()) as { hooks?: unknown[]; webhooks?: unknown[] };
ok(Array.isArray(hooksBody.hooks) && Array.isArray(hooksBody.webhooks), "/hooks list has both keys");

const webhooks = await get("/v1/repos/acme/web/webhooks");
ok(webhooks?.status === 200, "/webhooks GET is 200");
const webhooksBody = (await webhooks!.json()) as { hooks?: unknown[]; webhooks?: unknown[] };
ok(Array.isArray(webhooksBody.hooks) && Array.isArray(webhooksBody.webhooks), "/webhooks list has both keys");

const one = await get("/v1/repos/acme/web/webhooks/abc");
ok(one?.status === 404, "/webhooks/{id} is the same handler");

const miss = await get("/v1/repos/acme/web/other");
ok(miss === null, "unrelated path is not claimed");

ok(!DELIVERY_DDL.toLowerCase().includes("piece"), "delivery log does not store piece cids");
const calls: string[] = [];
const result = await postWithRetry(
  (async (url: string) => {
    calls.push(url);
    if (calls.length < 3) return new Response("no", { status: 500 });
    return new Response(null, { status: 204 });
  }) as typeof fetch,
  "https://example.test/hook",
  { method: "POST", body: "{}" },
  [0, 0, 0],
  async () => {}
);
ok(result.status === 204 && result.attempts === 3 && result.error === null, "retries until success");
const failed = await postWithRetry(
  (async () => new Response("no", { status: 502 })) as typeof fetch,
  "https://example.test/hook",
  { method: "POST" },
  [0, 0],
  async () => {}
);
ok(failed.attempts === 2 && failed.status === 502 && failed.error !== null, "records the last failure");

console.log("webhooks ok");
