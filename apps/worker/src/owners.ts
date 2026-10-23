import { d1All, d1Run, dbOrgs, dbTop, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { forbidden, orgCanWrite } from "./authz";

/** Andy, seeded as owner of the platform Filecoin repos. */
export const ANDY_USER_ID = "0ae8965c-8dad-4b1b-a2ea-87d106161ee0";
export const ANDY_USER_NAME = "andy";

/** Repos that non-admins cannot delete even with a matching confirm body. */
export const PROTECTED_REPOS = ["filecoin-project/curio", "filecoin-project/lotus"] as const;

type Env = D1Env & {
  ENGINE: DurableObjectNamespace;
  REPO?: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export type OwnerRow = {
  org: string;
  repo: string;
  user_id: string;
  user_name: string;
  added_by: string;
  created_at: number;
};

export type RepoViewer = {
  owner: boolean;
  canMerge: boolean;
};

export function isProtectedRepo(org: string, repo: string): boolean {
  return (PROTECTED_REPOS as readonly string[]).includes(`${org}/${repo}`);
}

/** Owners and site admins may add/remove owners and delete the repo. */
export function ownerMutateDenied(actor: Actor | null, isOwner: boolean): 401 | 403 | null {
  if (!actor) return 401;
  if (actor.admin || isOwner) return null;
  return 403;
}

/** Non-admins cannot delete the platform Filecoin repos. */
export function protectedDeleteDenied(org: string, repo: string, actor: Actor): 403 | null {
  if (!isProtectedRepo(org, repo)) return null;
  if (actor.admin) return null;
  return 403;
}

export function validateAddOwner(
  raw: unknown
): { ok: true; username: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid JSON" };
  }
  const username = (raw as { username?: unknown }).username;
  if (typeof username !== "string") return { ok: false, error: "username is required" };
  const trimmed = username.trim();
  if (!trimmed) return { ok: false, error: "username is required" };
  return { ok: true, username: trimmed };
}

export function validateDeleteConfirm(
  raw: unknown,
  org: string,
  repo: string
): { ok: true } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid JSON" };
  }
  const confirm = (raw as { confirm?: unknown }).confirm;
  if (typeof confirm !== "string") {
    return { ok: false, error: "confirm is required" };
  }
  const want = `${org}/${repo}`;
  if (confirm !== want) {
    return { ok: false, error: "confirm must match org/repo exactly" };
  }
  return { ok: true };
}

/** True when this DELETE would leave the repo with zero owners. */
export function isLastOwner(ownerCount: number, targetIsOwner: boolean): boolean {
  return targetIsOwner && ownerCount <= 1;
}

export function ownerJson(row: OwnerRow): { user: string; created_at: number; added_by: string } {
  return { user: row.user_name, created_at: row.created_at, added_by: row.added_by };
}

export async function isRepoOwner(
  env: D1Env,
  org: string,
  repo: string,
  userId: string
): Promise<boolean> {
  const rows = await d1All<{ ok: number }>(
    dbOrgs(env),
    `SELECT 1 as ok FROM repo_owners WHERE org = ? AND repo = ? AND user_id = ? LIMIT 1`,
    [org, repo, userId]
  );
  return rows.length > 0;
}

export async function listRepoOwners(env: D1Env, org: string, repo: string): Promise<OwnerRow[]> {
  return d1All<OwnerRow>(
    dbOrgs(env),
    `SELECT org, repo, user_id, user_name, added_by, created_at
       FROM repo_owners WHERE org = ? AND repo = ? ORDER BY created_at ASC, user_name ASC`,
    [org, repo]
  );
}

export async function ownerUserIds(env: D1Env, org: string, repo: string): Promise<Set<string>> {
  const rows = await listRepoOwners(env, org, repo);
  return new Set(rows.map((r) => r.user_id));
}

