import {
  acceptInviteBatch,
  CANCEL_INVITE_SQL,
  DECLINE_INVITE_SQL,
  DELETE_MEMBER_SQL,
  DEMOTE_OWNER_SQL,
  PROMOTE_OWNER_SQL,
} from "./cas";
import { d1All, d1Run, dbTop, nowMs, type D1Env } from "./db";
import type { Actor } from "./authz";
import { forbidden, orgCanAdmin } from "./authz";

type Env = D1Env;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const MEMBERS_LIST = /^\/v1\/orgs\/([^/]+)\/members$/;
const MEMBERS_ONE = /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/;
const INVITES_LIST = /^\/v1\/orgs\/([^/]+)\/invitations$/;
const INVITES_ONE = /^\/v1\/orgs\/([^/]+)\/invitations\/([^/]+)(?:\/(accept|decline))?$/;

type MemberRow = { org_id: string; user_id: string; role: string; can_write: number; created_at: number; name: string };

async function isLastOwner(db: D1Database, org: string, username: string): Promise<boolean> {
  const rows = await d1All<{ role: string }>(db, "SELECT role FROM memberships WHERE org_id = ? ORDER BY role", [org]);
  const owners = rows.filter((r) => r.role === "owner").length;
  if (owners <= 1) {
    // If demoting/removing the last remaining owner, block
    const one = await d1All<{ role: string }>(db, "SELECT role FROM memberships m JOIN users u ON u.id = m.user_id WHERE org_id = ? AND u.name = ? LIMIT 1", [org, username]);
    return (one[0]?.role ?? "") === "owner";
  }
  return false;
}

