import { d1All, d1Run, dbOrgs, dbTop, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { forbidden, orgCanWrite } from "./authz";
import { insertRepoOwner } from "./owners";
import { engineFetch } from "./pulls";

const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ORG_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_REPOS_NON_ADMIN = 3;
const ADMIN_ONLY_ORGS = new Set(["filecoin-project"]);
const RETENTION = {
  freeDays: 60,
  payUrl: "https://scionhub.github.io/checkout.html",
};

type Env = D1Env & {
  ENGINE: DurableObjectNamespace;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const POST_CREATE = /^\/v1\/repos$/;
const PUT_CREATE = /^\/v1\/repos\/([^/]+)\/([^/]+)$/;

/** Handle `POST /v1/repos` and `PUT /v1/repos/{org}/{repo}`. Returns null if not a create route. */
export async function handleRepoCreate(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const post = method === "POST" && POST_CREATE.test(path);
  const put = method === "PUT" ? path.match(PUT_CREATE) : null;
  if (!post && !put) return null;
  if (!actor) return json({ error: "unauthorized" }, 401);

  let org: string;
  let name: string;
  if (post) {
    let body: { name?: string; org?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    name = (body.name ?? "").trim();
    org = (body.org ?? actor.name).trim();
  } else {
    org = decodeURIComponent(put![1]!);
    name = decodeURIComponent(put![2]!);
  }
  if (!REPO_NAME_RE.test(name)) {
    return json({ error: "invalid repo name" }, 400);
  }
  if (!org || !ORG_NAME_RE.test(org)) {
    return json({ error: "invalid org name" }, 400);
  }

  if (ADMIN_ONLY_ORGS.has(org) && !actor.admin) {
    return forbidden();
  }

  const top = dbTop(env);
  const orgsDb = dbOrgs(env);
  const member = actor.admin || (await orgCanWrite(env, org, actor));
  if (!member) {
    if (org !== actor.name) return forbidden();
    await ensureUserOrg(top, org, actor.userId);
  }

  if (!actor.admin) {
    const owned = await countOwnedRepos(orgsDb, actor.userId, actor.name);
    const existing = await d1All<{ id: string }>(
      orgsDb,
      "SELECT id FROM repos WHERE id = ? LIMIT 1",
      [`${org}/${name}`]
    );
    if (existing.length === 0 && owned >= MAX_REPOS_NON_ADMIN) {
      return json({ error: "repo limit reached" }, 403);
    }
  }

  const origin = new URL(request.url);
  const engine = await engineFetch(env, origin, `/v1/repos/${org}/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!engine.ok && engine.status !== 409) {
    const detail = await engine.text();
    return json({ error: "engine create failed", detail }, engine.status);
  }

  const createdAt = nowMs();
  const inserted = await insertRepo(orgsDb, org, name, actor.userId, createdAt);
  if (inserted) {
    await insertRepoOwner(orgsDb, org, name, actor.userId, actor.name, actor.name, createdAt);
  }
  const row = await d1All<{ name: string; visibility: string; created_at: number }>(
    orgsDb,
    "SELECT name, visibility, created_at FROM repos WHERE id = ? LIMIT 1",
    [`${org}/${name}`]
  );
  const rec = row[0];
  if (!rec) return json({ error: "repo create failed" }, 500);
  if (!inserted && post) {
    return json({ error: "repo exists" }, 409);
  }
  return json(
    {
      org,
      name: rec.name,
      visibility: rec.visibility,
      created_at: rec.created_at,
      retention: RETENTION,
    },
    inserted ? 201 : 200
  );
}

async function ensureUserOrg(db: D1Database, org: string, userId: string): Promise<void> {
  const t = nowMs();
  await d1Run(db, "INSERT OR IGNORE INTO orgs (id, created_at) VALUES (?, ?)", [org, t]);
  await d1Run(
    db,
    `INSERT OR IGNORE INTO memberships (org_id, user_id, role, can_write, created_at)
     VALUES (?, ?, 'owner', 1, ?)`,
    [org, userId, t]
  );
}

async function countOwnedRepos(db: D1Database, userId: string, username: string): Promise<number> {
  try {
    const rows = await d1All<{ n: number }>(
      db,
      "SELECT COUNT(*) as n FROM repos WHERE created_by = ?",
      [userId]
    );
    return rows[0]?.n ?? 0;
  } catch {
    const rows = await d1All<{ n: number }>(
      db,
      "SELECT COUNT(*) as n FROM repos WHERE id LIKE ?",
      [username + "/%"]
    );
    return rows[0]?.n ?? 0;
  }
}

async function insertRepo(
  db: D1Database,
  org: string,
  name: string,
  userId: string,
  createdAt: number
): Promise<boolean> {
  const id = `${org}/${name}`;
  const existing = await d1All<{ id: string }>(db, "SELECT id FROM repos WHERE id = ? LIMIT 1", [id]);
  if (existing.length > 0) return false;
  try {
    await d1Run(
      db,
      "INSERT INTO repos (id, name, visibility, created_at, created_by, org) VALUES (?, ?, 'public', ?, ?, ?)",
      [id, name, createdAt, userId, org]
    );
  } catch {
    try {
      await d1Run(
        db,
        "INSERT INTO repos (id, name, visibility, created_at, created_by) VALUES (?, ?, 'public', ?, ?)",
        [id, name, createdAt, userId]
      );
    } catch {
      await d1Run(
        db,
        "INSERT OR IGNORE INTO repos (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)",
        [id, name, createdAt]
      );
    }
  }
  return true;
}
