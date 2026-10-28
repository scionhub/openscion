/** Resolve `@cloudflare/containers` to the Node stub so Worker imports load. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@cloudflare/containers") {
    return {
      url: new URL("./stubs/cloudflare-containers.js", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
