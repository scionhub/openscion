/** Conditional SQL / CAS helpers for tip persist, PR state, membership, and D1 leases. */

import { d1All, d1Batch, d1Run, nowMs, type D1Write } from "./db";

/** How long a ref persist / delete holds the D1 repo lease. */
export const REF_LEASE_MS = 15_000;
/** Squash merge can take many engine GETs; keep the lease for the whole action. */
export const MERGE_LEASE_MS = 60_000;

export type RefRow = { name: string; target: string; version: number };

export type RefPersistBody = {
  name: string;
  target: string;
  version: number;
  /** Previous tip; `null` means "create only"; omitted means version predecessor. */
  expected?: string | null;
};

export type RefPersistPlan =
  | { action: "ok"; sql: "insert" | "update" | "noop" }
  | { action: "conflict"; current: string | null };

export type TipRow = { ref_name: string; target: string; version: number };

/** Close only an open pull — never overwrite `merged`. */
export const CLOSE_PULL_SQL =
  "UPDATE pulls SET state = 'closed' WHERE id = ? AND state = 'open'";

/** Merge only an open pull. */
export const MERGE_PULL_SQL =
  "UPDATE pulls SET state = 'merged', merged_by = ?, merged_at = ?, head_target = ? WHERE id = ? AND state = 'open'";

export const CLOSE_ISSUE_SQL =
  "UPDATE issues SET state = 'closed', closed_at = ? WHERE id = ? AND state = 'open'";

export const REOPEN_ISSUE_SQL =
  "UPDATE issues SET state = 'open', closed_at = NULL WHERE id = ? AND state = 'closed'";

export const CANCEL_INVITE_SQL =
  "UPDATE org_invitations SET state = 'cancelled', responded_at = ? WHERE id = ? AND state = 'pending'";

export const DECLINE_INVITE_SQL =
  "UPDATE org_invitations SET state = 'declined', responded_at = ? WHERE id = ? AND state = 'pending'";

export const ACCEPT_INVITE_SQL =
  "UPDATE org_invitations SET state = 'accepted', responded_at = ? WHERE id = ? AND state = 'pending'";

export const INSERT_MEMBERSHIP_SQL =
  "INSERT OR IGNORE INTO memberships (org_id, user_id, role, can_write, created_at) VALUES (?, ?, ?, ?, ?)";

/** Demote an owner to member only when another owner remains. */
export const DEMOTE_OWNER_SQL = `UPDATE memberships SET role = 'member', can_write = 0
  WHERE org_id = ? AND user_id = ? AND role = 'owner'
    AND (SELECT COUNT(*) FROM memberships m2 WHERE m2.org_id = memberships.org_id AND m2.role = 'owner') > 1`;

/** Promote a member to owner (no last-owner risk). */
export const PROMOTE_OWNER_SQL =
  "UPDATE memberships SET role = 'owner', can_write = 1 WHERE org_id = ? AND user_id = ?";

/** Delete a member only when they are not the last owner. */
export const DELETE_MEMBER_SQL = `DELETE FROM memberships
  WHERE org_id = ? AND user_id = ?
    AND (
      role != 'owner'
      OR (SELECT COUNT(*) FROM memberships m2 WHERE m2.org_id = ? AND m2.role = 'owner') > 1
    )`;

/** Remove a repo owner only when another owner remains. */
export const DELETE_REPO_OWNER_SQL = `DELETE FROM repo_owners
  WHERE org = ? AND repo = ? AND user_id = ?
    AND (SELECT COUNT(*) FROM repo_owners o WHERE o.org = ? AND o.repo = ?) > 1`;

export const ACQUIRE_LEASE_SQL = `INSERT INTO repo_leases (org, repo, holder, until_ms)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(org, repo) DO UPDATE SET
    holder = excluded.holder,
    until_ms = excluded.until_ms
  WHERE repo_leases.until_ms < ? OR repo_leases.holder = excluded.holder
  RETURNING holder`;

export const RELEASE_LEASE_SQL =
  "DELETE FROM repo_leases WHERE org = ? AND repo = ? AND holder = ?";

export const UPSERT_TIP_SQL = `INSERT INTO repo_tips (org, repo, ref_name, target, version, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(org, repo, ref_name) DO UPDATE SET
    target = excluded.target,
    version = excluded.version,
    updated_at = excluded.updated_at
  WHERE repo_tips.version < excluded.version
     OR repo_tips.target = excluded.target`;

export const LOAD_TIP_SQL =
  "SELECT ref_name, target, version FROM repo_tips WHERE org = ? AND repo = ? AND ref_name = ? LIMIT 1";

export const LOAD_TIPS_SQL =
  "SELECT ref_name, target, version FROM repo_tips WHERE org = ? AND repo = ?";

