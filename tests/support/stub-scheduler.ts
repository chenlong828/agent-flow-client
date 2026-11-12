import { createHash } from "node:crypto";
import type {
  ArchiveAck,
  ArchiveRequest,
  PollRequest,
  PollResponse,
  ResultAck,
  SessionLogAck,
  SkillPackage,
  TaskRequest,
  TaskResult,
} from "../../src/components/executor/types.ts";

export type StubRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type StubFailure = { status: number; code?: string; times?: number };

/** executor contract v3 的轻量内存桩：poll 长轮询、日志/归档、首份结果为准、错误注入。 */
export class StubScheduler {
  readonly requests: StubRequest[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  readonly #token: string | null;
  readonly #pollHoldMs: number;
  #protocol = "3";
  #sessionLogLimit: number | null = null;
  #archiveLimit: number | null = null;
  #tasks: TaskRequest[] = [];
  #stop = false;
  #cancelInstances: string[] = [];
  #archiveRequests: ArchiveRequest[] = [];
  #announcedArchives = new Set<string>();
  #results = new Map<string, TaskResult>();
  #sessionLogs = new Map<string, Uint8Array>();
  #archives = new Map<string, Uint8Array>();
  #nonTerminalRuns = new Set<string>();
  #failures = new Map<string, StubFailure>();
  #package: { bytes: Uint8Array; etag: string; sha256: string } | null = null;
  #nextPollAfterMs = 10;

  constructor(options: { token?: string | null; pollHoldMs?: number } = {}) {
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

  requestArchive(request: ArchiveRequest): void {
    if (!this.#archiveRequests.some((item) => item.runId === request.runId)) this.#archiveRequests.push(request);
  }

  clearArchiveRequests(): void {
    this.#archiveRequests = [];
    this.#announcedArchives.clear();
  }

  setSessionLogLimit(bytes: number | null): void {
    this.#sessionLogLimit = bytes;
  }

  setArchiveLimit(bytes: number | null): void {
    this.#archiveLimit = bytes;
  }

  setRunTerminal(runId: string, terminal: boolean): void {
    if (terminal) this.#nonTerminalRuns.delete(runId);
    else this.#nonTerminalRuns.add(runId);
  }

  setPiece(value: Uint8Array, etag: string, sha256: string): void {
    this.#package = { bytes: value, etag, sha256 };
  }

  setPackage(bytes: Uint8Array, etag: string, sha256: string): void {
    this.setPiece(bytes, etag, sha256);
  }

  failNext(key: string, failure: StubFailure): void {
    this.#failures.set(key, failure);
  }

  setNextPollAfterMs(value: number): void {
    this.#nextPollAfterMs = value;
  }

  setProtocol(version: string): void {
    this.#protocol = version;
  }

  results(): TaskResult[] {
    return [...this.#results.values()];
  }

  sessionLog(taskId: string, attempt: number): Uint8Array | null {
    return this.#sessionLogs.get(`${taskId}#${attempt}`) ?? null;
  }

  archive(runId: string): Uint8Array | null {
    return this.#archives.get(runId) ?? null;
  }

  pendingArchives(): ArchiveRequest[] {
    return [...this.#archiveRequests];
  }

  async close(): Promise<void> {
    this.server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isJson = request.method === "POST" && (url.pathname === "/api/v1/executor/poll" || /\/result$/.test(url.pathname));
    const body = isJson ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
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
    if (headers["x-executor-protocol"] !== this.#protocol) {
      return this.#error(400, "unsupported_protocol");
    }
    if (request.method === "POST" && url.pathname === "/api/v1/executor/poll") return await this.#poll(body);
    const result = /^\/api\/v1\/executor\/tasks\/([^/]+)\/result$/.exec(url.pathname);
    if (request.method === "POST" && result !== null) return this.#report(decodeURIComponent(result[1] as string), body);
    const log = /^\/api\/v1\/executor\/tasks\/([^/]+)\/session-log$/.exec(url.pathname);
    if (request.method === "POST" && log !== null) {
      return await this.#sessionLog(decodeURIComponent(log[1] as string), url, request);
    }
    const archive = /^\/api\/v1\/executor\/runs\/([^/]+)\/archive$/.exec(url.pathname);
    if (request.method === "POST" && archive !== null) {
      return await this.#archive(decodeURIComponent(archive[1] as string), request);
    }
    const pkg = /^\/api\/v1\/executor\/skill-packages\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && pkg !== null) return this.#packageResponse(request);
    return this.#error(404, "not_found");
  }

  async #poll(body: Record<string, unknown>): Promise<Response> {
    const confirmed = Array.isArray(body.archivedRuns) ? (body.archivedRuns as string[]) : [];
    if (confirmed.length > 0) {
      this.#archiveRequests = this.#archiveRequests.filter((item) => !confirmed.includes(item.runId));
    }
    const pendingFirst = this.#archiveRequests.some((item) => !this.#announcedArchives.has(item.runId));
    const started = Date.now();
    while (
      this.#tasks.length === 0 &&
      !this.#stop &&
      this.#cancelInstances.length === 0 &&
      !pendingFirst
    ) {
      if (Date.now() - started >= this.#pollHoldMs) break;
      await Bun.sleep(5);
    }
    const free = Number((body.capacity as { free?: number } | undefined)?.free ?? 0);
    const tasks = this.#tasks.splice(0, Math.max(0, Math.min(free, 10)));
    for (const item of this.#archiveRequests) this.#announcedArchives.add(item.runId);
    const response: PollResponse = {
      tasks,
      stop: this.#stop,
      cancelInstances: [...this.#cancelInstances],
      archiveRequests: [...this.#archiveRequests],
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
    const key = `${taskId}#${result.attempt}`;
    if (!this.#sessionLogs.has(key)) return this.#error(409, "session_log_missing");
    this.#results.set(taskId, { ...result, taskId });
    const ack: ResultAck = { taskId, accepted: true };
    return Response.json(ack);
  }

  async #sessionLog(taskId: string, url: URL, request: Request): Promise<Response> {
    const attempt = Number(url.searchParams.get("attempt") ?? "0");
    if (!Number.isInteger(attempt) || attempt < 1) return this.#error(400, "validation_error");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (this.#sessionLogLimit !== null && bytes.byteLength > this.#sessionLogLimit) {
      return this.#error(413, "payload_too_large");
    }
    const key = `${taskId}#${attempt}`;
    const previous = this.#sessionLogs.get(key);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.#sessionLogs.set(key, bytes);
    const ack: SessionLogAck = {
      taskId,
      attempt,
      bytes: bytes.byteLength,
      sha256,
      stored: previous === undefined ? "created" : createHash("sha256").update(previous).digest("hex") === sha256 ? "unchanged" : "replaced",
    };
    return Response.json(ack);
  }

  async #archive(runId: string, request: Request): Promise<Response> {
    if (this.#nonTerminalRuns.has(runId)) return this.#error(409, "invalid_state");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (this.#archiveLimit !== null && bytes.byteLength > this.#archiveLimit) {
      return this.#error(413, "payload_too_large");
    }
    const previous = this.#archives.get(runId);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.#archives.set(runId, bytes);
    const ack: ArchiveAck = {
      runId,
      bytes: bytes.byteLength,
      sha256,
      stored: previous === undefined ? "created" : createHash("sha256").update(previous).digest("hex") === sha256 ? "unchanged" : "replaced",
    };
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
