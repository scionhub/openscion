import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import setupWasm from "argon2id/lib/setup.js";
import {
  encodeArgon2idPhc,
  parseArgon2idPhc,
  timingSafeEqual,
  verifyArgon2Password,
  hashPasswordArgon2id,
  setArgon2idComputeLoaderForTests,
} from "./password";

const here = path.dirname(fileURLToPath(import.meta.url));

function instantiateBytes(bytes: Uint8Array) {
  return async (imports: WebAssembly.Imports) => {
    const result = await WebAssembly.instantiate(bytes, imports);
    if (result instanceof WebAssembly.Instance) {
      return { instance: result, module: new WebAssembly.Module(bytes) };
    }
    return result;
  };
}

async function installNodeLoader() {
  const simd = new Uint8Array(readFileSync(path.join(here, "wasm/argon2id-simd.wasm")));
  const nosimd = new Uint8Array(readFileSync(path.join(here, "wasm/argon2id-no-simd.wasm")));
  const compute = await setupWasm(instantiateBytes(simd), instantiateBytes(nosimd));
  setArgon2idComputeLoaderForTests(async () => compute);
}

function testParseEncodeRoundTrip() {
  const salt = new Uint8Array(16).fill(7);
  const digest = new Uint8Array(32).fill(9);
  const phc = encodeArgon2idPhc(salt, digest, { memorySize: 19456, passes: 2, parallelism: 1 });
  assert.equal(phc.split("$").length, 6);
  assert.ok(phc.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"));
  assert.equal(phc.length, 97);
  const parsed = parseArgon2idPhc(phc);
  assert.equal(parsed.memorySize, 19456);
  assert.equal(parsed.passes, 2);
  assert.equal(parsed.parallelism, 1);
  assert.ok(timingSafeEqual(parsed.salt, salt));
  assert.ok(timingSafeEqual(parsed.digest, digest));
}

async function testHashAndVerify() {
  const phc = await hashPasswordArgon2id("signup-test-password-xyz");
  assert.ok(phc.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"));
  assert.equal(phc.length, 97);
  assert.equal(await verifyArgon2Password("signup-test-password-xyz", phc), true);
  assert.equal(await verifyArgon2Password("nope", phc), false);
}

async function testRustCompatibleVector() {
  const phc = await hashPasswordArgon2id("compat-test-password-12345");
  const parsed = parseArgon2idPhc(phc);
  assert.equal(parsed.salt.length, 16);
  assert.equal(parsed.digest.length, 32);
  assert.equal(await verifyArgon2Password("compat-test-password-12345", phc), true);
}

await installNodeLoader();
testParseEncodeRoundTrip();
await testHashAndVerify();
await testRustCompatibleVector();
setArgon2idComputeLoaderForTests(null);
console.log("password.test.ts: ok");
