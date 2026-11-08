import { hostname, platform, arch } from "node:os";
import type {
  AttemptId,
  Lease,
  NodeRequest,
  NodeResult,
  SessionId,
  SkillSet,
} from "../executor/types.ts";
import type {
  Ack,
  Capacity,
  CleanupAck,
  ClientInfo,
  ClientState,
  HeartbeatOutcome,
  Limits,
  RegistrationOutcome,
  SchedulerPort,
} from "../executor/scheduler-port.ts";
import { GatewayError } from "./errors.ts";
import { HttpTransport } from "./transport.ts";
import { withRetry, type RetryOptions } from "./retry.ts";
import { ClaimIdempotency, CleanupAckQueue, ControlSeq, IdempotencyCache, LeaseTracker } from "./state.ts";
import {
  asRecord,
  asString,
  parseAck,
  parseHeartbeat,
  parseLease,
  parseNodeRequest,
  parseRegistration,
  parseSkillSet,
} from "./wire.ts";

export type GatewayOptions = {
  transport: HttpTransport;
  clientVersion: string;
  acpVersion?: string;
  dshVersion?: string;
  labels?: Record<string, string>;
  retry?: RetryOptions;
  audit?: (event: string, detail?: Record<string, unknown>) => void;
  now?: () => Date;
};

const DEFAULT_LIMITS: Limits = {
  maxResultBytes: 256 * 1024,
  maxPromptBytes: 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
  maxSkillPackageBytes: 64 * 1024 * 1024,
  maxSkillPackages: 64,
};

const HEARTBEAT_TIMEOUT_FALLBACK = { pollTimeoutMs: 30_000, clientTimeoutMs: 35_000 };
const CLAIM_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** 调度器 HTTP 防腐层（CMP-gateway）：实现 `SchedulerPort`，不泄漏 HTTP/SDK 类型。 */
export class HttpScheduler implements SchedulerPort {
  readonly #transport: HttpTransport;
  readonly #clientId: string;
  readonly #runId: string;
  readonly #options: GatewayOptions;
  readonly #claim = new ClaimIdempotency();
  readonly #control = new ControlSeq();
  readonly #queue = new CleanupAckQueue();
  readonly #cache = new IdempotencyCache();
  readonly #leases = new LeaseTracker();
  readonly #workspace = new Map<string, string>();
  #limits: Limits = DEFAULT_LIMITS;
  #heartbeat = { ...HEARTBEAT_TIMEOUT_FALLBACK, nextPollAfterMs: 0 };
  #assignmentsVersion = 0;

  constructor(clientId: string, runId: string, options: GatewayOptions) {
    this.#clientId = clientId;
    this.#runId = runId;
    this.#options = options;
    this.#transport = options.transport;
  }

  get limits(): Limits {
    return this.#limits;
  }

  get heartbeatConfig(): { pollTimeoutMs: number; clientTimeoutMs: number; nextPollAfterMs: number } {
    return this.#heartbeat;
  }

  get leases(): LeaseTracker {
    return this.#leases;
  }

