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
      try {
        await fetch(h.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Scionbase-Event": event,
            "X-Scionbase-Signature-256": `sha256=${sig}`,
          },
          body,
        }).catch(() => undefined);
      } catch {
        /* ignore */
      }
    })();
    env.waitUntil?.(deliver);
  }
}

const HOOKS = /^\/v1\/repos\/([^/]+)\/([^/]+)\/hooks(?:\/([^/]+))?$/;

/** CRUD for per-repo webhooks: GET/POST on /hooks, GET/PATCH/DELETE on /hooks/{id}. */
export async function handleWebhooks(request: Request, env: Env, path: string): Promise<Response | null> {
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
      return json({
        hooks: rows.map((r) => ({
          id: r.id,
          url: r.url,
          events: (() => {
            try {
              const v = JSON.parse(r.events) as string[];
              return Array.isArray(v) ? v : [];
            } catch {
              return [];
            }
          })(),
          created_at: r.created_at,
        })),
      });
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
    return json({
      id: row.id,
      url: row.url,
      events: (() => {
        try {
          const v = JSON.parse(row.events) as string[];
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      })(),
      created_at: row.created_at,
    });
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
    return json({
      id: updated.id,
      url: updated.url,
      events: (() => {
        try {
          const v = JSON.parse(updated.events) as string[];
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      })(),
      created_at: updated.created_at,
    });
  }
  if (method === "DELETE") {
    await d1Run(db, "DELETE FROM webhooks WHERE id = ? AND org = ? AND repo = ?", [id, org, repo]);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}

