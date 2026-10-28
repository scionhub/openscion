//! Tagline CRUD, public user GET, and change-password happy / wrong-current.

import type { Actor } from "./authz";
import {
  applyChangePassword,
  handleChangePassword,
  handleUserProfile,
  meUserJson,
  parseChangePassword,
  parsePaid,
  parseTagline,
  profilePatchDenied,
  publicUserJson,
  TAGLINE_MAX,
} from "./users";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

const alice: Actor = { userId: "u-alice", name: "alice", admin: false };
const admin: Actor = { userId: "u-admin", name: "root", admin: true };

const parsed = parseTagline("  hello world  ");
ok(parsed.ok && parsed.tagline === "hello world", "tagline trims");
ok(parseTagline("").ok && parseTagline("").ok && (parseTagline("") as { tagline: string }).tagline === "", "empty clears");
ok(!parseTagline("x".repeat(TAGLINE_MAX + 1)).ok, "rejects longer than 200");
ok(parseTagline("x".repeat(TAGLINE_MAX)).ok, "200 chars ok");
ok(!parseTagline(1).ok, "non-string tagline");
ok(parsePaid(true).ok && parsePaid(false).ok, "paid bool");
ok(!parsePaid("true").ok && !parsePaid(1).ok, "paid must be boolean");

const pub = publicUserJson({
  id: "u-alice",
  name: "alice",
  admin: 0,
  tagline: "hi",
  paid: 1,
  password_hash: "secret-hash",
  email: "alice@example.com",
});
ok(pub.name === "alice" && pub.tagline === "hi" && pub.admin === false, "public fields");
ok(!("password_hash" in pub) && !("email" in pub) && !("paid" in pub), "public omits secrets");
ok(publicUserJson({ id: "u", name: "bob", admin: 1 }).tagline === "", "null tagline is empty");

const me = meUserJson(alice, { tagline: "hi", paid: true });
ok(me.id === "u-alice" && me.tagline === "hi" && me.paid === true && me.admin === false, "me includes paid");

ok(profilePatchDenied(null, "alice", { tagline: true }) === 401, "anon patch");
ok(profilePatchDenied(alice, "alice", { tagline: true }) === null, "self tagline");
ok(profilePatchDenied(alice, "bob", { tagline: true }) === 403, "other tagline");
ok(profilePatchDenied(alice, "alice", { paid: true }) === 403, "non-admin paid");
ok(profilePatchDenied(admin, "alice", { paid: true }) === null, "admin paid");
ok(profilePatchDenied(admin, "alice", { tagline: true }) === 403, "admin cannot set others' tagline");
ok(profilePatchDenied(admin, "root", { tagline: true, paid: true }) === null, "admin self both");

ok(!parseChangePassword(null).ok && !parseChangePassword({}).ok, "change-password required");
ok(!parseChangePassword({ current_password: "old-password", new_password: "short" }).ok, "new too short");
const pw = parseChangePassword({ current_password: "old-password", new_password: "new-password" });
ok(pw.ok && pw.ok && (pw as { new_password: string }).new_password === "new-password", "change-password parses");

const wrong = await applyChangePassword("stored", "old-password", "new-password", {
  async verify() {
    return { ok: true, valid: false };
  },
  async hash() {
    throw new Error("hash must not run when current is wrong");
  },
});
ok(!wrong.ok && wrong.response.status === 403, "wrong current is 403");
if (wrong.ok) throw new Error("wrong current must fail");
const wrongBody = (await wrong.response.json()) as { error?: string };
ok(wrongBody.error === "current password is incorrect", "wrong-current message");

const happy = await applyChangePassword("stored", "old-password", "new-password", {
  async verify(password, hash) {
    ok(password === "old-password" && hash === "stored", "verify args");
    return { ok: true, valid: true };
  },
  async hash(password) {
    ok(password === "new-password", "hash new only");
    return { ok: true, hash: "new-hash" };
  },
});
ok(happy.ok && happy.password_hash === "new-hash", "happy change-password");

type UserRow = {
  id: string;
  name: string;
  admin: number;
  tagline: string | null;
  paid: number;
  password_hash: string;
  email: string | null;
};

