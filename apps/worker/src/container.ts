// Durable Object Container that fronts the Rust engine container.
// Uses the Durable Object Container API available via `this.ctx.container`.
import { Container } from "@cloudflare/containers";

export class EngineContainer extends Container<Env> {
  override defaultPort = 7878;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Expect /orgs/{org}/...
    const parts = url.pathname.split("/");
    if (parts.length < 3 || parts[1] !== "orgs") {
      return new Response("bad route", { status: 400 });
    }
    const restPath = "/" + parts.slice(3).join("/");
    const targetPath = restPath + url.search;
    // Start container if needed and proxy to default port
    await this.startAndWaitForPorts();
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "manual"
    };
    const resp = await this.containerFetch(targetPath, init);
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }
}

export interface Env {}
