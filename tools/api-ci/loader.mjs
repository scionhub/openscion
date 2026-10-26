import { pathToFileURL } from "node:url";

/** Resolve `@cloudflare/containers` to the Node stub so Worker imports load. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@cloudflare/containers") {
    return {
      url: pathToFileURL(new URL("./stubs/cloudflare-containers.ts", import.meta.url)).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
