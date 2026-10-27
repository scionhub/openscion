import { d1All, d1Run, dbOrgs, dbTop, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { forbidden, orgCanWrite } from "./authz";
import { loadDatasetResolution, recomputeDatasetUsage, recordPieceRemovals } from "./dataset";
import {
  deleteBundleRefsForRepo,
  deleteRepoJson,
  findSharedBundleCids,
  mapBundleCidsToPieceIds,
  parseForceFlag,
  planPieceRemoval,
  recordBundleRef,
} from "./repo_delete";

/** Andy, seeded as owner of the platform Filecoin repos. */
export const ANDY_USER_ID = "0ae8965c-8dad-4b1b-a2ea-87d106161ee0";
export const ANDY_USER_NAME = "andy";

/** Platform Filecoin repos that must never be deleted, even by a site admin. */
export const PROTECTED_REPOS = ["filecoin-project/curio", "filecoin-project/lotus"] as const;

type Env = D1Env & {
  ENGINE: DurableObjectNamespace;
  REPO?: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
  ADMIN_TOKEN?: string;
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

export function protectedDeleteMessage(org: string, repo: string): string {
  return `cannot delete ${org}/${repo}`;
}

/** Owners and site admins may add/remove owners and delete the repo. */
export function ownerMutateDenied(actor: Actor | null, isOwner: boolean): 401 | 403 | null {
  if (!actor) return 401;
  if (actor.admin || isOwner) return null;
  return 403;
}

/** Hardcoded POC protection: curio and lotus cannot be deleted, even by a site admin. */
export function protectedDeleteDenied(
  org: string,
  repo: string,
  actor: Actor,
  allowList?: string
): 403 | null {
  if (!isProtectedRepo(org, repo)) return null;
  // Temporary operator override (deploy-time var ALLOW_PROTECTED_DELETE="org/repo,...").
  // Site admins only; unset it again right after use.
  const allowed = (allowList ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (actor?.admin && allowed.includes(`${org}/${repo}`)) return null;
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

/** True when `{org}/{repo}` is in the D1 catalog (created here, not deleted). */
export async function repoExists(env: D1Env, org: string, repo: string): Promise<boolean> {
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
  if (protectedDeleteDenied(org, repo, actor, (env as { ALLOW_PROTECTED_DELETE?: string }).ALLOW_PROTECTED_DELETE) === 403) {
    return json({ error: protectedDeleteMessage(org, repo) }, 403);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = validateDeleteConfirm(raw, org, repo);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const forceParsed = parseForceFlag(raw);
  if (!forceParsed.ok) return json({ error: forceParsed.error }, 400);
  const force = forceParsed.force && actor.admin;

  const removal = await scheduleRepoPieceRemovals(env, origin, org, repo, engineFetch);
  if (!removal.ok && !force) {
    return json({ error: removal.error }, 502);
  }

  await wipeRepoStorage(env, origin, org, repo, engineFetch);
  await deleteRepoRows(env, org, repo);
  return json(
    deleteRepoJson({
      removedPieces: removal.ok ? removal.removedPieces : 0,
      skippedShared: removal.skippedShared,
      tx: removal.ok ? removal.tx : null,
    })
  );
}

export async function deleteRepoRows(env: D1Env, org: string, repo: string): Promise<void> {
  const db = dbOrgs(env);
  await deleteBundleRefsForRepo(env, org, repo);
  await d1Run(db, "DELETE FROM pr_comments WHERE org = ? AND repo = ?", [org, repo]);
  await d1Run(db, "DELETE FROM pr_approvals WHERE org = ? AND repo = ?", [org, repo]);
  await d1Run(db, "DELETE FROM pr_reviews WHERE org = ? AND repo = ?", [org, repo]).catch(() => undefined);
  await d1Run(db, "DELETE FROM pulls WHERE org = ? AND repo = ?", [org, repo]);
  await d1Run(db, "DELETE FROM issue_comments WHERE org = ? AND repo = ?", [org, repo]).catch(() => undefined);
  await d1Run(db, "DELETE FROM issues WHERE org = ? AND repo = ?", [org, repo]).catch(() => undefined);
  await d1Run(db, "DELETE FROM repo_counters WHERE org = ? AND repo = ?", [org, repo]).catch(() => undefined);
  await d1Run(db, "DELETE FROM webhooks WHERE org = ? AND repo = ?", [org, repo]).catch(() => undefined);
  await d1Run(db, "DELETE FROM repo_owners WHERE org = ? AND repo = ?", [org, repo]);
  await d1Run(db, "DELETE FROM repos WHERE id = ?", [`${org}/${repo}`]);
}

type RemovalOk = { ok: true; removedPieces: number; skippedShared: number; tx: string | null };
type RemovalErr = { ok: false; error: string; skippedShared: number };

async function scheduleRepoPieceRemovals(
  env: Env,
  origin: URL,
  org: string,
  repo: string,
  engineFetch: EngineFetch
): Promise<RemovalOk | RemovalErr> {
  const registered = await listRepoBundleCids(env, origin, org, repo);
  if (!registered.ok) return { ok: false, error: registered.error, skippedShared: 0 };
  const pending = await listRepoPendingBundleCids(env, origin, org, repo);
  if (!pending.ok) return { ok: false, error: pending.error, skippedShared: 0 };
  const shared = await findSharedBundleCids(env, org, repo, registered.cids);
  const plan = planPieceRemoval({ registered: registered.cids, pending: pending.cids, shared });
  if (plan.toRemove.length === 0) {
    return { ok: true, removedPieces: 0, skippedShared: plan.skippedShared, tx: null };
  }
  const datasetOrg = (await loadDatasetResolution(env, org)).datasetOrg;
  const listed = await fetchDatasetPieces(env, origin, datasetOrg, engineFetch);
  if (!listed.ok) return { ...listed, skippedShared: plan.skippedShared };
  if (listed.mock) {
    return { ok: true, removedPieces: 0, skippedShared: plan.skippedShared, tx: null };
  }
  let already = new Set<number>();
  try {
    const rows = await d1All<{ piece_id: number }>(
      dbOrgs(env),
      "SELECT piece_id FROM piece_removals WHERE dataset_org = ?",
      [datasetOrg]
    );
    already = new Set(rows.map((r) => Number(r.piece_id)));
  } catch { /* table may not exist yet */ }
  // Never schedule a piece twice (a retry after a partial failure).
  const livePieces = listed.pieces.filter((p) => !already.has(p.pieceId));
  const mapped = mapBundleCidsToPieceIds(plan.toRemove, livePieces);
  if (mapped.pieceIds.length === 0) {
    return {
      ok: false,
      skippedShared: plan.skippedShared,
      error: `could not resolve piece ids for ${mapped.unresolved.length} bundle(s)`,
    };
  }
  const removed = await callRemovePieces(env, origin, datasetOrg, mapped.pieceIds, engineFetch);
  if (!removed.ok) return { ...removed, skippedShared: plan.skippedShared };
  // Decrement usage once: record the scheduled removals, then recompute from live pieces.
  const idSet = new Set(mapped.pieceIds);
  const now = Date.now();
  try {
    await recordPieceRemovals(env, datasetOrg, livePieces.filter((p) => idSet.has(p.pieceId)), removed.tx, now);
    await recomputeDatasetUsage(env, datasetOrg, listed.pieces, now);
  } catch { /* usage is advisory; admin recompute can fix it */ }
  return {
    ok: true,
    removedPieces: mapped.pieceIds.length,
    skippedShared: plan.skippedShared,
    tx: removed.tx,
  };
}

function adminEngineHeaders(env: Env): Headers {
  const h = new Headers({ "content-type": "application/json" });
  if (env.ADMIN_TOKEN) h.set("x-admin-token", env.ADMIN_TOKEN);
  return h;
}

export async function fetchDatasetPieces(
  env: Env,
  origin: URL,
  datasetOrg: string,
  engineFetch: EngineFetch
): Promise<
  | { ok: true; pieces: { pieceCid: string; pieceId: number }[]; mock: boolean }
  | { ok: false; error: string }
> {
  const resp = await engineFetch(
    env,
    origin,
    `/v1/admin/data-set-pieces?org=${encodeURIComponent(datasetOrg)}`,
    { method: "GET", headers: adminEngineHeaders(env) }
  );
  if (!resp.ok) {
    const reason = await engineErrorReason(resp);
    return { ok: false, error: reason };
  }
  const body = (await resp.json()) as {
    pieces?: { pieceCid?: unknown; pieceId?: unknown }[];
    mock?: unknown;
  };
  const pieces = (body.pieces ?? [])
    .map((p) => ({
      pieceCid: typeof p.pieceCid === "string" ? p.pieceCid : "",
      pieceId: typeof p.pieceId === "number" ? p.pieceId : Number(p.pieceId),
    }))
    .filter((p) => p.pieceCid.length > 0 && Number.isFinite(p.pieceId));
  return { ok: true, pieces, mock: body.mock === true };
}

async function callRemovePieces(
  env: Env,
  origin: URL,
  datasetOrg: string,
  pieceIds: number[],
  engineFetch: EngineFetch
): Promise<{ ok: true; tx: string | null } | { ok: false; error: string }> {
  const resp = await engineFetch(env, origin, "/v1/admin/remove-pieces", {
    method: "POST",
    headers: adminEngineHeaders(env),
    body: JSON.stringify({ org: datasetOrg, pieceIds }),
  });
  if (!resp.ok) {
    return { ok: false, error: await engineErrorReason(resp) };
  }
  const body = (await resp.json()) as { tx?: unknown };
  const tx = typeof body.tx === "string" && body.tx.length > 0 ? body.tx : null;
  return { ok: true, tx };
}

async function engineErrorReason(resp: Response): Promise<string> {
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
  } catch {
    /* keep raw */
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 400) : `remove-pieces failed: ${resp.status}`;
}

export async function listRepoBundleCids(
  env: Env,
  origin: URL,
  org: string,
  repo: string
): Promise<{ ok: true; cids: string[] } | { ok: false; error: string }> {
  if (!env.REPO) return { ok: true, cids: [] };
  const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/bundles`, origin).toString(), {
      method: "GET",
      headers: h,
    })
  );
  if (r.status === 404) return { ok: true, cids: [] };
  if (!r.ok) return { ok: false, error: `list bundles failed: ${r.status}` };
  const j = (await r.json()) as { bundles?: unknown };
  if (!Array.isArray(j.bundles)) return { ok: true, cids: [] };
  return {
    ok: true,
    cids: j.bundles.filter((c): c is string => typeof c === "string" && c.length > 0),
  };
}

async function listRepoPendingBundleCids(
  env: Env,
  origin: URL,
  org: string,
  repo: string
): Promise<{ ok: true; cids: string[] } | { ok: false; error: string }> {
  if (!env.REPO) return { ok: true, cids: [] };
  const stub = env.REPO.get(env.REPO.idFromName(`${org}/${repo}`));
  const h = new Headers();
  h.set("x-internal-secret", env.INTERNAL_SECRET || "");
  const r = await stub.fetch(
    new Request(new URL(`/__internal/do/${org}/${repo}/pending-adds`, origin).toString(), {
      method: "GET",
      headers: h,
    })
  );
  if (r.status === 404) return { ok: true, cids: [] };
  if (!r.ok) return { ok: false, error: `list pending-adds failed: ${r.status}` };
  const j = (await r.json()) as { pending?: { bundleCid?: unknown }[] };
  return {
    ok: true,
    cids: (j.pending ?? [])
      .map((p) => p.bundleCid)
      .filter((c): c is string => typeof c === "string" && c.length > 0),
  };
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


/** Admin: recompute a dataset's usage counter from live on-chain pieces (minus scheduled removals). */
export async function adminRecomputeUsage(env: Env, origin: URL, datasetOrg: string, engineFetch: EngineFetch): Promise<Response> {
  const listed = await fetchDatasetPieces(env, origin, datasetOrg, engineFetch);
  if (!listed.ok) return json({ error: listed.error }, 502);
  const r = await recomputeDatasetUsage(env, datasetOrg, listed.pieces, Date.now());
  return json({ datasetOrg, ...r, livePieces: listed.pieces.length });
}

/** Admin: backfill bundle_refs (deletion-safety index) from a repo's RepoDO bundle map. */
export async function adminBackfillBundleRefs(env: Env, origin: URL, org: string, repo: string): Promise<Response> {
  const listed = await listRepoBundleCids(env, origin, org, repo);
  if (!listed.ok) return json({ error: listed.error }, 502);
  for (const cid of listed.cids) await recordBundleRef(env, org, repo, cid);
  return json({ org, repo, bundles: listed.cids.length });
}
