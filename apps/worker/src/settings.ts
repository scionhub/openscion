import { d1All, d1Run, dbOrgs, type D1Env } from "./db";

export type RepoSettings = { protectMain: boolean; requiredApprovals: number; requiredChecks: string[] };
export const DEFAULT_SETTINGS: RepoSettings = { protectMain: false, requiredApprovals: 1, requiredChecks: [] };
export const CHECK_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_REQUIRED_CHECKS = 20;
export const MAX_REQUIRED_APPROVALS = 10;

export async function getRepoSettings(env: D1Env, org: string, repo: string): Promise<RepoSettings> {
  try {
    const rows = await d1All<{ protect_main: number; required_approvals: number; required_checks?: string }>(
      dbOrgs(env),
      "SELECT * FROM repo_settings WHERE org = ? AND repo = ? LIMIT 1",
      [org, repo]
    );
    const r = rows[0];
    if (!r) return { ...DEFAULT_SETTINGS, requiredChecks: [] };
    return {
      protectMain: Number(r.protect_main) === 1,
      requiredApprovals: clampApprovals(r.required_approvals),
      requiredChecks: parseRequiredChecks(r.required_checks),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, requiredChecks: [] };
  }
}

export function parseRequiredChecks(raw: unknown): string[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && CHECK_NAME_RE.test(x)) : [];
  } catch {
    return [];
  }
}

export function clampApprovals(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, MAX_REQUIRED_APPROVALS);
}

export async function saveRepoSettings(env: D1Env, org: string, repo: string, s: RepoSettings, actor: { name: string }): Promise<void> {
  await d1Run(
    dbOrgs(env),
    `INSERT INTO repo_settings (org, repo, protect_main, required_approvals, required_checks, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org, repo) DO UPDATE SET protect_main = excluded.protect_main,
       required_approvals = excluded.required_approvals, required_checks = excluded.required_checks,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [org, repo, s.protectMain ? 1 : 0, s.requiredApprovals, JSON.stringify(s.requiredChecks ?? []), actor.name, Date.now()]
  );
}
