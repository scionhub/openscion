/** Cloudflare Workers WASM loader for argon2id (module imports, not compile). */
import setupWasm, { type computeHash } from "argon2id/lib/setup.js";
import simdWasm from "./wasm/argon2id-simd.wasm";
import noSimdWasm from "./wasm/argon2id-no-simd.wasm";

let computePromise: Promise<computeHash> | null = null;

function instantiateModule(mod: WebAssembly.Module) {
  return (imports: WebAssembly.Imports) =>
    WebAssembly.instantiate(mod, imports).then((instance) => ({ module: mod, instance }));
}

export function loadArgon2idCompute(): Promise<computeHash> {
  if (!computePromise) {
    computePromise = setupWasm(instantiateModule(simdWasm), instantiateModule(noSimdWasm));
  }
  return computePromise;
}
