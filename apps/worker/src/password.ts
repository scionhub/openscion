/**
 * Argon2id password hashing for Cloudflare Workers.
 *
 * hash-wasm (used previously) calls WebAssembly.compile() at runtime, which
 * Workers forbid ("Wasm code generation disallowed by embedder"). That made
 * every verify throw, the catch returned false, and login always answered
 * 403 invalid credentials — even for the correct password.
 *
 * This module uses argon2id via imported .wasm modules (WebAssembly.Module)
 * and WebAssembly.instantiate(module, imports), which Workers allow.
 */
import type { computeHash } from "argon2id/lib/setup.js";
import { base64 } from "rfc4648";

const HASH_PARAMS = {
  memorySize: 19456, // KiB — matches Rust argon2 0.5 Argon2::default()
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
} as const;

/** Override for tests (Node) that cannot import .wasm as WebAssembly.Module. */
let computeOverride: (() => Promise<computeHash>) | null = null;

export function setArgon2idComputeLoaderForTests(loader: (() => Promise<computeHash>) | null): void {
  computeOverride = loader;
}

async function getCompute(): Promise<computeHash> {
  if (computeOverride) return computeOverride();
  const { loadArgon2idCompute } = await import("./password_loader");
  return loadArgon2idCompute();
}

/** Constant-time equality for equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export type ParsedPhc = {
  algorithm: "argon2id";
  version: number;
  memorySize: number;
  passes: number;
  parallelism: number;
  salt: Uint8Array;
  digest: Uint8Array;
};

/** Parse a PHC argon2id string. Throws on unsupported/invalid input. */
export function parseArgon2idPhc(phc: string): ParsedPhc {
  if (!phc.startsWith("$")) throw new Error("not a PHC string");
  const parts = phc.slice(1).split("$");
  if (parts.length !== 5) throw new Error("invalid PHC segments");
  const [id, versionPart, paramsPart, saltB64, digestB64] = parts;
  if (id !== "argon2id") throw new Error(`unsupported algorithm: ${id}`);
  if (!versionPart || !versionPart.startsWith("v=")) throw new Error("missing version");
  const version = Number(versionPart.slice(2));
  if (version !== 19) throw new Error(`unsupported argon2 version: ${version}`);
  if (!paramsPart) throw new Error("missing params");
  const params = Object.fromEntries(
    paramsPart.split(",").map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return [p, ""];
      return [p.slice(0, eq), p.slice(eq + 1)];
    })
  ) as Record<string, string>;
  const memorySize = Number(params.m);
  const passes = Number(params.t);
  const parallelism = Number(params.p);
  if (![memorySize, passes, parallelism].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("invalid argon2 params");
  }
  if (!saltB64 || !digestB64) throw new Error("missing salt/digest");
  const salt = base64.parse(saltB64, { out: Uint8Array, loose: true });
  const digest = base64.parse(digestB64, { out: Uint8Array, loose: true });
  return { algorithm: "argon2id", version, memorySize, passes, parallelism, salt, digest };
}

/** Encode digest+params as a PHC argon2id string (no padding on salt/digest). */
export function encodeArgon2idPhc(
  salt: Uint8Array,
  digest: Uint8Array,
  params: { memorySize: number; passes: number; parallelism: number }
): string {
  return [
    "",
    "argon2id",
    "v=19",
    `m=${params.memorySize},t=${params.passes},p=${params.parallelism}`,
    base64.stringify(salt, { pad: false }),
    base64.stringify(digest, { pad: false }),
  ].join("$");
}

/** Verify a password against a PHC-formatted argon2id hash. */
export async function verifyArgon2Password(password: string, phc: string): Promise<boolean> {
  try {
    const parsed = parseArgon2idPhc(phc);
    const argon2id = await getCompute();
    const digest = argon2id({
      password: new TextEncoder().encode(password),
      salt: parsed.salt,
      parallelism: parsed.parallelism,
      passes: parsed.passes,
      memorySize: parsed.memorySize,
      tagLength: parsed.digest.length,
    });
    return timingSafeEqual(digest, parsed.digest);
  } catch {
    return false;
  }
}

/** Create a PHC-formatted argon2id hash for the given password. */
export async function hashPasswordArgon2id(password: string): Promise<string> {
  const salt = new Uint8Array(HASH_PARAMS.saltLength);
  crypto.getRandomValues(salt);
  const argon2id = await getCompute();
  const digest = argon2id({
    password: new TextEncoder().encode(password),
    salt,
    parallelism: HASH_PARAMS.parallelism,
    passes: HASH_PARAMS.passes,
    memorySize: HASH_PARAMS.memorySize,
    tagLength: HASH_PARAMS.tagLength,
  });
  return encodeArgon2idPhc(salt, digest, HASH_PARAMS);
}
