//! Tag names, immutability, and who may delete.

import { tagDeleteAllowed, validateTagCreate, TAG_NAME_RE } from "./tags";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

const id = "ab".repeat(32);
ok(TAG_NAME_RE.test("v1.2.0") && !TAG_NAME_RE.test("../etc"), "tag name shape");

const created = validateTagCreate(null, { name: "v1", target: id, message: "ship it" });
ok(created.ok && created.message === "ship it", "annotated create");
const again = validateTagCreate({ target: id }, { name: "v1", target: id });
ok(!again.ok && again.status === 409 && again.error === "tag exists", "same target is immutable");
const moved = validateTagCreate({ target: id }, { name: "v1", target: "cd".repeat(32) });
ok(!moved.ok && moved.status === 409, "different target is rejected");
const bad = validateTagCreate(null, { name: "v1", target: "not-a-changeset" });
ok(!bad.ok && bad.status === 400, "target must be a changeset id");
ok(!JSON.stringify(created).includes("bafy") && !JSON.stringify(created).includes("piece"), "tag body has no piece cid");

ok(tagDeleteAllowed({ admin: true, owner: false, username: "x", codeowners: "" }), "admin");
ok(tagDeleteAllowed({ admin: false, owner: true, username: "x", codeowners: "" }), "owner");
ok(tagDeleteAllowed({ admin: false, owner: false, username: "Ada", codeowners: "* @ada\n" }), "codeowners");
ok(!tagDeleteAllowed({ admin: false, owner: false, username: "ada", codeowners: "# @ada\n*.rs @bob\n" }), "comment is not an owner");
ok(!tagDeleteAllowed({ admin: false, owner: false, username: "ada", codeowners: "" }), "stranger");

console.log("tags ok");
