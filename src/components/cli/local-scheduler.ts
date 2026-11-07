import type { AttemptId, Lease, NodeRequest, NodeResult, SessionId, SkillSet } from "../executor/ports.ts";
import type {
  Ack,
  Capacity,
  CleanupAck,
  ClientInfo,
  ClientState,
  HeartbeatOutcome,
  RegistrationOutcome,
  SchedulerPort,
} from "../executor/scheduler-port.ts";

export type LocalSchedulerRequest = {
  request: NodeRequest;
  skillSet: SkillSet;
};

/**
 * `run` 的本地调度器替身（组合根适配器，不是新组件）：
 * `bindSession` 返回请求内联的技能集，`reportResult` 只捕获结果；不产生任何网络 I/O。
 */
export class LocalScheduler implements SchedulerPort {
  readonly #request: LocalSchedulerRequest;
  readonly #now: () => Date;
  #result: NodeResult | null = null;
  #claimed = false;

  constructor(request: LocalSchedulerRequest, now: () => Date = () => new Date()) {
    this.#request = request;
    this.#now = now;
  }

  get result(): NodeResult | null {
    return this.#result;
  }

  async register(_info: ClientInfo): Promise<RegistrationOutcome> {
    return {
      serverTime: this.#now().toISOString(),
      limits: {
        maxResultBytes: 256 * 1024,
        maxPromptBytes: 1024 * 1024,
        maxRequestBytes: 1024 * 1024,
        maxSkillPackageBytes: 64 * 1024 * 1024,
        maxSkillPackages: 64,
      },
      assignmentsVersion: 1,
      cleanupPending: [],
    };
  }

  async heartbeat(state: ClientState, _acks?: CleanupAck[]): Promise<HeartbeatOutcome> {
    return {
      serverTime: this.#now().toISOString(),
      control: { seq: 0, events: [] },
      cleanupPending: [],
      assignmentsVersion: state.assignmentsVersion,
      nextPollAfterMs: 1000,
    };
  }

  async claim(_capacity: Capacity): Promise<NodeRequest | null> {
    if (this.#claimed) return null;
    this.#claimed = true;
    return this.#request.request;
  }

  async renew(attemptId: AttemptId): Promise<Lease> {
    return this.#request.request.lease;
  }

  async bindSession(attemptId: AttemptId, _sessionId: SessionId): Promise<SkillSet> {
    if (attemptId !== this.#request.request.attemptId) throw new Error(`本地请求不匹配：${attemptId}`);
    return this.#request.skillSet;
  }

  async reportResult(_attemptId: AttemptId, result: NodeResult): Promise<Ack> {
    const duplicate = this.#result !== null;
    this.#result = result;
    return {
      attemptId: result.attemptId,
      disposition: duplicate ? "duplicate" : "accepted",
      attemptState: "reported",
      recordedAt: this.#now().toISOString(),
    };
  }
}
