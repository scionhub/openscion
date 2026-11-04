//! Repo deletion: collect Filecoin pieces, skip shared bundles, schedule removals.

import { d1All, d1Run, dbOrgs, type D1Env } from "./db";

const BUNDLE_IN_CHUNK = 90;

export type PieceRemovalPlan = {
  toRemove: string[];
  skippedShared: number;
  pendingDropped: number;
};

export type DatasetPiece = {
  pieceCid: string;
  pieceId: number;
};

export type DeleteRepoResult = {
  deleted: true;
  removedPieces: number;
  skippedShared: number;
  tx: string | null;
};

export function parseForceFlag(
  raw: unknown
): { ok: true; force: boolean } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: true, force: false };
  }
  const force = (raw as { force?: unknown }).force;
  if (force === undefined) return { ok: true, force: false };
  if (typeof force !== "boolean") return { ok: false, error: "force must be a boolean" };
  return { ok: true, force };
}

/**
 * Pending bundles were never added on-chain: drop them.
 * Skip any registered bundle another repo still references.
 */
export function planPieceRemoval(input: {
  registered: string[];
  pending: string[];
  shared: Iterable<string>;
}): PieceRemovalPlan {
  const pending = new Set(input.pending.filter((c) => c.length > 0));
  const shared = new Set([...input.shared].filter((c) => c.length > 0));
  const added = [...new Set(input.registered.filter((c) => c.length > 0 && !pending.has(c)))];
  const toRemove = added.filter((c) => !shared.has(c));
  return {
    toRemove,
    skippedShared: added.length - toRemove.length,
    pendingDropped: pending.size,
  };
}

export function mapBundleCidsToPieceIds(
  bundleCids: string[],
  datasetPieces: DatasetPiece[]
): { pieceIds: number[]; unresolved: string[] } {
  const byCid = new Map<string, number>();
  for (const p of datasetPieces) {
    if (!byCid.has(p.pieceCid)) byCid.set(p.pieceCid, p.pieceId);
  }
  const pieceIds: number[] = [];
  const unresolved: string[] = [];
  const seen = new Set<number>();
  for (const cid of bundleCids) {
    const id = byCid.get(cid);
    if (id == null || !Number.isFinite(id)) {
      unresolved.push(cid);
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      pieceIds.push(id);
    }
  }
  return { pieceIds, unresolved };
}

export function deleteRepoJson(input: {
  removedPieces: number;
  skippedShared: number;
  tx: string | null;
}): DeleteRepoResult {
  return {
    deleted: true,
    removedPieces: input.removedPieces,
    skippedShared: input.skippedShared,
    tx: input.tx,
  };
}

export async function recordBundleRef(
  env: D1Env,
  org: string,
  repo: string,
  bundleCid: string
): Promise<void> {
  if (!bundleCid) return;
  try {
    await d1Run(
      dbOrgs(env),
      `INSERT OR IGNORE INTO bundle_refs (bundle_cid, org, repo, created_at) VALUES (?, ?, ?, ?)`,
      [bundleCid, org, repo, Date.now()]
    );
  } catch {
    /* table may not exist yet */
  }
}

export async function deleteBundleRefsForRepo(env: D1Env, org: string, repo: string): Promise<void> {
  try {
    await d1Run(dbOrgs(env), "DELETE FROM bundle_refs WHERE org = ? AND repo = ?", [org, repo]);
  } catch {
    /* table may not exist yet */
  }
}

export async function findSharedBundleCids(
  env: D1Env,
  org: string,
  repo: string,
  bundleCids: string[]
): Promise<Set<string>> {
  const unique = [...new Set(bundleCids.filter((c) => c.length > 0))];
  if (unique.length === 0) return new Set();
  const shared = new Set<string>();
  try {
    const db = dbOrgs(env);
    for (let i = 0; i < unique.length; i += BUNDLE_IN_CHUNK) {
      const chunk = unique.slice(i, i + BUNDLE_IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await d1All<{ bundle_cid: string }>(
        db,
        `SELECT DISTINCT bundle_cid FROM bundle_refs
          WHERE bundle_cid IN (${placeholders})
            AND NOT (org = ? AND repo = ?)`,
        [...chunk, org, repo]
      );
      for (const row of rows) {
        if (row.bundle_cid) shared.add(row.bundle_cid);
      }
    }
  } catch {
    /* table may not exist yet — treat as no other refs */
  }
  return shared;
}

