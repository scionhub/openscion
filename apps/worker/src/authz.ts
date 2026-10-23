import { d1All, d1Run, dbOrgs, dbTop, nowMs, type D1Env } from "./db";

type Env = D1Env & { ADMIN_TOKEN?: string };

const NON_MEMBER_UPLOAD_MAX = 10 * 1024 * 1024;
const SIGNUP_PER_IP_PER_HOUR = 5;
const SIGNUP_MAX_USERS = 200;
const HOUR_MS = 60 * 60 * 1000;

export type Actor = {
  userId: string;
  name: string;
  admin: boolean;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

export function forbidden(): Response {
  return json({ error: "forbidden" }, 403);
}

async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isReadOnlyPost(path: string): boolean {
  return (
    path === "/v1/objects" ||
    path === "/v1/objects/locate" ||
    path === "/v1/auth/login" ||
    path === "/v1/auth/signup" ||
    path === "/v1/filecoin/compute" ||
    /^\/v1\/repos\/[^/]+\/[^/]+\/objects(\/missing|\/present|\/resolve)?$/.test(path)
  );
}

export function pathOrg(path: string): string {
  const m = path.match(/^\/v1\/(?:orgs|repos)\/([^/]+)/);
  return m ? decodeURIComponent(m[1]!) : "filecoin-project";
}

export function pathRepo(path: string): string | null {
  const m = path.match(/^\/v1\/repos\/[^/]+\/([^/]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function loadActor(env: Env, request: Request): Promise<Actor | null> {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/Bearer (.+)/i);
  if (!m) return null;
  const tokenHash = await sha256Hex(m[1]!);
  const rows = await d1All<{ user_id: string; name: string; admin: number }>(
    dbTop(env),
    `SELECT u.id as user_id, u.name as name, u.admin as admin
       FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked = 0
      LIMIT 1`,
    [tokenHash]
  );
  const u = rows[0];
  if (!u) return null;
  return { userId: u.user_id, name: u.name, admin: u.admin === 1 };
}

export async function orgCanWrite(env: Env, org: string, actor: Actor): Promise<boolean> {
  if (actor.admin) return true;
  const rows = await d1All<{ ok: number }>(
    dbTop(env),
    `SELECT 1 as ok
       FROM memberships
      WHERE org_id = ? AND user_id = ? AND (role = 'owner' OR can_write = 1)
      LIMIT 1`,
    [org, actor.userId]
  );
  return rows.length > 0;
}

async function repoIsPublic(env: Env, org: string, repo: string): Promise<boolean> {
  const rows = await d1All<{ visibility: string }>(
    dbOrgs(env),
    "SELECT visibility FROM repos WHERE id = ? LIMIT 1",
    [`${org}/${repo}`]
  );
  return rows[0]?.visibility === "public";
}

/** True when `refName` is under refs/heads/users/<username>/* (or a short form of that prefix). */
export function isUserNamespaceRef(refName: string, username: string): boolean {
  const prefixes = [
    `refs/heads/users/${username}/`,
    `heads/users/${username}/`,
    `users/${username}/`,
  ];
  return prefixes.some((p) => refName.startsWith(p) && refName.length > p.length);
}

/** True when `refName` is the default branch (`main` or `default`). */
export function isProtectedRef(refName: string): boolean {
  const n = refName.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
  return n === "main" || n === "default";
}

function refNameFromPath(path: string): string | null {
  const m = path.match(/^\/v1\/repos\/[^/]+\/[^/]+\/refs\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function authorizeMutation(
  env: Env,
  request: Request,
  path: string,
  actor: Actor
): Promise<Response | null> {
  if (path.startsWith("/v1/admin/")) {
    return actor.admin ? null : forbidden();
  }
  const method = request.method.toUpperCase();
  if (
    (method === "POST" && path === "/v1/repos") ||
    ((method === "PUT" || method === "DELETE") && /^\/v1\/repos\/[^/]+\/[^/]+$/.test(path))
  ) {
    // Handler enforces org membership, owners, user-namespace auto-create, and quota.
    return null;
  }
  if (method === "POST" && path === "/v1/orgs") {
    // Handler enforces reserved names, uniqueness, and the per-user cap.
    return null;
  }
  if (/^\/v1\/repos\/[^/]+\/[^/]+\/(pulls|owners)(\/|$)/.test(path)) {
    // Handler enforces create / merge / close / owner roles.
    return null;
  }
  const org = pathOrg(path);
  const refName = refNameFromPath(path);
  if (method === "DELETE" && refName && isProtectedRef(refName) && !actor.admin) {
    return forbidden();
  }
  if (await orgCanWrite(env, org, actor)) return null;

  const repo = pathRepo(path);
  const publicRepo = repo ? await repoIsPublic(env, org, repo) : false;
  if (!publicRepo) return forbidden();

  if (refName) {
    return isUserNamespaceRef(refName, actor.name) ? null : forbidden();
  }
  if (/\/blobs$/.test(path) || /\/changesets$/.test(path)) {
    const len = Number(request.headers.get("content-length") || "0");
    if (len > NON_MEMBER_UPLOAD_MAX) {
      return json({ error: "upload exceeds 10 MB for non-members" }, 413);
    }
    return null;
  }
  return forbidden();
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Rate-limit and global-cap guard for POST /v1/auth/signup. Returns a response to block, or null to continue. */
export async function guardSignup(env: Env, request: Request): Promise<Response | null> {
  const db = dbTop(env);
  const ip = clientIp(request);
  const t = nowMs();
  await d1Run(db, "INSERT INTO signup_attempts (ip, attempted_at) VALUES (?, ?)", [ip, t]);
  const recent = await d1All<{ n: number }>(
    db,
    "SELECT COUNT(*) as n FROM signup_attempts WHERE ip = ? AND attempted_at > ?",
    [ip, t - HOUR_MS]
  );
  if ((recent[0]?.n ?? 0) > SIGNUP_PER_IP_PER_HOUR) {
    return json({ error: "signup rate limit exceeded" }, 429);
  }
  const users = await d1All<{ n: number }>(db, "SELECT COUNT(*) as n FROM users", []);
  if ((users[0]?.n ?? 0) >= SIGNUP_MAX_USERS) {
    return json({ error: "user cap reached" }, 503);
  }
  return null;
}
