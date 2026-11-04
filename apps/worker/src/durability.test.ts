//! Assertions for admin reset and the durability watchdog.

import {
  RESET_TABLES,
  applyReset,
  forcedLockupMessage,
  resetClearsPendingQueue,
  staleAction,
  STALE_AFTER_MS,
} from "./durability";

const fourHours = STALE_AFTER_MS;
const row = { bundleCid: "bafk", createdAt: 0 };

const retry = staleAction(row, fourHours + 1, true);
if (retry?.action !== "retry") {
  throw new Error("queued pieces with bundle bytes must be re-uploaded after 4h");
}

const stale = staleAction(row, fourHours + 1, false);
if (stale?.action !== "stale" || !stale.reason.includes("not in store")) {
  throw new Error("queued pieces without bundle bytes must be flagged stale after 4h");
}

if (staleAction(row, fourHours - 1, false) !== null) {
  throw new Error("fresh pieces must not be flagged stale");
}

const windowMs = 3600_000;
if (staleAction(row, windowMs + 1, false, windowMs) !== null) {
  throw new Error("pieces waiting out the add-batch window must not be flagged stale");
}

if (!resetClearsPendingQueue()) {
  throw new Error("admin reset must clear pending_adds");
}

const after = applyReset({ pending_adds: [{ id: 1 }], refs: [{ name: "main" }] });
if ((after.pending_adds ?? []).length !== 0) {
  throw new Error("applyReset must empty pending_adds");
}
if ((RESET_TABLES as readonly string[]).includes("pending_adds") === false) {
  throw new Error("RESET_TABLES must list pending_adds");
}
if ((RESET_TABLES as readonly string[]).includes("objects") === false) {
  throw new Error("RESET_TABLES must list objects");
}
if ((RESET_TABLES as readonly string[]).includes("pieces") === false) {
  throw new Error("RESET_TABLES must list pieces");
}
if ((RESET_TABLES as readonly string[]).includes("file_pieces") === false) {
  throw new Error("RESET_TABLES must list file_pieces");
}

if (!forcedLockupMessage("lockup").startsWith("InsufficientLockupFunds:")) {
  throw new Error("forced lockup message must be readable");
}