/** Plan a RepoDO ref persist: idempotent if already at `target`, else CAS. */
export function planRefPersist(existing: RefRow | null, body: RefPersistBody): RefPersistPlan {
  if (existing && existing.target === body.target) {
    return { action: "ok", sql: "noop" };
  }
  if (!existing) {
    if (body.expected != null && body.expected !== "") {
      return { action: "conflict", current: null };
    }
    return { action: "ok", sql: "insert" };
  }
  if (body.expected !== undefined) {
    if (existing.target !== body.expected) {
      return { action: "conflict", current: existing.target };
    }
    return { action: "ok", sql: "update" };
  }
  if (existing.version === body.version - 1) {
    return { action: "ok", sql: "update" };
  }
  return { action: "conflict", current: existing.target };
}

/** `main` and `refs/heads/main` are the same tip for watermark compares. */
export function refAliases(name: string): string[] {
  if (name.startsWith("refs/heads/")) {
    return [name, name.slice("refs/heads/".length)];
  }
  return [name, `refs/heads/${name}`];
}

export function findSnapshotRef(refs: unknown[], name: string): RefRow | null {
  const aliases = new Set(refAliases(name));
  for (const raw of refs) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { name?: unknown; target?: unknown; version?: unknown };
    if (typeof rec.name !== "string" || !aliases.has(rec.name)) continue;
    if (typeof rec.target !== "string") continue;
    return { name: rec.name, target: rec.target, version: Number(rec.version ?? 0) };
  }
  return null;
}

/**
 * D1 watermark is ahead of the Durable Object (or engine) copy.
 * Equal version + different target is split-brain and treated as stale.
 */
export function isDoTipStale(
  d1: { target: string; version: number } | null,
  copy: { target: string; version: number } | null
): boolean {
  if (!d1) return false;
  if (!copy) return d1.version > 0;
  if (d1.version > copy.version) return true;
  if (d1.version === copy.version && d1.target !== copy.target) return true;
  return false;
}

/** Refs in a RepoDO snapshot that sit behind a D1 watermark. */
export function staleSnapshotRefs(tips: TipRow[], snapshotRefs: unknown[]): string[] {
  const stale: string[] = [];
  for (const tip of tips) {
    if (isDoTipStale(tip, findSnapshotRef(snapshotRefs, tip.ref_name))) {
      stale.push(tip.ref_name);
    }
  }
  return stale;
}

/** `expected` from an engine `UpdateRef` body. */
export function parseRefExpected(body: unknown): string | null | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, "expected")) return undefined;
  const value = (body as { expected?: unknown }).expected;
  if (value == null) return null;
  return typeof value === "string" ? value : undefined;
}

export async function acquireRepoLease(
  db: D1Database,
  org: string,
  repo: string,
  holder: string,
  ttlMs: number,
  now = nowMs()
): Promise<boolean> {
  try {
    const until = now + ttlMs;
    const rows = await d1All<{ holder: string }>(db, ACQUIRE_LEASE_SQL, [
      org,
      repo,
      holder,
      until,
      now,
    ]);
    return rows[0]?.holder === holder;
  } catch {
    // Table missing (migration not applied) — do not block writes.
    return true;
  }
}

export async function releaseRepoLease(
  db: D1Database,
  org: string,
  repo: string,
  holder: string
): Promise<void> {
  try {
    await d1Run(db, RELEASE_LEASE_SQL, [org, repo, holder]);
  } catch {
    /* ignore */
  }
}

export async function recordRepoTip(
  db: D1Database,
  org: string,
  repo: string,
  refName: string,
  target: string,
  version: number,
  now = nowMs()
): Promise<void> {
  try {
    await d1Run(db, UPSERT_TIP_SQL, [org, repo, refName, target, version, now]);
  } catch {
    /* ignore */
  }
}

export async function loadRepoTip(
  db: D1Database,
  org: string,
  repo: string,
  refName: string
): Promise<TipRow | null> {
  try {
    const rows = await d1All<TipRow>(db, LOAD_TIP_SQL, [org, repo, refName]);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function staleRepoTips(
  db: D1Database,
  org: string,
  repo: string,
  snapshotRefs: unknown[]
): Promise<string[]> {
  try {
    const tips = await d1All<TipRow>(db, LOAD_TIPS_SQL, [org, repo]);
    return staleSnapshotRefs(tips, snapshotRefs);
  } catch {
    return [];
  }
}

export async function acceptInviteBatch(
  db: D1Database,
  org: string,
  userId: string,
  role: string,
  canWrite: number,
  inviteId: string,
  createdAt: number
): Promise<D1Write[]> {
  return d1Batch(db, [
    db.prepare(INSERT_MEMBERSHIP_SQL).bind(org, userId, role, canWrite, createdAt),
    db.prepare(ACCEPT_INVITE_SQL).bind(createdAt, inviteId),
  ]);
}
