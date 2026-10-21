export class OrgRouter {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Expected: /orgs/{org}/...
    const m = url.pathname.match(/^\/orgs\/([^/]+)(\/.*)?$/);
    if (!m) return new Response("bad route", { status: 400 });
    const org = decodeURIComponent(m[1]!);
    const rest = m[2] || "/";
    const base = this.env.CONTAINER_URL;
    if (!base) return new Response("container not configured", { status: 503 });
    const target = new URL(rest, base);
    // Preserve method/headers/body
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "manual"
    };
    const resp = await fetch(target.toString(), init);
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers
    });
  }
}

// Env type import for Worker build
export interface Env {
  CONTAINER_URL?: string;
}
