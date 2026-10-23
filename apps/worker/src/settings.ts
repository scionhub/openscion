import { d1All, d1Run, dbOrgs, type D1Env } from "./db";
import type { Actor } from "./authz";

export type RepoSettings = { protectMain: boolean; requiredApprovals: number };
export const DEFAULT_SETTINGS: RepoSettings = { protectMain: false, requiredApprovals: 1 };
export const MAX_REQUIRED_APPROVALS = 10;
export const PROTECTED_MAIN_MESSAGE = "main is protected; open a pull request";

export async function getRepoSettings(env: D1Env, org: string, repo: string): Promise<RepoSettings> {
  try {
    const rows = await d1All<{ protect_main: number; required_approvals: number }>(
      dbOrgs(env),
      "SELECT protect_main, required_approvals FROM repo_settings WHERE org = ? AND repo = ? LIMIT 1",
      [org, repo]
    );
    const r = rows[0];
    if (!r) return { ...DEFAULT_SETTINGS };
    return { protectMain: Number(r.protect_main) === 1, requiredApprovals: clampApprovals(r.required_approvals) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Required approvals is always at least 1 (cannot be turned off). */
export function clampApprovals(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, MAX_REQUIRED_APPROVALS);
}

/** Validates a settings update body; returns the merged settings or an error. */
export function applySettingsPatch(
  current: RepoSettings,
  body: unknown
): { ok: true; settings: RepoSettings } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "JSON object body required" };
  const b = body as Record<string, unknown>;
  const next = { ...current };
  if ("protectMain" in b) {
    if (typeof b.protectMain !== "boolean") return { ok: false, error: "protectMain must be a boolean" };
    next.protectMain = b.protectMain;
  }
  if ("requiredApprovals" in b) {
    const v = Number(b.requiredApprovals);
    if (!Number.isInteger(v) || v < 1 || v > MAX_REQUIRED_APPROVALS) {
      return { ok: false, error: `requiredApprovals must be an integer from 1 to ${MAX_REQUIRED_APPROVALS} (approval is always required)` };
    }
    next.requiredApprovals = v;
  }
  return { ok: true, settings: next };
}

export async function saveRepoSettings(env: D1Env, org: string, repo: string, s: RepoSettings, actor: Actor): Promise<void> {
  await d1Run(
    dbOrgs(env),
    `INSERT INTO repo_settings (org, repo, protect_main, required_approvals, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org, repo) DO UPDATE SET protect_main = excluded.protect_main,
       required_approvals = excluded.required_approvals, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [org, repo, s.protectMain ? 1 : 0, s.requiredApprovals, actor.name, Date.now()]
  );
}

/** True when a ref name (short or full) is main. */
export function isMainRef(name: string): boolean {
  return name.replace(/^refs\/heads\//, "").replace(/^heads\//, "") === "main";
}

/** Path of a direct ref write: /v1/repos/{o}/{r}/refs/{name} → [org, repo, name]. */
export function refWriteTarget(path: string): [string, string, string] | null {
  const m = path.match(/^\/v1\/repos\/([^/]+)\/([^/]+)\/refs\/(.+)$/);
  return m ? [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), decodeURIComponent(m[3]!)] : null;
}
