import { d1All, dbOrgs, type D1Env } from "./db";

export type Actor = {
  userId: string;
  name: string;
  admin: boolean;
};

export async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadActor(env: D1Env, request: Request): Promise<Actor | null> {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/Bearer (.+)/i);
  if (!m) return null;
  const tokenHash = await sha256Hex(m[1]!);
  // Minimal lookup against orgs DB users/tokens view if present; otherwise deny.
  try {
    const rows = await d1All<{ user_id: string; name: string; admin: number }>(
      dbOrgs(env),
      `SELECT u.id as user_id, u.name as name, u.admin as admin
         FROM tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked = 0
        LIMIT 1`,
      [tokenHash]
    );
    const u = rows[0];
    if (!u) return null;
    return { userId: u.user_id, name: u.name, admin: u.admin === 1 };
  } catch {
    return null;
  }
}
