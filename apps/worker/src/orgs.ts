import { d1All, d1Run, dbOrgs, dbTop, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { loadUserProfile, meUserJson } from "./users";

/** Same rule as usernames: `^[a-z0-9][a-z0-9-]{2,31}$`. */
export const ORG_NAME_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const MAX_ORGS_NON_ADMIN = 3;

/** Formal orgs that always appear in the anonymous public directory. */
export const PUBLIC_DIRECTORY_ORGS = ["filecoin-project"] as const;

/**
 * Caller org ids: username namespace first (the intentional "first org"),
 * then other memberships. Mirrors `/v1/me.orgs`.
 */
export function callerOrgIds(username: string, memberships: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [username, ...memberships]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Anonymous directory: formal orgs only. Username namespaces are omitted
 * even when `ensureUserOrg` materialized them in the orgs table.
 * `filecoin-project` is always included.
 */
export function publicOrgIds(formalOrgIds: string[], usernames: Iterable<string> = []): string[] {
  const users = new Set(usernames);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...PUBLIC_DIRECTORY_ORGS, ...formalOrgIds]) {
    if (!id || seen.has(id) || users.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.sort();
}

const RESERVED_ORG_NAMES = new Set([
  "filecoin-project",
  "admin",
  "api",
  "www",
  "root",
  "support",
  "help",
  "status",
  "mail",
  "ftp",
  "localhost",
  "docs",
  "blog",
  "static",
  "assets",
  "login",
  "signup",
  "org",
  "orgs",
  "repo",
  "repos",
  "settings",
  "account",
  "me",
  "health",
  "healthz",
  "v1",
  "scn",
  "scion",
  "scionbase",
  "openscion",
  "opnscn",
  "filecoin",
  "null",
  "undefined",
  "about",
  "pricing",
  "new",
  "cli",
  "getting-started",
  "auth",
  "anonymous",
  "system",
  "internal",
]);

type Env = D1Env;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function isReservedOrgName(name: string): boolean {
  return RESERVED_ORG_NAMES.has(name);
}

/**
 * `GET /v1/me` (Bearer):
 * `{ user: { id, name, admin, tagline, paid }, orgs: [{ id, role }], ownedRepos: [{ org, name }] }`
 *
 * `orgs` is memberships plus the caller's own username namespace (role
 * `admin`) when it is not already listed. The web app also treats
 * `user.name` as a namespace even if this array is empty. `ownedRepos`
 * is the caller's `repo_owners` rows.
 */
export async function handleMe(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  if (request.method.toUpperCase() !== "GET" || path !== "/v1/me") {
    return null;
  }
  if (!actor) return json({ error: "unauthorized" }, 401);
  const db = dbTop(env);
  const rows = await d1All<{ org_id: string; role: string }>(
    db,
    "SELECT org_id, role FROM memberships WHERE user_id = ? ORDER BY org_id",
    [actor.userId]
  );
  const roleById = new Map(rows.map((r) => [r.org_id, r.role]));
  const orgs: { id: string; role: string }[] = callerOrgIds(
    actor.name,
    rows.map((r) => r.org_id)
  ).map((id) => ({
    id,
    role: roleById.get(id) ?? "admin",
  }));
  let ownedRepos: { org: string; name: string }[] = [];
  try {
    const owned = await d1All<{ org: string; repo: string }>(
      dbOrgs(env),
      "SELECT org, repo FROM repo_owners WHERE user_id = ? ORDER BY org, repo",
      [actor.userId]
    );
    ownedRepos = owned.map((r) => ({ org: r.org, name: r.repo }));
  } catch {
    ownedRepos = [];
  }
  const profile = await loadUserProfile(db, actor.userId);
  return json({
    user: meUserJson(actor, profile),
    orgs,
    ownedRepos,
  });
}

const GET_LIST = /^\/v1\/orgs$/;
const POST_CREATE = /^\/v1\/orgs$/;

/**
 * `GET /v1/orgs`: authenticated callers get memberships plus their username
 * namespace (same ids as `/v1/me.orgs`). Anonymous callers get the public
 * formal-org directory (`filecoin-project` and other non-username orgs).
 */
export async function handleOrgList(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  if (request.method.toUpperCase() !== "GET" || !GET_LIST.test(path)) {
    return null;
  }
  const db = dbTop(env);
  if (actor) {
    const rows = await d1All<{ org_id: string }>(
      db,
      "SELECT org_id FROM memberships WHERE user_id = ? ORDER BY org_id",
      [actor.userId]
    );
    return json(callerOrgIds(actor.name, rows.map((r) => r.org_id)));
  }
  const orgs = await d1All<{ id: string }>(db, "SELECT id FROM orgs ORDER BY id", []);
  let usernames: string[] = [];
  try {
    const users = await d1All<{ name: string }>(db, "SELECT name FROM users", []);
    usernames = users.map((u) => u.name);
  } catch {
    usernames = [];
  }
  return json(publicOrgIds(orgs.map((r) => r.id), usernames));
}

/** Handle `POST /v1/orgs`. Returns null if this is not the create route. */
export async function handleOrgCreate(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  if (request.method.toUpperCase() !== "POST" || !POST_CREATE.test(path)) {
    return null;
  }
  if (!actor) return json({ error: "unauthorized" }, 401);

  let body: { name?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const name = (body.name ?? "").trim();
  if (!ORG_NAME_RE.test(name)) {
    return json({ error: "name must match ^[a-z0-9][a-z0-9-]{2,31}$" }, 400);
  }
  if (isReservedOrgName(name)) {
    return json({ error: "name is reserved" }, 400);
  }

  const db = dbTop(env);
  const existingOrg = await d1All<{ id: string }>(
    db,
    "SELECT id FROM orgs WHERE id = ? LIMIT 1",
    [name]
  );
  if (existingOrg.length > 0) {
    return json({ error: "org exists" }, 409);
  }
  const existingUser = await d1All<{ id: string }>(
    db,
    "SELECT id FROM users WHERE name = ? LIMIT 1",
    [name]
  );
  if (existingUser.length > 0) {
    return json({ error: "name is a user" }, 409);
  }

  if (!actor.admin) {
    let created = 0;
    try {
      const rows = await d1All<{ n: number }>(
        db,
        "SELECT COUNT(*) as n FROM orgs WHERE created_by = ?",
        [actor.userId]
      );
      created = rows[0]?.n ?? 0;
    } catch {
      created = 0;
    }
    if (created >= MAX_ORGS_NON_ADMIN) {
      return json({ error: "org limit reached" }, 403);
    }
  }

  const t = nowMs();
  try {
    await d1Run(db, "INSERT INTO orgs (id, created_at, created_by) VALUES (?, ?, ?)", [
      name,
      t,
      actor.userId,
    ]);
  } catch {
    await d1Run(db, "INSERT INTO orgs (id, created_at) VALUES (?, ?)", [name, t]);
  }
  await d1Run(
    db,
    `INSERT OR IGNORE INTO memberships (org_id, user_id, role, can_write, created_at)
     VALUES (?, ?, 'admin', 1, ?)`,
    [name, actor.userId, t]
  );

  return json(
    {
      id: name,
      name,
      created_by: actor.userId,
      role: "admin",
    },
    201
  );
}
