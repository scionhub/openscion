//! Public profiles (`tagline`), paid flag, and password change.

import { d1All, d1Run, dbTop, type D1Env } from "./db";
import type { Actor } from "./authz";

export const TAGLINE_MAX = 200;

type Env = D1Env;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Engine Argon2 hash/verify. The Worker never hashes locally. */
export type PasswordEngine = {
  hash(
    password: string
  ): Promise<{ ok: true; hash: string } | { ok: false; response: Response }>;
  verify(
    password: string,
    password_hash: string
  ): Promise<{ ok: true; valid: boolean } | { ok: false; response: Response }>;
};

export type UserProfileRow = {
  id: string;
  name: string;
  admin: number;
  tagline?: string | null;
  paid?: number;
  password_hash?: string;
  email?: string | null;
};

/** Trim `tagline`; reject non-strings and values longer than 200. Empty clears. */
export function parseTagline(
  value: unknown
): { ok: true; tagline: string } | { ok: false; status: 400; error: string } {
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: "tagline must be a string" };
  }
  const tagline = value.trim();
  if (tagline.length > TAGLINE_MAX) {
    return { ok: false, status: 400, error: "tagline must be at most 200 characters" };
  }
  return { ok: true, tagline };
}

/** `paid` must be a boolean. */
export function parsePaid(
  value: unknown
): { ok: true; paid: boolean } | { ok: false; status: 400; error: string } {
  if (typeof value !== "boolean") {
    return { ok: false, status: 400, error: "paid must be a boolean" };
  }
  return { ok: true, paid: value };
}

/**
 * Public user JSON. Never includes `password_hash`, `email`, or `paid`.
 * `tagline` is `""` when unset.
 */
export function publicUserJson(row: UserProfileRow): {
  name: string;
  tagline: string;
  admin: boolean;
} {
  return {
    name: row.name,
    tagline: row.tagline ?? "",
    admin: row.admin === 1,
  };
}

/** Signed-in `/v1/me` user object (includes `paid`). */
export function meUserJson(
  actor: Actor,
  profile: { tagline: string; paid: boolean }
): { id: string; name: string; admin: boolean; tagline: string; paid: boolean } {
  return {
    id: actor.userId,
    name: actor.name,
    admin: actor.admin,
    tagline: profile.tagline,
    paid: profile.paid,
  };
}

/**
 * Who may apply which fields on `PATCH /v1/users/:name` (or `/v1/me`).
 * Tagline is self-only. `paid` is site-admin only.
 */
export function profilePatchDenied(
  actor: Actor | null,
  targetName: string,
  patch: { tagline?: boolean; paid?: boolean }
): 401 | 403 | null {
  if (!actor) return 401;
  if (patch.paid && !actor.admin) return 403;
  if (patch.tagline && actor.name !== targetName) return 403;
  return null;
}

export function parseChangePassword(
  body: unknown
):
  | { ok: true; current_password: string; new_password: string }
  | { ok: false; status: 400; error: string } {
  if (body === null || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid JSON" };
  }
  const rec = body as { current_password?: unknown; new_password?: unknown };
  if (typeof rec.current_password !== "string" || typeof rec.new_password !== "string") {
    return { ok: false, status: 400, error: "current_password and new_password required" };
  }
  if (rec.current_password.length === 0) {
    return { ok: false, status: 400, error: "current_password and new_password required" };
  }
  if (rec.new_password.length < 10) {
    return { ok: false, status: 400, error: "password must be at least 10 characters" };
  }
  return {
    ok: true,
    current_password: rec.current_password,
    new_password: rec.new_password,
  };
}

/** Wrong current password is 403; engine/hash failures pass their Response through. */
export async function applyChangePassword(
  storedHash: string,
  current: string,
  next: string,
  crypto: PasswordEngine
): Promise<{ ok: true; password_hash: string } | { ok: false; response: Response }> {
  const verified = await crypto.verify(current, storedHash);
  if (!verified.ok) return verified;
  if (!verified.valid) {
    return { ok: false, response: json({ error: "current password is incorrect" }, 403) };
  }
  const hashed = await crypto.hash(next);
  if (!hashed.ok) return hashed;
  return { ok: true, password_hash: hashed.hash };
}

