import type { Ack, CleanupPending, ControlEvent, Limits } from "../../src/components/executor/scheduler-port.ts";
import type { NodeRequest, NodeResult, SkillSet } from "../../src/components/executor/types.ts";
import { uuidv7 } from "../../src/components/shared/uuid.ts";

export type StubRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type StubFailure = { status: number; code?: string; times?: number };

const DEFAULT_LIMITS: Limits = {
  maxResultBytes: 262144,
  maxPromptBytes: 1048576,
  maxRequestBytes: 2097152,
  maxSkillPackageBytes: 67108864,
  maxSkillPackages: 64,
};

/** 契约附录 A 的轻量内存桩：路由、鉴权、长轮询、幂等与错误注入。 */
export class StubScheduler {
  readonly requests: StubRequest[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  readonly #token: string | null;
  readonly #heartbeatHoldMs: number;
  readonly #claimHoldMs: number;
  readonly #limits: Limits;
  readonly skillSet: SkillSet;
  #events: ControlEvent[] = [];
  #seq = 0;
  #claims: NodeRequest[] = [];
  #cleanup: CleanupPending[] = [];
  #reports = new Map<string, NodeResult>();
  #failures = new Map<string, StubFailure>();
  #leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
  #registerCompatibility = "compatible";
  #reportLate = false;
  #bindAttemptId: string | null = null;
  readonly #skillSets = new Map<string, SkillSet>();
  readonly #activeInstances = new Set<string>();
  readonly #attemptInstances = new Map<string, string>();

  constructor(options: { token?: string; heartbeatHoldMs?: number; claimHoldMs?: number; limits?: Partial<Limits>; skillSet?: SkillSet } = {}) {
    this.#token = options.token ?? null;
    this.#heartbeatHoldMs = options.heartbeatHoldMs ?? 30;
    this.#claimHoldMs = options.claimHoldMs ?? 20;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.skillSet = options.skillSet ?? { digest: "sha256:stub", packages: [] };
    this.server = Bun.serve({ port: 0, fetch: (request) => this.#handle(request) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  enqueueRequest(request: NodeRequest): void {
    this.#claims.push(request);
  }

  enqueueEvent(event: ControlEvent): void {
    this.#events.push(event);
  }

  setCleanupPending(pending: CleanupPending[]): void {
    this.#cleanup = pending;
  }

  failNext(key: string, failure: StubFailure): void {
    this.#failures.set(key, failure);
  }

  setCompatibility(compatibility: string): void {
    this.#registerCompatibility = compatibility;
  }

  setReportLate(late: boolean): void {
    this.#reportLate = late;
  }

  setBindAttemptId(attemptId: string): void {
    this.#bindAttemptId = attemptId;
  }

  setSkillSetFor(attemptId: string, skillSet: SkillSet): void {
    this.#skillSets.set(attemptId, skillSet);
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
    return await this.#route(request, url, body);
  }

  async #route(request: Request, url: URL, body: Record<string, unknown>): Promise<Response> {
    if (request.method === "POST" && url.pathname === "/api/v1/executor/register") return this.#register();
    if (request.method === "POST" && url.pathname === "/api/v1/executor/heartbeat") return await this.#heartbeat(body);
    if (request.method === "POST" && url.pathname === "/api/v1/executor/claim") return await this.#claim();
    const match = /^\/api\/v1\/executor\/attempts\/([^/]+)\/(lease|session|result)$/.exec(url.pathname);
    if (request.method === "POST" && match !== null) {
      const attemptId = decodeURIComponent(match[1] as string);
      const action = match[2] as "lease" | "session" | "result";
      if (action === "lease") return this.#renew();
      if (action === "session") return this.#bind(attemptId, body);
      return this.#report(attemptId, body);
    }
    return this.#error(404, "not_found");
  }

  #register(): Response {
    return Response.json({
      serverTime: new Date().toISOString(),
      protocolVersion: "2026-11-07.1",
      compatibility: this.#registerCompatibility,
      clientLease: { expiresAt: new Date(Date.now() + 90_000).toISOString(), ttlMs: 90000 },
      heartbeat: { pollTimeoutMs: 30000, clientTimeoutMs: 35000, nextPollAfterMs: 1000 },
      limits: this.#limits,
      assignmentsVersion: 1,
      cleanupPending: this.#cleanup,
    });
  }

  async #heartbeat(body: Record<string, unknown>): Promise<Response> {
    const started = Date.now();
    while (this.#events.length === 0 && Date.now() - started < this.#heartbeatHoldMs) {
      await Bun.sleep(5);
    }
    const events = this.#events;
    this.#events = [];
    this.#seq += events.length;
    return Response.json({
      serverTime: new Date().toISOString(),
      clientLease: { expiresAt: new Date(Date.now() + 90_000).toISOString(), ttlMs: 90000 },
      control: { seq: events.length === 0 ? Number(body.ackSeq ?? 0) : this.#seq, events },
      assignmentsVersion: 1,
      cleanupPending: this.#cleanup,
      nextPollAfterMs: 1000,
    });
  }

  async #claim(): Promise<Response> {
    const started = Date.now();
    while (Date.now() - started < this.#claimHoldMs) {
      const head = this.#claims[0];
      if (head !== undefined && !this.#activeInstances.has(head.instanceId)) {
        this.#claims.shift();
        this.#activeInstances.add(head.instanceId);
        this.#attemptInstances.set(head.attemptId, head.instanceId);
        return Response.json(head);
      }
      if (head === undefined && this.#claims.length === 0) {
        // 没有待领取请求；等待短窗口后返回 204。
        await Bun.sleep(5);
        if (Date.now() - started >= this.#claimHoldMs) break;
        continue;
      }
      await Bun.sleep(5);
    }
    return new Response(null, { status: 204 });
  }

  #renew(): Response {
    return Response.json({
      serverTime: new Date().toISOString(),
      lease: { expiresAt: this.#leaseExpiresAt, ttlMs: 120000 },
    });
  }

  #bind(attemptId: string, body: Record<string, unknown>): Response {
    return Response.json({
      attemptId: this.#bindAttemptId ?? attemptId,
      sessionId: body.sessionId,
      skillSet: this.#skillSets.get(attemptId) ?? this.skillSet,
    });
  }

  #report(attemptId: string, body: Record<string, unknown>): Response {
    const result = body.result as NodeResult | undefined;
    if (this.#reportLate) {
      return this.#error(409, "late_result");
    }
    const duplicate = this.#reports.has(attemptId);
    if (result !== undefined) {
      this.#reports.set(attemptId, result);
      const instanceId = this.#attemptInstances.get(attemptId);
      if (instanceId !== undefined) this.#activeInstances.delete(instanceId);
      this.#attemptInstances.delete(attemptId);
    }
    const ack: Ack = {
      attemptId,
      disposition: duplicate ? "duplicate" : "accepted",
      attemptState: "reported",
      recordedAt: new Date().toISOString(),
    };
    return Response.json(ack);
  }

  #error(status: number, code: string): Response {
    const headers = status === 429 ? { "Retry-After": "2" } : undefined;
    return Response.json({ error: { code, message: code, requestId: uuidv7() } }, { status, ...(headers === undefined ? {} : { headers }) });
  }
}
