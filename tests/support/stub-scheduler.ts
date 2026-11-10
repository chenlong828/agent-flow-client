import type { PollRequest, PollResponse, ResultAck, SkillPackage, TaskRequest, TaskResult } from "../../src/components/executor/types.ts";

export type StubRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type StubFailure = { status: number; code?: string; times?: number };

/** executor contract v2 的轻量内存桩：poll 长轮询、首份结果为准、技能包下载与错误注入。 */
export class StubScheduler {
  readonly requests: StubRequest[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  readonly #token: string | null;
  readonly #pollHoldMs: number;
  #tasks: TaskRequest[] = [];
  #stop = false;
  #cancelInstances: string[] = [];
  #results = new Map<string, TaskResult>();
  #failures = new Map<string, StubFailure>();
  #package: { bytes: Uint8Array; etag: string; sha256: string } | null = null;
  #nextPollAfterMs = 10;

  constructor(options: { token?: string; pollHoldMs?: number } = {}) {
    this.#token = options.token ?? null;
    this.#pollHoldMs = options.pollHoldMs ?? 30;
    this.server = Bun.serve({ port: 0, fetch: (request) => this.#handle(request) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  enqueueTask(task: TaskRequest): void {
    this.#tasks.push(task);
  }

  setStop(value: boolean): void {
    this.#stop = value;
  }

  cancelInstance(instanceId: string): void {
    if (!this.#cancelInstances.includes(instanceId)) this.#cancelInstances.push(instanceId);
  }

  clearCancelInstances(): void {
    this.#cancelInstances = [];
  }

  setPackage(bytes: Uint8Array, etag: string, sha256: string): void {
    this.#package = { bytes, etag, sha256 };
  }

  failNext(key: string, failure: StubFailure): void {
    this.#failures.set(key, failure);
  }

  setNextPollAfterMs(value: number): void {
    this.#nextPollAfterMs = value;
  }

  results(): TaskResult[] {
    return [...this.#results.values()];
  }

  async close(): Promise<void> {
    this.server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    this.requests.push({ method: request.method, path: url.pathname, headers, body });

    const failure = this.#failures.get(`${request.method} ${url.pathname}`);
    if (failure !== undefined && (failure.times ?? 1) > 0) {
      this.#failures.set(`${request.method} ${url.pathname}`, { ...failure, times: (failure.times ?? 1) - 1 });
      return this.#error(failure.status, failure.code ?? "internal");
    }
    if (this.#token !== null && headers.authorization !== `Bearer ${this.#token}`) {
      return this.#error(401, "unauthorized");
    }
    if (headers["x-executor-protocol"] !== "2") {
      return this.#error(400, "unsupported_protocol");
    }
    if (request.method === "POST" && url.pathname === "/api/v1/executor/poll") return await this.#poll(body);
    const result = /^\/api\/v1\/executor\/tasks\/([^/]+)\/result$/.exec(url.pathname);
    if (request.method === "POST" && result !== null) return this.#report(decodeURIComponent(result[1] as string), body);
    const pkg = /^\/api\/v1\/executor\/skill-packages\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && pkg !== null) return this.#packageResponse(request);
    return this.#error(404, "not_found");
  }

  async #poll(body: Record<string, unknown>): Promise<Response> {
    const started = Date.now();
    while (this.#tasks.length === 0 && !this.#stop && this.#cancelInstances.length === 0) {
      if (Date.now() - started >= this.#pollHoldMs) break;
      await Bun.sleep(5);
    }
    const free = Number((body.capacity as { free?: number } | undefined)?.free ?? 0);
    const tasks = this.#tasks.splice(0, Math.max(0, Math.min(free, 10)));
    const response: PollResponse = {
      tasks,
      stop: this.#stop,
      cancelInstances: [...this.#cancelInstances],
      nextPollAfterMs: this.#nextPollAfterMs,
    };
    return Response.json(response);
  }

  #report(taskId: string, body: Record<string, unknown>): Response {
    if (this.#results.has(taskId)) {
      const ack: ResultAck = { taskId, accepted: false };
      return Response.json(ack);
    }
    const result = body as unknown as TaskResult;
    this.#results.set(taskId, { ...result, taskId });
    const ack: ResultAck = { taskId, accepted: true };
    return Response.json(ack);
  }

  #packageResponse(request: Request): Response {
    if (this.#package === null) return this.#error(404, "package_not_found");
    if (request.headers.get("if-none-match") === this.#package.etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(new Blob([new Uint8Array(this.#package.bytes)]), {
      headers: {
        "content-type": "application/zip",
        etag: this.#package.etag,
        "x-checksum-sha256": this.#package.sha256,
      },
    });
  }

  #error(status: number, code: string): Response {
    return Response.json({ error: { code, message: code } }, { status });
  }
}

export type { PollRequest, SkillPackage };