export async function insertRepoOwner(
  db: D1Database,
  org: string,
  repo: string,
  userId: string,
  userName: string,
  addedBy: string,
  createdAt: number
): Promise<void> {
  await d1Run(
    db,
    `INSERT OR IGNORE INTO repo_owners (org, repo, user_id, user_name, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [org, repo, userId, userName, addedBy, createdAt]
  );
}

export async function repoViewer(
  env: D1Env,
  org: string,
  repo: string,
  actor: Actor
): Promise<RepoViewer> {
  const owner = await isRepoOwner(env, org, repo, actor.userId);
  const canMerge = actor.admin || owner || (await orgCanWrite(env, org, actor));
  return { owner, canMerge };
}

async function repoExists(env: D1Env, org: string, repo: string): Promise<boolean> {
  const rows = await d1All<{ id: string }>(
    dbOrgs(env),
    "SELECT id FROM repos WHERE id = ? LIMIT 1",
    [`${org}/${repo}`]
  );
  return rows.length > 0;
}

async function lookupUserByName(
  env: D1Env,
  username: string
): Promise<{ id: string; name: string } | null> {
  const rows = await d1All<{ id: string; name: string }>(
    dbTop(env),
    "SELECT id, name FROM users WHERE name = ? LIMIT 1",
    [username]
  );
  return rows[0] ?? null;
}

const OWNERS_LIST = /^\/v1\/repos\/([^/]+)\/([^/]+)\/owners$/;
const OWNERS_ONE = /^\/v1\/repos\/([^/]+)\/([^/]+)\/owners\/([^/]+)$/;
const REPO_ONE = /^\/v1\/repos\/([^/]+)\/([^/]+)$/;

/** Handle `/v1/repos/{org}/{repo}/owners...`. Returns null if not an owners route. */
export async function handleRepoOwners(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const db = dbOrgs(env);

  const one = path.match(OWNERS_ONE);
  if (one) {
    const org = decodeURIComponent(one[1]!);
    const repo = decodeURIComponent(one[2]!);
    const username = decodeURIComponent(one[3]!);
    if (method !== "DELETE") return json({ error: "method not allowed" }, 405);
    if (!actor) return json({ error: "unauthorized" }, 401);
    if (!(await repoExists(env, org, repo))) return json({ error: "not found" }, 404);
    const isOwner = await isRepoOwner(env, org, repo, actor.userId);
    const denied = ownerMutateDenied(actor, isOwner);
    if (denied === 403) return forbidden();
    const user = await lookupUserByName(env, username);
    if (!user) return json({ error: "unknown user" }, 404);
    const owners = await listRepoOwners(env, org, repo);
    const target = owners.find((o) => o.user_id === user.id);
    if (!target) return json({ error: "not found" }, 404);
    if (isLastOwner(owners.length, true)) {
      return json({ error: "cannot remove the last owner" }, 409);
    }
    await d1Run(
      db,
      "DELETE FROM repo_owners WHERE org = ? AND repo = ? AND user_id = ?",
      [org, repo, user.id]
    );
    return json({ ok: true });
  }

  const list = path.match(OWNERS_LIST);
  if (list) {
    const org = decodeURIComponent(list[1]!);
    const repo = decodeURIComponent(list[2]!);
    if (!(await repoExists(env, org, repo))) return json({ error: "not found" }, 404);
    if (method === "GET") {
      const rows = await listRepoOwners(env, org, repo);
      return json({ owners: rows.map(ownerJson) });
    }
    if (method === "POST") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      const isOwner = await isRepoOwner(env, org, repo, actor.userId);
      const denied = ownerMutateDenied(actor, isOwner);
      if (denied === 403) return forbidden();
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const parsed = validateAddOwner(raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const user = await lookupUserByName(env, parsed.username);
      if (!user) return json({ error: "unknown user" }, 404);
      const already = await isRepoOwner(env, org, repo, user.id);
      const created = nowMs();
      await insertRepoOwner(db, org, repo, user.id, user.name, actor.name, created);
      const rows = await d1All<OwnerRow>(
        db,
        `SELECT org, repo, user_id, user_name, added_by, created_at
           FROM repo_owners WHERE org = ? AND repo = ? AND user_id = ? LIMIT 1`,
        [org, repo, user.id]
      );
      const row = rows[0];
      if (!row) return json({ error: "owner add failed" }, 500);
      return json(ownerJson(row), already ? 200 : 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}

const FILECOIN_NOTE = "Filecoin pieces are append-only and remain";

type EngineFetch = (
  env: { ENGINE: DurableObjectNamespace },
  origin: URL,
  enginePath: string,
  init: RequestInit
) => Promise<Response>;

/** Handle `DELETE /v1/repos/{org}/{repo}` with `{confirm:"org/repo"}`. */
export async function handleRepoDelete(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null,
  origin: URL,
  engineFetch: EngineFetch
): Promise<Response | null> {
  if (request.method.toUpperCase() !== "DELETE") return null;
  const m = path.match(REPO_ONE);
  if (!m) return null;
  const org = decodeURIComponent(m[1]!);
  const repo = decodeURIComponent(m[2]!);
  if (!actor) return json({ error: "unauthorized" }, 401);
  if (!(await repoExists(env, org, repo))) return json({ error: "not found" }, 404);

  const isOwner = await isRepoOwner(env, org, repo, actor.userId);
  const denied = ownerMutateDenied(actor, isOwner);
  if (denied === 403) return forbidden();
  if (protectedDeleteDenied(org, repo, actor) === 403) return forbidden();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = validateDeleteConfirm(raw, org, repo);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  await wipeRepoStorage(env, origin, org, repo, engineFetch);
  await deleteRepoRows(env, org, repo);
  return json({
    ok: true,
    deleted: `${org}/${repo}`,
    note: FILECOIN_NOTE,
  });
}

export async function deleteRepoRows(env: D1Env, org: string, repo: string): Promise<void> {
  const db = dbOrgs(env);
  await d1Run(db, "DELETE FROM pr_comments WHERE org = ? AND repo = ?", [org, repo]);
  await d1Run(db, "DELETE FROM pr_approvals WHERE org = ? AND repo = ?", [org, repo]);
  await d1Run(db, "DELETE FROM pulls WHERE org = ? AND repo = ?", [org, repo]);
  await d1Run(db, "DELETE FROM repo_owners WHERE org = ? AND repo = ?", [org, repo]);
  await d1Run(db, "DELETE FROM repos WHERE id = ?", [`${org}/${repo}`]);
}

async function wipeRepoStorage(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  engineFetch: EngineFetch
): Promise<void> {
  const names = await listRepoRefNames(env, origin, org, repo);
  if (env.REPO) {
    const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
    const h = new Headers();
    h.set("x-internal-secret", env.INTERNAL_SECRET || "");
    await stub.fetch(
      new Request(new URL(`/__internal/do/${org}/${repo}/reset`, origin).toString(), {
        method: "POST",
        headers: h,
      })
    );
  }
  for (const name of names) {
    await engineFetch(env, origin, `/v1/repos/${org}/${repo}/refs/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }
}

async function listRepoRefNames(env: Env, origin: URL, org: string, repo: string): Promise<string[]> {
  if (!env.REPO) return [];
  const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/refs`, origin).toString(), {
      method: "GET",
      headers: h,
    })
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { refs?: { name: string }[] };
  return (j.refs ?? []).map((x) => x.name).filter((n) => typeof n === "string" && n.length > 0);
}