export async function handleOrgMembersAndInvites(
  request: Request,
  env: Env,
  path: string,
  actor: Actor | null
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const db = dbTop(env);

  // ----- Members list -----
  const list = path.match(MEMBERS_LIST);
  if (list) {
    const org = decodeURIComponent(list[1]!);
    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    // Allow org admins/owners and members to view; anonymous/outsiders forbidden
    if (!actor) return json({ error: "unauthorized" }, 401);
    const canAdmin = await orgCanAdmin(env, org, actor);
    const member = canAdmin
      ? true
      : (await d1All<{ ok: number }>(db, "SELECT 1 as ok FROM memberships WHERE org_id = ? AND user_id = ? LIMIT 1", [
          org,
          actor.userId,
        ])).length > 0;
    if (!member) return forbidden();
    const rows = await d1All<MemberRow>(
      db,
      "SELECT m.org_id, m.user_id, m.role, m.can_write, m.created_at, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name",
      [org]
    );
    return json({
      members: rows.map((r) => ({
        user: r.name,
        role: r.role,
        can_write: r.can_write === 1,
        created_at: r.created_at,
      })),
    });
  }

  // ----- Invitations -----
  const invList = path.match(INVITES_LIST);
  if (invList) {
    const org = decodeURIComponent(invList[1]!);
    if (!actor) return json({ error: "unauthorized" }, 401);
    if (method === "GET") {
      if (!(await orgCanAdmin(env, org, actor))) return forbidden();
      const rows = await d1All<{
        id: string;
        org_id: string;
        invitee_user_id: string;
        invited_by: string;
        role: string;
        state: string;
        created_at: number;
        responded_at: number | null;
        invitee: string;
        inviter: string;
      }>(
        db,
        `SELECT i.*, iu.name as invitee, bu.name as inviter
         FROM org_invitations i
         JOIN users iu ON iu.id = i.invitee_user_id
         JOIN users bu ON bu.id = i.invited_by
         WHERE i.org_id = ?
         ORDER BY i.created_at DESC`,
        [org]
      ).catch(() => []);
      return json({
        invitations: rows.map((r) => ({
          id: r.id,
          username: r.invitee,
          role: r.role,
          invited_by: r.inviter,
          state: r.state,
          created_at: r.created_at,
          responded_at: r.responded_at ?? null,
        })),
      });
    }
    if (method === "POST") {
      if (!(await orgCanAdmin(env, org, actor))) return forbidden();
      let b: Record<string, unknown>;
      try {
        b = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const username = typeof b.username === "string" ? b.username.trim() : typeof b.name === "string" ? b.name.trim() : "";
      if (!username) return json({ error: "username is required" }, 400);
      const role = typeof b.role === "string" && (b.role === "owner" || b.role === "member") ? b.role : "member";
      const users = await d1All<{ id: string }>(db, "SELECT id FROM users WHERE name = ? LIMIT 1", [username]);
      if (!users[0]) return json({ error: "unknown user" }, 404);
      const invitee = users[0].id;
      // Already a member?
      const mem = await d1All<{ ok: number }>(
        db,
        "SELECT 1 as ok FROM memberships WHERE org_id = ? AND user_id = ? LIMIT 1",
        [org, invitee]
      );
      if (mem[0]) return json({ error: "already a member" }, 409);
      // Create or reuse pending
      const id = crypto.randomUUID();
      const t = nowMs();
      try {
        await d1Run(
          db,
          `INSERT INTO org_invitations (id, org_id, invitee_user_id, invited_by, role, state, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          [id, org, invitee, actor.userId, role, t]
        );
      } catch {
        // Unique constraint on pending may conflict; return the existing one
        const rows = await d1All<{ id: string }>(
          db,
          "SELECT id FROM org_invitations WHERE org_id = ? AND invitee_user_id = ? AND state = 'pending' LIMIT 1",
          [org, invitee]
        ).catch(() => []);
        if (rows[0]) return json({ id: rows[0].id, reused: true }, 200);
        return json({ error: "invite unavailable" }, 500);
      }
      return json({ id, org, username, role, state: "pending", created_at: t }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  const invOne = path.match(INVITES_ONE);
  if (invOne) {
    const org = decodeURIComponent(invOne[1]!);
    const id = decodeURIComponent(invOne[2]!);
    const action = invOne[3] ?? "";
    const rows = await d1All<{ invitee_user_id: string; state: string; role: string }>(
      db,
      "SELECT invitee_user_id, state, role FROM org_invitations WHERE id = ? AND org_id = ? LIMIT 1",
      [id, org]
    ).catch(() => []);
    const inv = rows[0];
    if (!inv) return json({ error: "not found" }, 404);
    if (method === "DELETE") {
      if (!actor) return json({ error: "unauthorized" }, 401);
      if (!(await orgCanAdmin(env, org, actor))) return forbidden();
      if (inv.state !== "pending") return json({ error: "not pending" }, 409);
      const cancelled = await d1Run(db, CANCEL_INVITE_SQL, [nowMs(), id]);
      if (cancelled.changes !== 1) return json({ error: "not pending" }, 409);
      return json({ ok: true });
    }
    if (method === "POST" && (action === "accept" || action === "decline")) {
      if (!actor) return json({ error: "unauthorized" }, 401);
      if (actor.userId !== inv.invitee_user_id) return forbidden();
      if (inv.state !== "pending") return json({ error: "not pending" }, 409);
      const t = nowMs();
      if (action === "decline") {
        const declined = await d1Run(db, DECLINE_INVITE_SQL, [t, id]);
        if (declined.changes !== 1) return json({ error: "not pending" }, 409);
        return json({ ok: true });
      }
      // Accept: membership + invite state in one D1 batch (same database).
      const canWrite = inv.role === "owner" ? 1 : 0;
      const batch = await acceptInviteBatch(db, org, actor.userId, inv.role, canWrite, id, t);
      if ((batch[1]?.changes ?? 0) !== 1) return json({ error: "not pending" }, 409);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // ----- Member mutate -----
  const one = path.match(MEMBERS_ONE);
  if (one) {
    const org = decodeURIComponent(one[1]!);
    const username = decodeURIComponent(one[2]!);
    if (!actor) return json({ error: "unauthorized" }, 401);
    if (!(await orgCanAdmin(env, org, actor))) return forbidden();
    // Resolve user id
    const rows = await d1All<{ id: string }>(db, "SELECT id FROM users WHERE name = ? LIMIT 1", [username]);
    const user = rows[0];
    if (!user) return json({ error: "unknown user" }, 404);
    if (request.method.toUpperCase() === "PATCH") {
      let b: Record<string, unknown>;
      try {
        b = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const role = typeof b.role === "string" && (b.role === "owner" || b.role === "member") ? b.role : "";
      if (!role) return json({ error: "role must be owner or member" }, 400);
      if (role === "member" && (await isLastOwner(db, org, username))) {
        return json({ error: "cannot remove the last owner" }, 409);
      }
      const wrote =
        role === "owner"
          ? await d1Run(db, PROMOTE_OWNER_SQL, [org, user.id])
          : await d1Run(db, DEMOTE_OWNER_SQL, [org, user.id]);
      if (wrote.changes !== 1) {
        return json({ error: role === "member" ? "cannot remove the last owner" : "not a member" }, 409);
      }
      return json({ ok: true, user: username, role });
    }
    if (request.method.toUpperCase() === "DELETE") {
      if (await isLastOwner(db, org, username)) {
        return json({ error: "cannot remove the last owner" }, 409);
      }
      const wrote = await d1Run(db, DELETE_MEMBER_SQL, [org, user.id, org]);
      if (wrote.changes !== 1) return json({ error: "cannot remove the last owner" }, 409);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}

