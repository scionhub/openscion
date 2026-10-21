// Durable Object Container that fronts the Rust engine container.
// Uses the Durable Object Container API available via `this.ctx.container`.
export class EngineContainer {
  private ctx: any;
  constructor(private readonly state: DurableObjectState, private readonly env: Env, ctx: any) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Expect /orgs/{org}/...
    const parts = url.pathname.split("/");
    if (parts.length < 3 || parts[1] !== "orgs") {
      return new Response("bad route", { status: 400 });
    }
    const restPath = "/" + parts.slice(3).join("/");
    const targetPath = restPath + url.search;
    // Ensure the container is started and port 7878 is ready
    await this.ctx.container.start();
    const port = this.ctx.container.getTcpPort(7878);
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "manual"
    };
    const resp = await port.fetch(targetPath, init);
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }
}

export interface Env {}
