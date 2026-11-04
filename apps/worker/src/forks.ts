import { d1All, d1Run, dbOrgs, dbTop, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { forbidden, orgCanWrite } from "./authz";
import { engineFetch } from "./pulls";
import { insertRepoOwner } from "./owners";
import { repoCreateLimit, repoLimitError } from "./repos";
import { userIsPaid } from "./users";

type Env = D1Env & {
  ENGINE: DurableObjectNamespace;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const ADMIN_ONLY_ORGS = new Set(["filecoin-project"]);
const FORK_ROUTE = /^\/v1\/repos\/([^/]+)\/([^/]+)\/forks$/;

export async function handleRepoFork(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  if (request.method.toUpperCase() !== "POST") return null;
  const m = path.match(FORK_ROUTE);
  if (!m) return null;
  if (!actor) return json({ error: "unauthorized" }, 401);
  const srcOrg = decodeURIComponent(m[1]!);
  const srcRepo = decodeURIComponent(m[2]!);
  type Body = { org?: string };
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    /* optional */
  }
  const targetOrg = (body.org ?? actor.name).trim();
  const targetRepo = srcRepo; // keep same name
  if (!targetOrg) return json({ error: "invalid org name" }, 400);
  if (ADMIN_ONLY_ORGS.has(targetOrg) && !actor.admin) return forbidden();

  // Target org permission: own username namespace or can write to org.
  const top = dbTop(env);
  const orgsDb = dbOrgs(env);
  if (targetOrg !== actor.name) {
    const can = actor.admin || (await orgCanWrite(env, targetOrg, actor));
    if (!can) return forbidden();
  } else {
    // Ensure username org exists and caller is a member/owner.
    const t = nowMs();
    await d1Run(top, "INSERT OR IGNORE INTO orgs (id, created_at) VALUES (?, ?)", [targetOrg, t]);
    await d1Run(
      top,
      `INSERT OR IGNORE INTO memberships (org_id, user_id, role, can_write, created_at) VALUES (?, ?, 'owner', 1, ?)`,
      [targetOrg, actor.userId, t]
    );
  }

  // Repo exists collision
  const existing = await d1All<{ id: string }>(
    orgsDb,
    "SELECT id FROM repos WHERE id = ? LIMIT 1",
    [`${targetOrg}/${targetRepo}`]
  );
  if (existing[0]) return json({ error: "repo exists" }, 409);

  // Quota: same cap as create
  if (!actor.admin) {
    const paid = await userIsPaid(top, actor.userId);
    const limit = repoCreateLimit(false, paid);
    const owned = await countOwnedRepos(orgsDb, actor.userId, actor.name);
    if (limit !== null && owned >= limit) return json(repoLimitError(limit), 403);
  }

  // Create empty target repo in engine
  const origin = new URL(request.url);
  const create = await engineFetch(env, origin, `/v1/repos/${targetOrg}/${targetRepo}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!create.ok && create.status !== 409) {
    const detail = await create.text();
    return json({ error: "engine create failed", detail }, create.status);
  }

  // Insert target repo row + owner + fork lineage
  const createdAt = nowMs();
  try {
    await d1Run(
      orgsDb,
      "INSERT INTO repos (id, name, visibility, created_at, created_by, org) VALUES (?, ?, 'public', ?, ?, ?)",
      [`${targetOrg}/${targetRepo}`, targetRepo, createdAt, actor.userId, targetOrg]
    );
  } catch {
    try {
      await d1Run(
        orgsDb,
        "INSERT INTO repos (id, name, visibility, created_at, created_by) VALUES (?, ?, 'public', ?, ?)",
        [`${targetOrg}/${targetRepo}`, targetRepo, createdAt, actor.userId]
      );
    } catch {
      await d1Run(
        orgsDb,
        "INSERT OR IGNORE INTO repos (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)",
        [`${targetOrg}/${targetRepo}`, targetRepo, createdAt]
      );
    }
  }
  await insertRepoOwner(orgsDb, targetOrg, targetRepo, actor.userId, actor.name, actor.name, createdAt);
  // Optional: record fork lineage when column exists
  try {
    await d1Run(orgsDb, "UPDATE repos SET forked_from = ? WHERE id = ?", [`${srcOrg}/${srcRepo}`, `${targetOrg}/${targetRepo}`]);
  } catch {
    /* column may not exist yet */
  }

  // Copy tip refs: prefer RepoDO list; fallback to copying main only
  const copied = await copySourceRefsToTarget(env, origin, srcOrg, srcRepo, targetOrg, targetRepo).catch(
    () => ({ ok: false } as { ok: boolean })
  );
  if (!copied.ok) {
    // Non-fatal: the fork exists and is usable; it may start with an empty main
  }

  return json({ org: targetOrg, name: targetRepo }, 201);
}

async function listRepoRefsFromDO(
  env: Env,
  origin: URL,
  org: string,
  repo: string
): Promise<{ name: string; target: string; version: number }[]> {
  if (!(env as any).REPO) return [];
  try {
    const id = (env as any).REPO.idFromName(`${org}/${repo}`);
    const stub = (env as any).REPO.get(id);
    const h = new Headers();
    h.set("x-internal-secret", (env as unknown as { INTERNAL_SECRET?: string }).INTERNAL_SECRET || "");
    const r = await stub.fetch(
      new Request(new URL(`/__internal/do/${org}/${repo}/refs`, origin).toString(), { method: "GET", headers: h })
    );
    if (!r.ok) return [];
    const j = (await r.json()) as { refs?: { name?: unknown; target?: unknown; version?: unknown }[] };
    return (j.refs ?? [])
      .map((x) => ({
        name: typeof x.name === "string" ? x.name : "",
        target: typeof x.target === "string" ? x.target : "",
        version: Number(x.version ?? 0),
      }))
      .filter((r) => r.name && r.target);
  } catch {
    return [];
  }
}

async function copySourceRefsToTarget(
  env: Env,
  origin: URL,
  srcOrg: string,
  srcRepo: string,
  dstOrg: string,
  dstRepo: string
): Promise<{ ok: true } | { ok: false }> {
  const refs = await listRepoRefsFromDO(env, origin, srcOrg, srcRepo);
  let toCopy = refs.filter((r) => r.name.startsWith("refs/heads/"));
  // Fallback: only main
  if (toCopy.length === 0) {
    const t = await refTarget(env, origin, srcOrg, srcRepo, "main").catch(() => null);
    if (t) toCopy = [{ name: "refs/heads/main", target: t, version: 0 }];
  }
  for (const r of toCopy) {
    // Create ref in target; CAS expected omitted for new refs
    const resp = await engineFetch(env, origin, `/v1/repos/${dstOrg}/${dstRepo}/refs/${r.name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new: r.target }),
    });
    if (!resp.ok && resp.status !== 409) {
      // Try CAS with expected null when strict
      const alt = await engineFetch(env, origin, `/v1/repos/${dstOrg}/${dstRepo}/refs/${r.name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected: null, new: r.target }),
      });
      if (!alt.ok && alt.status !== 409) {
        // continue best-effort
      }
    }
  }
  return { ok: true };
}

async function refTarget(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  refName: string
): Promise<string | null> {
  const resp = await engineFetch(env, origin, `/v1/repos/${org}/${repo}/refs/${refName}`, { method: "GET" });
  if (!resp.ok) return null;
  const b = (await resp.json()) as { target?: string };
  return b.target ?? null;
}

async function countOwnedRepos(db: D1Database, userId: string, username: string): Promise<number> {
  try {
    const rows = await d1All<{ n: number }>(db, "SELECT COUNT(*) as n FROM repos WHERE created_by = ?", [userId]);
    return rows[0]?.n ?? 0;
  } catch {
    const rows = await d1All<{ n: number }>(db, "SELECT COUNT(*) as n FROM repos WHERE id LIKE ?", [username + "/%"]);
    return rows[0]?.n ?? 0;
  }
}

