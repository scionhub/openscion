import { argon2id, argon2i, argon2Verify } from "hash-wasm";

/** Normalize base64 by adding padding and converting URL-safe alphabet to standard. */
function normalizeBase64(input: string): string {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) s += "==="; // defensive: shouldn't happen for valid base64
  return s;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function bytesToString(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase().replace(/[^0-9a-f]/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

/** Verify a password against a PHC-formatted argon2 hash. */
export async function verifyArgon2Password(password: string, phc: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: phc });
  } catch {
    return false;
  }
}

/** Create a PHC-formatted argon2id hash for the given password. */
export async function hashPasswordArgon2id(password: string): Promise<string> {
  // Conservative Worker-friendly defaults; must match verifier above
  const m = 19456; // KiB
  const t = 2;
  const p = 1;
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  // Return PHC-encoded string
  const phc = await (argon2id as any)({
    password,
    salt: bytesToString(salt),
    parallelism: p,
    iterations: t,
    memorySize: m,
    hashLength: 32,
    outputType: "encoded",
  });
  return phc;
}

