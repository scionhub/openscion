//! Dataset resolution, batch-window drain, and shared-dataset threshold.

import {
  DEFAULT_ADD_BATCH_MAX_PIECES,
  DEFAULT_ADD_BATCH_WINDOW_SECS,
  DEFAULT_SHARED_DATASET_MAX_BYTES,
  MIN_BUNDLE_BYTES,
  SHARED_DATASET_ORG,
  paddedBundleSize,
  parseEnvInt,
  resolveDataset,
  sharedDatasetStatus,
  shouldDrainBatch,
  staleAfterMs,
} from "./dataset";
import { STALE_AFTER_MS } from "./durability";

if (SHARED_DATASET_ORG !== "filecoin-project") {
  throw new Error("shared dataset org must be filecoin-project");
}
if (DEFAULT_SHARED_DATASET_MAX_BYTES !== 42_949_672_960) {
  throw new Error("default shared dataset cap must be 40 GiB");
}
if (DEFAULT_ADD_BATCH_WINDOW_SECS !== 3600) {
  throw new Error("default add batch window must be 1h");
}
if (DEFAULT_ADD_BATCH_MAX_PIECES !== 50) {
  throw new Error("default add batch cap must be 50 pieces");
}

const platform = resolveDataset("filecoin-project", {
  hasOwnOnchainDataset: false,
  recordedMode: null,
});
if (platform.datasetOrg !== "filecoin-project" || platform.mode !== "own" || !platform.allowCreate) {
  throw new Error("platform org must keep its own dataset");
}

const newbie = resolveDataset("alice", { hasOwnOnchainDataset: false, recordedMode: null });
if (newbie.datasetOrg !== SHARED_DATASET_ORG || newbie.mode !== "shared" || newbie.allowCreate) {
  throw new Error("new orgs must share the platform dataset and must not create");
}

const existing = resolveDataset("alice", { hasOwnOnchainDataset: true, recordedMode: "shared" });
if (existing.datasetOrg !== "alice" || existing.mode !== "own" || !existing.allowCreate) {
  throw new Error("an org with an on-chain dataset must keep using it");
}

const paid = resolveDataset("alice", { hasOwnOnchainDataset: false, recordedMode: "own" });
if (paid.datasetOrg !== "alice" || paid.mode !== "own" || !paid.allowCreate) {
  throw new Error("admin dataset-mode own must target the org and allow lazy create");
}

const forcedShared = resolveDataset("alice", { hasOwnOnchainDataset: false, recordedMode: "shared" });
if (forcedShared.datasetOrg !== SHARED_DATASET_ORG || forcedShared.allowCreate) {
  throw new Error("recorded shared mode must not create a dataset");
}

const windowMs = 3600_000;
const now = 10_000_000;
const waiting = shouldDrainBatch({
  nowMs: now,
  oldestCreatedAt: now - 60_000,
  pendingCount: 3,
  windowMs,
  maxPieces: 50,
  force: false,
});
if (waiting.drain) throw new Error("must not drain before the window");
if (waiting.nextDrainAt !== now - 60_000 + windowMs) {
  throw new Error("nextDrainAt must be oldest created_at plus the window");
}

const aged = shouldDrainBatch({
  nowMs: now,
  oldestCreatedAt: now - windowMs,
  pendingCount: 3,
  windowMs,
  maxPieces: 50,
  force: false,
});
if (!aged.drain || aged.take !== 3) throw new Error("must drain when oldest pending reaches the window");

const capped = shouldDrainBatch({
  nowMs: now,
  oldestCreatedAt: now - 1_000,
  pendingCount: 50,
  windowMs,
  maxPieces: 50,
  force: false,
});
if (!capped.drain || capped.take !== 50) throw new Error("must drain when pending hits the piece cap");

const kicked = shouldDrainBatch({
  nowMs: now,
  oldestCreatedAt: now - 1_000,
  pendingCount: 2,
  windowMs,
  maxPieces: 50,
  force: true,
});
if (!kicked.drain || kicked.nextDrainAt !== now) throw new Error("admin kick must drain immediately");

const empty = shouldDrainBatch({
  nowMs: now,
  oldestCreatedAt: null,
  pendingCount: 0,
  windowMs,
  maxPieces: 50,
  force: true,
});
if (empty.drain || empty.nextDrainAt !== null) throw new Error("empty queue must not drain");

if (paddedBundleSize(22) !== MIN_BUNDLE_BYTES) {
  throw new Error("tiny bundles must pad to 128 bytes");
}
if (paddedBundleSize(4096) !== 4096) {
  throw new Error("already-large bundles must keep their length");
}

if (parseEnvInt(undefined, 7) !== 7 || parseEnvInt("3600", 1) !== 3600 || parseEnvInt("nope", 4) !== 4) {
  throw new Error("parseEnvInt must use the fallback for missing or invalid values");
}

const under = sharedDatasetStatus(100, DEFAULT_SHARED_DATASET_MAX_BYTES);
if (under.over) throw new Error("under-threshold usage must not be flagged over");
const over = sharedDatasetStatus(DEFAULT_SHARED_DATASET_MAX_BYTES, DEFAULT_SHARED_DATASET_MAX_BYTES);
if (!over.over) throw new Error("usage at the threshold must be flagged over");

if (staleAfterMs(windowMs) !== STALE_AFTER_MS) {
  throw new Error("1h window must not lower the 4h stale threshold");
}
if (staleAfterMs(STALE_AFTER_MS + 1) !== STALE_AFTER_MS + 1) {
  throw new Error("a window longer than 4h must raise the stale threshold");
}
