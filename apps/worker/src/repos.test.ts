//! Unpaid (3) vs paid (100) vs admin (unlimited) repo create limits.

import { MAX_REPOS_PAID, MAX_REPOS_UNPAID, repoCreateLimit, repoLimitError } from "./repos";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

ok(MAX_REPOS_UNPAID === 3, "unpaid cap is 3");
ok(MAX_REPOS_PAID === 100, "paid cap is 100");
ok(repoCreateLimit(true, false) === null, "admin unpaid unlimited");
ok(repoCreateLimit(true, true) === null, "admin paid unlimited");
ok(repoCreateLimit(false, false) === 3, "unpaid non-admin is 3");
ok(repoCreateLimit(false, true) === 100, "paid non-admin is 100");

const unpaidDenied = repoCreateLimit(false, false)!;
ok(3 >= unpaidDenied, "3 owned hits unpaid cap");
ok(2 < unpaidDenied, "2 owned is under unpaid cap");
const unpaidErr = repoLimitError(unpaidDenied);
ok(unpaidErr.error === "repo limit reached" && unpaidErr.limit === 3, "unpaid error names the cap");

const paidDenied = repoCreateLimit(false, true)!;
ok(100 >= paidDenied, "100 owned hits paid cap");
ok(3 < paidDenied, "3 owned is under paid cap");
ok(99 < paidDenied, "99 owned is under paid cap");
const paidErr = repoLimitError(paidDenied);
ok(paidErr.error === "repo limit reached" && paidErr.limit === 100, "paid error names the cap");

ok(repoCreateLimit(true, false) === null, "admin never uses a numeric cap");

console.log("repos ok");
