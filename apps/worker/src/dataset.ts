/** Shared Filecoin dataset resolution and pending-add batching. */

import { d1All, d1Run, dbOrgs, type D1Env } from "./db";
import { STALE_AFTER_MS } from "./durability";

/** Platform org whose on-chain dataset (46121) every new org shares. */
export const SHARED_DATASET_ORG = "filecoin-project";

/** 40 GiB. Below the ~49 GiB point where the 0.12 USDFC/month minimum stops dominating. */
export const DEFAULT_SHARED_DATASET_MAX_BYTES = 42_949_672_960;

/** Drain at most once per hour per RepoDO unless the piece cap is hit or an admin kicks. */
export const DEFAULT_ADD_BATCH_WINDOW_SECS = 3600;

/** Send at most this many pending bundles in one add-pieces call. */
export const DEFAULT_ADD_BATCH_MAX_PIECES = 50;

/** Smallest bundle the engine uploads (see packer MIN_BUNDLE_BYTES). */
export const MIN_BUNDLE_BYTES = 128;

export type DatasetMode = "shared" | "own";

export type DatasetResolution = {
  datasetOrg: string;
  mode: DatasetMode;
  allowCreate: boolean;
  reason: string;
};

export function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Approximate padded size: uploaded bundles are at least 128 bytes. */
export function paddedBundleSize(rawBytes: number): number {
  if (!Number.isFinite(rawBytes) || rawBytes <= 0) return MIN_BUNDLE_BYTES;
  return Math.max(Math.floor(rawBytes), MIN_BUNDLE_BYTES);
}

/**
 * Pick which org's on-chain dataset an add-pieces call should target.
 *
 * An existing `datasets` row with an on-chain id always wins (already paid).
 * `recordedMode = own` is admin intent; creation stays lazy. Everyone else
 * uses the shared platform dataset and must not trigger a create.
 */
export function resolveDataset(
  org: string,
  input: {
    hasOwnOnchainDataset: boolean;
    recordedMode: DatasetMode | null;
  }
): DatasetResolution {
  if (org === SHARED_DATASET_ORG) {
    return {
      datasetOrg: org,
      mode: "own",
      allowCreate: true,
      reason: "platform dataset",
    };
  }
  if (input.hasOwnOnchainDataset) {
    return {
      datasetOrg: org,
      mode: "own",
      allowCreate: true,
      reason: "existing on-chain dataset",
    };
  }
  if (input.recordedMode === "own") {
    return {
      datasetOrg: org,
      mode: "own",
      allowCreate: true,
      reason: "admin dataset-mode own",
    };
  }
  return {
    datasetOrg: SHARED_DATASET_ORG,
    mode: "shared",
    allowCreate: false,
    reason: "default shared platform dataset",
  };
}

export function shouldDrainBatch(opts: {
  nowMs: number;
  oldestCreatedAt: number | null;
  pendingCount: number;
  windowMs: number;
  maxPieces: number;
  force: boolean;
}): { drain: boolean; nextDrainAt: number | null; take: number } {
  if (opts.pendingCount <= 0 || opts.oldestCreatedAt == null) {
    return { drain: false, nextDrainAt: null, take: 0 };
  }
  const cap = Math.max(1, opts.maxPieces);
  const take = Math.min(opts.pendingCount, cap);
  if (opts.force) {
    return { drain: true, nextDrainAt: opts.nowMs, take };
  }
  if (opts.pendingCount >= cap) {
    return { drain: true, nextDrainAt: opts.nowMs, take };
  }
  const dueAt = opts.oldestCreatedAt + opts.windowMs;
  if (opts.nowMs >= dueAt) {
    return { drain: true, nextDrainAt: opts.nowMs, take };
  }
  return { drain: false, nextDrainAt: dueAt, take: 0 };
}

export function sharedDatasetStatus(
  bytes: number,
  threshold: number
): { bytes: number; threshold: number; over: boolean } {
  return { bytes, threshold, over: bytes >= threshold };
}

/** Stale watchdog must not fire for items that are only waiting out the batch window. */
export function staleAfterMs(windowMs: number, base = STALE_AFTER_MS): number {
  return Math.max(base, windowMs);
}

export async function loadDatasetResolution(env: D1Env, org: string): Promise<DatasetResolution> {
  const db = dbOrgs(env);
  let recordedMode: DatasetMode | null = null;
  try {
    const rows = await d1All<{ mode: string }>(
      db,
      "SELECT mode FROM org_datasets WHERE org = ? LIMIT 1",
      [org]
    );
    const mode = rows[0]?.mode;
    if (mode === "own" || mode === "shared") recordedMode = mode;
  } catch {
    /* org_datasets may not exist yet */
  }
  let hasOwnOnchainDataset = false;
  try {
    const rows = await d1All<{ n: number }>(
      db,
      `SELECT COUNT(*) as n FROM datasets
        WHERE (org = ? OR id = ?)
          AND onchain_id IS NOT NULL AND TRIM(onchain_id) != ''`,
      [org, org]
    );
    hasOwnOnchainDataset = (rows[0]?.n ?? 0) > 0;
  } catch {
    /* datasets.onchain_id may be missing */
  }
  return resolveDataset(org, { hasOwnOnchainDataset, recordedMode });
}

export async function addDatasetUsage(
  env: D1Env,
  datasetOrg: string,
  bytes: number,
  now: number
): Promise<void> {
  if (bytes <= 0) return;
  try {
    await d1Run(
      dbOrgs(env),
      `INSERT INTO dataset_usage (dataset_org, bytes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(dataset_org) DO UPDATE SET
         bytes = dataset_usage.bytes + excluded.bytes,
         updated_at = excluded.updated_at`,
      [datasetOrg, bytes, now]
    );
  } catch {
    /* dataset_usage may not exist yet */
  }
}

export async function getDatasetUsage(env: D1Env, datasetOrg: string): Promise<number> {
  try {
    const rows = await d1All<{ bytes: number }>(
      dbOrgs(env),
      "SELECT bytes FROM dataset_usage WHERE dataset_org = ? LIMIT 1",
      [datasetOrg]
    );
    return Number(rows[0]?.bytes ?? 0);
  } catch {
    return 0;
  }
}

export async function setOrgDatasetMode(
  env: D1Env,
  org: string,
  mode: DatasetMode,
  now: number
): Promise<{ org: string; mode: DatasetMode; dataset_org: string; reason: string }> {
  const datasetOrg = mode === "own" ? org : SHARED_DATASET_ORG;
  const reason = mode === "own" ? "admin dataset-mode own" : "admin dataset-mode shared";
  await d1Run(
    dbOrgs(env),
    `INSERT INTO org_datasets (org, dataset_org, mode, reason, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org) DO UPDATE SET
       dataset_org = excluded.dataset_org,
       mode = excluded.mode,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
    [org, datasetOrg, mode, reason, now]
  );
  return { org, mode, dataset_org: datasetOrg, reason };
}
