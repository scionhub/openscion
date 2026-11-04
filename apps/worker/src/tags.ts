//! Repo tags. The row stores a changeset id. PieceCIDs are not part of a tag.

import { d1All, dbOrgs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { isRepoOwner } from "./owners";
import { emitEvent } from "./webhooks";
import { engineFetch } from "./pulls";

export const TAG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ID_RE = /^[0-9a-f]{64}$/;

export type TagRecord = {
  name: string;
  target: string;
  message: string | null;
  author: string | null;
  created_at: number;
  annotated: boolean;
};

type RepoNs = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(input: Request): Promise<Response> };
};

export type TagEnv = D1Env & {
  REPO?: RepoNs;
  INTERNAL_SECRET?: string;
  ENGINE?: DurableObjectNamespace;
  waitUntil?: (p: Promise<unknown>) => void;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Repo owners, site admins, and usernames listed in CODEOWNERS may delete a tag. */
export function tagDeleteAllowed(input: { admin: boolean; owner: boolean; username: string; codeowners: string }): boolean {
  if (input.admin || input.owner) return true;
  const name = input.username.trim().toLowerCase();
  if (!name) return false;
  for (const line of input.codeowners.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const owners = text.split(/\s+/).slice(1);
    if (owners.some((token) => token.replace(/^@/, "").toLowerCase() === name)) return true;
  }
  return false;
}

export function validateTagCreate(existing: { target: string } | null, body: unknown): { ok: true; name: string; target: string; message: string | null } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "JSON object body required" };
  const rec = body as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const target = typeof rec.target === "string" ? rec.target.trim() : "";
  if (!TAG_NAME_RE.test(name) || name.includes("..")) return { ok: false, status: 400, error: "invalid tag name" };
  if (!ID_RE.test(target)) return { ok: false, status: 400, error: "target must be a 64-hex changeset id" };
  if (existing) {
    return { ok: false, status: 409, error: existing.target === target ? "tag exists" : "tag exists with a different target" };
  }
  const message = typeof rec.message === "string" && rec.message.trim() ? rec.message : null;
  return { ok: true, name, target, message };
}

async function repoFetch(env: TagEnv, origin: URL, org: string, repo: string, sub: string, method: string, body?: string): Promise<Response> {
  if (!env.REPO) return json({ error: "repo storage unavailable" }, 503);
  const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
  const headers = new Headers();
  headers.set("x-internal-secret", env.INTERNAL_SECRET || "");
  if (body) headers.set("content-type", "application/json");
  return stub.fetch(new Request(new URL(`/__internal/do/${org}/${repo}/${sub}`, origin).toString(), { method, headers, body }));
}

async function codeownersText(env: TagEnv, origin: URL, org: string, repo: string): Promise<string> {
  if (!env.ENGINE) return "";
  for (const path of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    try {
      const resp = await engineFetch(env as Parameters<typeof engineFetch>[0], origin, `/v1/repos/${org}/${repo}/blob/main?path=${encodeURIComponent(path)}`, { method: "GET" });
      if (!resp.ok) continue;
      const body = (await resp.json()) as { contentBase64?: string; raw?: string };
      if (typeof body.raw === "string") return body.raw;
      if (typeof body.contentBase64 === "string" && body.contentBase64) {
        return new TextDecoder().decode(Uint8Array.from(atob(body.contentBase64), (c) => c.charCodeAt(0)));
      }
    } catch {
      /* try the next location */
    }
  }
  return "";
}

const TAGS = /^\/v1\/repos\/([^/]+)\/([^/]+)\/tags(?:\/([^/]+))?$/;

/** `GET/POST /tags` and `GET/DELETE /tags/{name}`. */
export async function handleTags(request: Request, env: TagEnv, path: string, origin: URL, actor: Actor | null): Promise<Response | null> {
  const match = path.match(TAGS);
  if (!match) return null;
  const method = request.method.toUpperCase();
  const org = decodeURIComponent(match[1]!);
  const repo = decodeURIComponent(match[2]!);
  const name = match[3] ? decodeURIComponent(match[3]!) : null;
  if (!name && method === "GET") {
    const resp = await repoFetch(env, origin, org, repo, "tags", "GET");
    if (!resp.ok) return resp;
    return json(await resp.json());
  }
  if (!name && method === "POST") {
    if (!actor) return json({ error: "unauthorized" }, 401);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const wanted = typeof (raw as { name?: unknown })?.name === "string" ? (raw as { name: string }).name : "";
    const current = await repoFetch(env, origin, org, repo, `tags/${encodeURIComponent(wanted)}`, "GET");
    const existing = current.ok ? ((await current.json()) as { target?: string }) : null;
    const parsed = validateTagCreate(existing?.target ? { target: String(existing.target) } : null, raw);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const created_at = Date.now();
    const record = {
      name: parsed.name,
      target: parsed.target,
      message: parsed.message,
      author: actor.name,
      created_at,
      annotated: parsed.message != null,
    };
    const wrote = await repoFetch(env, origin, org, repo, "tags", "POST", JSON.stringify(record));
    if (!wrote.ok) return wrote;
    env.waitUntil?.(emitEvent(env, org, repo, "tag", { action: "created", tag: record }));
    return json(record, 201);
  }
  if (name && method === "GET") {
    const resp = await repoFetch(env, origin, org, repo, `tags/${encodeURIComponent(name)}`, "GET");
    if (resp.status === 404) return json({ error: "not found" }, 404);
    return resp;
  }
  if (name && method === "DELETE") {
    if (!actor) return json({ error: "unauthorized" }, 401);
    const owner = actor.admin || (await isRepoOwner(env, org, repo, actor.userId));
    let codeowners = "";
    if (!owner) codeowners = await codeownersText(env, origin, org, repo);
    if (!tagDeleteAllowed({ admin: actor.admin, owner, username: actor.name, codeowners })) {
      return json({ error: "only owners or CODEOWNERS can delete a tag" }, 403);
    }
    const resp = await repoFetch(env, origin, org, repo, `tags/${encodeURIComponent(name)}`, "DELETE");
    if (!resp.ok) return resp;
    env.waitUntil?.(emitEvent(env, org, repo, "tag", { action: "deleted", tag: { name } }));
    return json({ ok: true, deleted: name });
  }
  return json({ error: "method not allowed" }, 405);
}

/** Used by tests that want a D1-free owner check helper path to stay imported. */
export async function ownerFlag(env: D1Env, org: string, repo: string, userId: string): Promise<boolean> {
  try {
    const rows = await d1All<{ ok: number }>(dbOrgs(env), "SELECT 1 as ok FROM repo_owners WHERE org = ? AND repo = ? AND user_id = ? LIMIT 1", [org, repo, userId]);
    return rows.length > 0;
  } catch {
    return false;
  }
}
