import { d1All, dbOrgs, type D1Env } from "./db";

export async function isRepoOwner(env: D1Env, org: string, repo: string, userId: string): Promise<boolean> {
  try {
    const rows = await d1All<{ ok: number }>(dbOrgs(env), "SELECT 1 as ok FROM repo_owners WHERE org = ? AND repo = ? AND user_id = ? LIMIT 1", [
      org,
      repo,
      userId,
    ]);
    return rows.length > 0;
  } catch {
    return false;
  }
}
