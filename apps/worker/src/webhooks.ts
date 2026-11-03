import { d1All, d1Run, dbOrgs, nowMs, type D1Env } from "./db";

type Env = D1Env & { waitUntil?: (p: Promise<unknown>) => void };

type HookRow = { id: string; org: string; repo: string; url: string; secret: string; events: string; created_at: number };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseEvents(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return [...new Set(raw.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean))];
  }
  return [];
}

export const DELIVERY_DDL = `CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  event TEXT NOT NULL,
  status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
)`;

/** Delays before each attempt. The first try is immediate. */
export const RETRY_BACKOFF_MS = [0, 400, 1600];

export async function ensureDeliverySchema(env: D1Env): Promise<void> {
  await d1Run(dbOrgs(env), DELIVERY_DDL);
}

export type DeliveryResult = { status: number; attempts: number; error: string | null };

/** POST `body`, retrying with `delays` (one entry per attempt). */
export async function postWithRetry(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  delays: number[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<DeliveryResult> {
  let last: DeliveryResult = { status: 0, attempts: 0, error: "no attempt" };
  const plan = delays.length ? delays : [0];
  for (let i = 0; i < plan.length; i++) {
    const wait = plan[i] ?? 0;
    if (wait > 0) await sleep(wait);
    try {
      const resp = await doFetch(url, init);
      last = { status: resp.status, attempts: i + 1, error: resp.ok ? null : `status ${resp.status}` };
      if (resp.ok) return last;
    } catch (error) {
      last = { status: 0, attempts: i + 1, error: (error as Error).message || "fetch failed" };
    }
  }
  return last;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Best-effort async delivery of one event to all matching hooks. */
export async function emitEvent(env: Env, org: string, repo: string, event: string, payload: unknown): Promise<void> {
  const db = dbOrgs(env);
  let hooks: HookRow[] = [];
  try {
    hooks = await d1All<HookRow>(db, "SELECT id, org, repo, url, secret, events, created_at FROM webhooks WHERE org = ? AND repo = ?", [org, repo]);
  } catch {
    return;
  }
  if (!hooks.length) return;
  try {
    await ensureDeliverySchema(env);
  } catch {
    /* delivery log is best-effort */
  }
  const body = JSON.stringify({ repo: { org, name: repo }, event, ...((payload && typeof payload === "object") ? (payload as object) : { payload }) });
  for (const h of hooks) {
    let types: string[] = [];
    try {
      types = JSON.parse(h.events) as string[];
      if (!Array.isArray(types)) types = [];
    } catch {
      types = [];
    }
    if (types.length && !types.includes(event)) continue;
    const deliver = (async () => {
      const sig = await hmacSha256Hex(h.secret, body);
      const result = await postWithRetry(fetch, h.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Scionbase-Event": event,
          "X-Scionbase-Signature-256": `sha256=${sig}`,
        },
        body,
      }, RETRY_BACKOFF_MS);
      try {
        await d1Run(
          db,
          `INSERT INTO webhook_deliveries (id, hook_id, org, repo, event, status, attempts, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), h.id, org, repo, event, result.status || null, result.attempts, result.error, nowMs()]
        );
      } catch {
        /* ignore */
      }
    })();
    env.waitUntil?.(deliver);
  }
}

const HOOKS = /^\/v1\/repos\/([^/]+)\/([^/]+)\/(?:hooks|webhooks)(?:\/([^/]+))?$/;

type HookJson = { id: string; url: string; events: string[]; created_at: number };

function hookJson(row: Pick<HookRow, "id" | "url" | "events" | "created_at">): HookJson {
  let events: string[] = [];
  try {
    const v = JSON.parse(row.events) as string[];
    events = Array.isArray(v) ? v : [];
  } catch {
    events = [];
  }
  return { id: row.id, url: row.url, events, created_at: row.created_at };
}

/** List payload: site reads `data.webhooks || data.hooks`. */
export function hookListJson(items: HookJson[]): { hooks: HookJson[]; webhooks: HookJson[] } {
  return { hooks: items, webhooks: items };
}

/** CRUD for per-repo webhooks: GET/POST on /hooks or /webhooks, GET/PATCH/DELETE on /{id}. */
const DELIVERIES = /^\/v1\/repos\/([^/]+)\/([^/]+)\/(?:hooks|webhooks)\/([^/]+)\/deliveries$/;

export async function handleWebhooks(request: Request, env: Env, path: string): Promise<Response | null> {
  const deliveries = path.match(DELIVERIES);
  if (deliveries && request.method.toUpperCase() === "GET") {
    const org = decodeURIComponent(deliveries[1]!);
    const repo = decodeURIComponent(deliveries[2]!);
    const id = decodeURIComponent(deliveries[3]!);
    try {
      await ensureDeliverySchema(env);
      const rows = await d1All<{ id: string; event: string; status: number | null; attempts: number; error: string | null; created_at: number }>(
        dbOrgs(env),
        `SELECT id, event, status, attempts, error, created_at FROM webhook_deliveries
          WHERE hook_id = ? AND org = ? AND repo = ? ORDER BY created_at DESC LIMIT 50`,
        [id, org, repo]
      );
      return json({ deliveries: rows });
    } catch {
      return json({ deliveries: [] });
    }
  }
  const m = path.match(HOOKS);
  if (!m) return null;
  const method = request.method.toUpperCase();
  const org = decodeURIComponent(m[1]!);
  const repo = decodeURIComponent(m[2]!);
  const id = m[3] ? decodeURIComponent(m[3]!) : null;
  const db = dbOrgs(env);
  if (!id) {
    if (method === "GET") {
      const rows = await d1All<HookRow>(db, "SELECT id, url, events, created_at FROM webhooks WHERE org = ? AND repo = ? ORDER BY created_at DESC", [org, repo]).catch(() => []);
      return json(hookListJson(rows.map(hookJson)));
    }
    if (method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const url = typeof body.url === "string" && /^https?:\/\//.test(body.url) ? body.url.trim() : "";
      const secret = typeof body.secret === "string" && body.secret.trim().length >= 8 ? body.secret : "";
      const events = parseEvents(body.events);
      if (!url || !secret) return json({ error: "url and secret are required" }, 400);
      const id = crypto.randomUUID();
      await d1Run(db, "INSERT INTO webhooks (id, org, repo, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        id,
        org,
        repo,
        url,
        secret,
        JSON.stringify(events),
        nowMs(),
      ]);
      return json({ id, url, events, created_at: nowMs() }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }
  // /hooks/{id}
  if (method === "GET") {
    const rows = await d1All<HookRow>(db, "SELECT id, url, events, created_at FROM webhooks WHERE id = ? AND org = ? AND repo = ? LIMIT 1", [id, org, repo]).catch(() => []);
    const row = rows[0];
    if (!row) return json({ error: "not found" }, 404);
    return json(hookJson(row));
  }
  if (method === "PATCH") {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const url = typeof body.url === "string" && /^https?:\/\//.test(body.url) ? body.url.trim() : undefined;
    const events = body.events === undefined ? undefined : JSON.stringify(parseEvents(body.events));
    const secret = typeof body.secret === "string" && body.secret.trim().length >= 8 ? body.secret : undefined;
    const rows = await d1All<HookRow>(db, "SELECT * FROM webhooks WHERE id = ? AND org = ? AND repo = ? LIMIT 1", [id, org, repo]).catch(() => []);
    const row = rows[0];
    if (!row) return json({ error: "not found" }, 404);
    await d1Run(
      db,
      "UPDATE webhooks SET url = COALESCE(?, url), events = COALESCE(?, events), secret = COALESCE(?, secret) WHERE id = ?",
      [url ?? null, events ?? null, secret ?? null, id]
    );
    const updated = (await d1All<HookRow>(db, "SELECT id, url, events, created_at FROM webhooks WHERE id = ? LIMIT 1", [id]))[0]!;
    return json(hookJson(updated));
  }
  if (method === "DELETE") {
    await d1Run(db, "DELETE FROM webhooks WHERE id = ? AND org = ? AND repo = ?", [id, org, repo]);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}

