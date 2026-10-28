/** Pending-piece durability: stale after 4h, reset, and forced add-pieces errors. */

export const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

/** Tables the admin repo reset must wipe, including the on-chain add queue.
 * Child COMMP tables first so FK order is safe when enforcement is on.
 */
export const RESET_TABLES = [
  "file_pieces",
  "bundle_members",
  "pending_adds",
  "bundles",
  "pieces",
  "refs",
  "changesets",
  "objects",
] as const;

export type PendingRow = {
  bundleCid: string;
  createdAt: number;
  status?: string | null;
  reason?: string | null;
  attempts?: number;
};

export type StaleAction = "retry" | "stale";

export function staleAction(
  row: PendingRow,
  nowMs: number,
  bundleBytesAvailable: boolean,
  windowMs = 0
): { action: StaleAction; reason: string } | null {
  if (row.status === "stale") return null;
  // Items still inside the add-batch window are waiting, not stale.
  const minAge = Math.max(STALE_AFTER_MS, windowMs);
  if (nowMs - row.createdAt < minAge) return null;
  if (bundleBytesAvailable) {
    return {
      action: "retry",
      reason: "queued more than 4h; re-uploading bundle",
    };
  }
  return {
    action: "stale",
    reason: "queued more than 4h; bundle bytes not in store",
  };
}

export function forcedLockupMessage(kind = "lockup"): string {
  if (kind === "lockup" || kind === "InsufficientLockupFunds") {
    return "InsufficientLockupFunds: required 1.000000 USDFC, available 0.000000 USDFC (forced)";
  }
  return `forced add-pieces error: ${kind}`;
}

export function applyReset<T>(tables: Record<string, T[]>): Record<string, T[]> {
  const out: Record<string, T[]> = { ...tables };
  for (const name of RESET_TABLES) {
    out[name] = [];
  }
  return out;
}

export function resetClearsPendingQueue(): boolean {
  return (RESET_TABLES as readonly string[]).includes("pending_adds");
}
