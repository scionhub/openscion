import { handleCi } from "./ci";

export interface Env {
  DB_SCIONHUB_TOP: D1Database;
  ORGS_DB?: D1Database;
  ENGINE: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ci = await handleCi(request, env, path);
    if (ci) return ci;
    return new Response(JSON.stringify({ error: "not found" }, null, 2), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
