/** Node stub: the Worker imports EngineContainer, which extends this in prod. */
export class Container {
  defaultPort = 7878;
  sleepAfter = "30s";

  async fetch() {
    return new Response("container stub: use the CI ENGINE binding", { status: 501 });
  }

  async startAndWaitForPorts() {}

  async containerFetch() {
    return new Response("container stub", { status: 503 });
  }
}