export async function loadUserProfile(
  db: D1Database,
  userId: string
): Promise<{ tagline: string; paid: boolean }> {
  try {
    const rows = await d1All<{ tagline: string | null; paid: number }>(
      db,
      "SELECT tagline, paid FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    const row = rows[0];
    return { tagline: row?.tagline ?? "", paid: row?.paid === 1 };
  } catch {
    return { tagline: "", paid: false };
  }
}

export async function userIsPaid(db: D1Database, userId: string): Promise<boolean> {
  try {
    const rows = await d1All<{ paid: number }>(
      db,
      "SELECT paid FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    return rows[0]?.paid === 1;
  } catch {
    return false;
  }
}

async function loadUserByName(db: D1Database, name: string): Promise<UserProfileRow | null> {
  try {
    const rows = await d1All<UserProfileRow>(
      db,
      "SELECT id, name, admin, tagline, paid FROM users WHERE name = ? LIMIT 1",
      [name]
    );
    return rows[0] ?? null;
  } catch {
    const rows = await d1All<UserProfileRow>(
      db,
      "SELECT id, name, admin FROM users WHERE name = ? LIMIT 1",
      [name]
    );
    return rows[0] ?? null;
  }
}

/**
 * `GET /v1/users/:name` — public `{ name, tagline, admin }`.
 * `PATCH /v1/me` — self `{ tagline }`.
 * `PATCH /v1/users/:name` — self `{ tagline }` and/or admin `{ paid }`.
 */
export async function handleUserProfile(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" && path === "/v1/me") {
    return patchOwnTagline(request, env, actor);
  }
  const userMatch = path.match(/^\/v1\/users\/([^/]+)$/);
  if (!userMatch) return null;
  const name = decodeURIComponent(userMatch[1]!).trim().toLowerCase();
  if (method === "GET") {
    return getPublicUser(env, name);
  }
  if (method === "PATCH") {
    return patchUser(request, env, actor, name);
  }
  return null;
}

/** `POST /v1/auth/change-password` (Bearer + current/new password). */
export async function handleChangePassword(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null,
  crypto: PasswordEngine
): Promise<Response | null> {
  if (request.method.toUpperCase() !== "POST" || path !== "/v1/auth/change-password") {
    return null;
  }
  if (!actor) return json({ error: "unauthorized" }, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = parseChangePassword(body);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);

  const db = dbTop(env);
  let rows: { password_hash: string }[];
  try {
    rows = await d1All<{ password_hash: string }>(
      db,
      "SELECT password_hash FROM users WHERE id = ? LIMIT 1",
      [actor.userId]
    );
  } catch {
    return json({ error: "not found" }, 404);
  }
  const stored = rows[0]?.password_hash;
  if (!stored) return json({ error: "not found" }, 404);

  const applied = await applyChangePassword(
    stored,
    parsed.current_password,
    parsed.new_password,
    crypto
  );
  if (!applied.ok) return applied.response;
  await d1Run(db, "UPDATE users SET password_hash = ? WHERE id = ?", [
    applied.password_hash,
    actor.userId,
  ]);
  return json({ ok: true });
}

async function getPublicUser(env: Env, name: string): Promise<Response> {
  const row = await loadUserByName(dbTop(env), name);
  if (!row) return json({ error: "not found" }, 404);
  return json(publicUserJson(row));
}

async function patchOwnTagline(
  request: Request,
  env: Env,
  actor: Actor | null
): Promise<Response> {
  if (!actor) return json({ error: "unauthorized" }, 401);
  let body: { tagline?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "tagline")) {
    return json({ error: "tagline required" }, 400);
  }
  const parsed = parseTagline(body.tagline);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const stored = parsed.tagline.length === 0 ? null : parsed.tagline;
  try {
    await d1Run(dbTop(env), "UPDATE users SET tagline = ? WHERE id = ?", [stored, actor.userId]);
  } catch {
    return json({ error: "tagline column missing" }, 500);
  }
  return json({
    user: meUserJson(actor, {
      tagline: parsed.tagline,
      paid: await userIsPaid(dbTop(env), actor.userId),
    }),
  });
}

async function patchUser(
  request: Request,
  env: Env,
  actor: Actor | null,
  name: string
): Promise<Response> {
  if (!actor) return json({ error: "unauthorized" }, 401);
  let body: { tagline?: unknown; paid?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const hasTagline = Object.prototype.hasOwnProperty.call(body, "tagline");
  const hasPaid = Object.prototype.hasOwnProperty.call(body, "paid");
  if (!hasTagline && !hasPaid) {
    return json({ error: "tagline or paid required" }, 400);
  }
  const denied = profilePatchDenied(actor, name, { tagline: hasTagline, paid: hasPaid });
  if (denied === 401) return json({ error: "unauthorized" }, 401);
  if (denied === 403) return json({ error: "forbidden" }, 403);

  const db = dbTop(env);
  const existing = await loadUserByName(db, name);
  if (!existing) return json({ error: "not found" }, 404);

  let tagline = existing.tagline ?? "";
  let paid = existing.paid === 1;
  if (hasTagline) {
    const parsed = parseTagline(body.tagline);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    tagline = parsed.tagline;
    const stored = tagline.length === 0 ? null : tagline;
    await d1Run(db, "UPDATE users SET tagline = ? WHERE id = ?", [stored, existing.id]);
  }
  if (hasPaid) {
    const parsed = parsePaid(body.paid);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    paid = parsed.paid;
    await d1Run(db, "UPDATE users SET paid = ? WHERE id = ?", [paid ? 1 : 0, existing.id]);
  }

  if (actor.name === name) {
    return json({ user: meUserJson(actor, { tagline, paid }) });
  }
  return json({
    user: { name: existing.name, tagline, admin: existing.admin === 1, paid },
  });
}
