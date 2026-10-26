//! Entry: stub Cloudflare Container, boot harness, run the HTTP suite.

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL(new URL("./loader.mjs", import.meta.url)));

const { startHarness } = await import("./harness.ts");
const { runSuite } = await import("./suite.ts");

function printCiEnv(): void {
  const keys = [
    "CI",
    "SCN_CI",
    "SCN_JOB",
    "SCN_CHANGESET",
    "SCN_REPO",
    "GITHUB_ACTIONS",
    "GITHUB_SHA",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_JOB",
    "GITHUB_WORKSPACE",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_RUN_ID",
  ];
  console.log("CI env:");
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) console.log(`  ${k}=${v}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  printCiEnv();
  const harness = await startHarness();
  console.log(`worker ${harness.workerUrl}`);
  console.log(`engine ${harness.engineUrl}`);
  console.log("auth: Rust /__internal/auth/hash|verify (Argon2). Worker is D1 + proxy.");
  console.log("PDP keys unset: add/remove-pieces and uploads stay mock (no write wallet).");
  console.log("");
  try {
    await runSuite(harness);
  } finally {
    await harness.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
