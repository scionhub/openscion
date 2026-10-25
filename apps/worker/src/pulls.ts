import { type D1Env } from "./db";

type Env = D1Env & {
  ENGINE: DurableObjectNamespace;
};

export function engineFetch(env: Env, origin: URL, path: string, init: RequestInit): Promise<Response> {
  // Forward to the engine Durable Object under /orgs/{org}
  const id = env.ENGINE.idFromName("filecoin-project");
  const stub = env.ENGINE.get(id);
  const u = new URL(origin.toString());
  const q = path.indexOf("?");
  u.pathname = "/orgs/filecoin-project" + (q >= 0 ? path.slice(0, q) : path);
  u.search = q >= 0 ? path.slice(q) : "";
  return stub.fetch(new Request(u.toString(), init));
}