function memoryTop(users: UserRow[]): D1Database {
  const exec = (sql: string, params: unknown[]): UserRow[] => {
    const s = sql.replace(/\s+/g, " ");
    if (/FROM users WHERE name = \?/.test(s)) {
      return users.filter((u) => u.name === params[0]);
    }
    if (/FROM users WHERE id = \?/.test(s)) {
      return users.filter((u) => u.id === params[0]);
    }
    if (/UPDATE users SET tagline = \?/.test(s)) {
      const u = users.find((x) => x.id === params[1]);
      if (u) u.tagline = params[0] as string | null;
      return [];
    }
    if (/UPDATE users SET paid = \?/.test(s)) {
      const u = users.find((x) => x.id === params[1]);
      if (u) u.paid = params[0] as number;
      return [];
    }
    if (/UPDATE users SET password_hash = \?/.test(s)) {
      const u = users.find((x) => x.id === params[1]);
      if (u) u.password_hash = params[0] as string;
      return [];
    }
    throw new Error(`unexpected sql: ${s}`);
  };
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            all: async () => ({ success: true, results: exec(sql, params) }),
            run: async () => {
              exec(sql, params);
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const rows: UserRow[] = [
  {
    id: "u-alice",
    name: "alice",
    admin: 0,
    tagline: null,
    paid: 0,
    password_hash: "phc-old",
    email: "alice@example.com",
  },
  {
    id: "u-bob",
    name: "bob",
    admin: 0,
    tagline: "hey",
    paid: 0,
    password_hash: "phc-bob",
    email: null,
  },
];
const env = { DB_SCIONHUB_TOP: memoryTop(rows) };

const missing = await handleUserProfile(
  new Request("https://x/v1/users/nobody"),
  env,
  "/v1/users/nobody",
  null
);
ok(missing?.status === 404, "unknown user 404");

const getPub = await handleUserProfile(
  new Request("https://x/v1/users/alice"),
  env,
  "/v1/users/alice",
  null
);
ok(getPub?.status === 200, "public get 200");
const got = (await getPub!.json()) as { name: string; tagline: string; admin: boolean; password_hash?: string };
ok(got.name === "alice" && got.tagline === "" && got.admin === false, "public empty tagline");
ok(got.password_hash === undefined, "public get omits hash");

const patched = await handleUserProfile(
  new Request("https://x/v1/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tagline: "  ships code  " }),
  }),
  env,
  "/v1/me",
  alice
);
ok(patched?.status === 200, "self patch tagline");
const after = (await patched!.json()) as { user: { tagline: string; paid: boolean } };
ok(after.user.tagline === "ships code" && after.user.paid === false, "tagline stored");

const tooLong = await handleUserProfile(
  new Request("https://x/v1/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tagline: "x".repeat(201) }),
  }),
  env,
  "/v1/me",
  alice
);
ok(tooLong?.status === 400, "tagline 201 is 400");

const cleared = await handleUserProfile(
  new Request("https://x/v1/users/alice", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tagline: "" }),
  }),
  env,
  "/v1/users/alice",
  alice
);
ok(cleared?.status === 200, "empty tagline clears");
const clearedBody = (await cleared!.json()) as { user: { tagline: string } };
ok(clearedBody.user.tagline === "", "cleared");

const other = await handleUserProfile(
  new Request("https://x/v1/users/bob", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tagline: "nope" }),
  }),
  env,
  "/v1/users/bob",
  alice
);
ok(other?.status === 403, "cannot patch other tagline");

const selfPaid = await handleUserProfile(
  new Request("https://x/v1/users/alice", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paid: true }),
  }),
  env,
  "/v1/users/alice",
  alice
);
ok(selfPaid?.status === 403, "non-admin cannot set paid");

const adminPaid = await handleUserProfile(
  new Request("https://x/v1/users/alice", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paid: true }),
  }),
  env,
  "/v1/users/alice",
  admin
);
ok(adminPaid?.status === 200, "admin sets paid");
const paidBody = (await adminPaid!.json()) as { user: { paid: boolean; name?: string } };
ok(paidBody.user.paid === true, "paid true");

const emailOnly = await handleUserProfile(
  new Request("https://x/v1/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "x@y.z" }),
  }),
  env,
  "/v1/me",
  alice
);
ok(emailOnly?.status === 400, "email-only patch is not an update");

const crypto = {
  async verify(password: string) {
    return { ok: true as const, valid: password === "old-password-ok" };
  },
  async hash(password: string) {
    return { ok: true as const, hash: `phc-${password}` };
  },
};

const badCurrent = await handleChangePassword(
  new Request("https://x/v1/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ current_password: "wrong-password", new_password: "new-password" }),
  }),
  env,
  "/v1/auth/change-password",
  alice,
  crypto
);
ok(badCurrent?.status === 403, "handler wrong current");

const goodPw = await handleChangePassword(
  new Request("https://x/v1/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ current_password: "old-password-ok", new_password: "new-password" }),
  }),
  env,
  "/v1/auth/change-password",
  alice,
  crypto
);
ok(goodPw?.status === 200, "handler happy change-password");
ok(rows[0]!.password_hash === "phc-new-password", "hash written to D1");

console.log("users ok");
