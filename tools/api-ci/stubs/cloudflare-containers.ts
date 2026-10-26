/** Node stub: the Worker imports EngineContainer, which extends this in prod. */
export class Container {
  defaultPort = 7878;
  sleepAfter = "30s";

  async fetch(): Promise<Response> {
    return new Response("container stub: use the CI ENGINE binding", { status: 501 });
  }

  async startAndWaitForPorts(): Promise<void> {}

  async containerFetch(): Promise<Response> {
    return new Response("container stub", { status: 503 });
  }
}