  async register(info: ClientInfo): Promise<RegistrationOutcome> {
    const body = {
      clientId: this.#clientId,
      protocolVersion: info.protocolVersion,
      clientVersion: info.version,
      runtime: {
        acpVersion: this.#options.acpVersion ?? "1",
        dshVersion: this.#options.dshVersion ?? "0.2.2-alpha.2",
        os: platform(),
        arch: arch(),
      },
      capacity: { maxInstances: info.capacity.maxInstances },
      labels: { host: hostname(), ...(this.#options.labels ?? {}) },
    };
    const result = await withRetry(
      async () => await this.#transport.post("/register", body, { timeoutMs: REQUEST_TIMEOUT_MS }),
      this.#options.retry,
    );
    const parsed = parseRegistration(result.body);
    if (parsed.protocolVersion !== info.protocolVersion) {
      this.#options.audit?.("version.mismatch", { server: parsed.protocolVersion, client: info.protocolVersion });
    }
    if (parsed.compatibility === "incompatible") {
      throw new GatewayError("version_incompatible", `调度器协议不兼容：${parsed.protocolVersion}`);
    }
    if (parsed.compatibility === "deprecated") {
      this.#options.audit?.("version.deprecated", { server: parsed.protocolVersion });
    }
    this.#limits = parsed.limits;
    this.#heartbeat = { ...parsed.heartbeat };
    this.#assignmentsVersion = parsed.assignmentsVersion;
    return {
      serverTime: parsed.serverTime,
      limits: parsed.limits,
      assignmentsVersion: parsed.assignmentsVersion,
      ...(parsed.assignments === undefined ? {} : { assignments: parsed.assignments }),
      cleanupPending: parsed.cleanupPending,
    };
  }

  async heartbeat(state: ClientState, acks?: CleanupAck[]): Promise<HeartbeatOutcome> {
    for (const ack of acks ?? []) this.#queue.enqueue(ack);
    const pending = this.#queue.take();
    try {
      const result = await this.#transport.post(
        "/heartbeat",
        {
          state,
          ackSeq: this.#control.ackSeq,
          ...(pending.length === 0 ? {} : { cleanupAcks: pending }),
          assignmentsVersion: state.assignmentsVersion,
        },
        { timeoutMs: this.#heartbeat.clientTimeoutMs },
      );
      const parsed = parseHeartbeat(result.body);
      this.#control.apply(parsed.control.seq);
      this.#assignmentsVersion = parsed.assignmentsVersion;
      if (parsed.nextPollAfterMs > 0) this.#heartbeat.nextPollAfterMs = parsed.nextPollAfterMs;
      return parsed;
    } catch (error) {
      this.#queue.requeue(pending);
      throw error;
    }
  }

  async claim(capacity: Capacity): Promise<NodeRequest | null> {
    const claimRequestId = this.#claim.current();
    const availableInstances = Math.max(0, capacity.maxInstances - capacity.activeInstances);
    try {
      const result = await withRetry(
        async () =>
          await this.#transport.post(
            "/claim",
            { claimRequestId, capacity: { availableInstances }, acceptLongPollMs: 20_000 },
            { timeoutMs: CLAIM_TIMEOUT_MS },
          ),
        {
          ...this.#options.retry,
          maxAttempts: this.#options.retry?.maxAttempts ?? 2,
          retryOn: (error) => error.retryable && error.code !== "timeout",
        },
      );
      if (result.status === 204 || result.body === null) {
        this.#claim.rotate();
        return null;
      }
      const request = parseNodeRequest(result.body);
      this.#workspace.set(request.attemptId, request.workspacePath);
      this.#leases.update(request.attemptId, request.lease.expiresAt, request.lease.ttlMs, request.claimedAt);
      this.#claim.rotate();
      return request;
    } catch (error) {
      if (error instanceof GatewayError && error.code === "timeout") return null;
      throw error;
    }
  }

  async renew(attemptId: AttemptId): Promise<Lease> {
    const result = await this.#transport.post(
      `/attempts/${encodeURIComponent(attemptId)}/lease`,
      {},
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const root = asRecord(result.body, "renew");
    const lease = parseLease(root.lease);
    this.#leases.update(attemptId, lease.expiresAt, lease.ttlMs, asString(root.serverTime, "serverTime"));
    return lease;
  }

  async bindSession(attemptId: AttemptId, sessionId: SessionId): Promise<SkillSet> {
    const cwd = this.#workspace.get(attemptId);
    if (cwd === undefined) throw new GatewayError("invalid_request", `缺少 attempt 的 workspacePath：${attemptId}`);
    const result = await this.#transport.post(
      `/attempts/${encodeURIComponent(attemptId)}/session`,
      { sessionId, cwd },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const root = asRecord(result.body, "bindSession");
    if (root.attemptId !== attemptId) throw new GatewayError("unreachable", "bindSession 返回的 attemptId 不一致");
    return parseSkillSet(root.skillSet);
  }

  async reportResult(attemptId: AttemptId, result: NodeResult): Promise<Ack> {
    const cached = this.#cache.get(attemptId);
    if (cached !== undefined) return { ...cached, disposition: "duplicate" };
    try {
      const response = await withRetry(
        async () =>
          await this.#transport.post(`/attempts/${encodeURIComponent(attemptId)}/result`, { result }, { timeoutMs: REQUEST_TIMEOUT_MS }),
        this.#options.retry,
      );
      const ack = parseAck(response.body);
      this.#cache.set(attemptId, ack);
      return ack;
    } catch (error) {
      if (error instanceof GatewayError && (error.code === "late_result" || error.code === "stale_attempt")) {
        const ack: Ack = {
          attemptId,
          disposition: "duplicate",
          attemptState: "closed",
          recordedAt: this.#options.now?.().toISOString() ?? new Date().toISOString(),
        };
        this.#cache.set(attemptId, ack);
        this.#options.audit?.("result.late", { attemptId, code: error.code });
        return ack;
      }
      throw error;
    }
  }
}
