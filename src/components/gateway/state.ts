import type { CleanupAck } from "../executor/scheduler-port.ts";
import type { Ack } from "../executor/scheduler-port.ts";
import { uuidv7 } from "../shared/uuid.ts";

/** `claimRequestId`：重试复用，`204`/成功后换新（契约 §5.3）。 */
export class ClaimIdempotency {
  #id: string | null = null;

  current(): string {
    if (this.#id === null) this.#id = uuidv7();
    return this.#id;
  }

  rotate(): void {
    this.#id = null;
  }
}

/** 控制事件 `ackSeq`：按 run 单调；只前进不后退（契约 §5.2）。 */
export class ControlSeq {
  #ackSeq = 0;

  get ackSeq(): number {
    return this.#ackSeq;
  }

  /** 过滤已应用的批（seq <= ackSeq），否则推进并返回本批事件。 */
  accept<T>(maxSeq: number, events: T[]): T[] {
    if (maxSeq <= this.#ackSeq) return [];
    this.#ackSeq = maxSeq;
    return events;
  }
}

/** 重复上报的进程内短路；淘汰后以服务端幂等为准（契约 §4.5）。 */
export class IdempotencyCache {
  readonly #limit: number;
  readonly #acks = new Map<string, Ack>();

  constructor(limit = 256) {
    this.#limit = limit;
  }

  get(attemptId: string): Ack | undefined {
    return this.#acks.get(attemptId);
  }

  set(attemptId: string, ack: Ack): void {
    this.#acks.set(attemptId, ack);
    if (this.#acks.size > this.#limit) {
      const oldest = this.#acks.keys().next().value;
      if (oldest !== undefined) this.#acks.delete(oldest);
    }
  }
}

/** 待回执清理：最多 20 条/跳，失败下一跳重发（契约 §5.2）。 */
export class CleanupAckQueue {
  readonly #items = new Map<string, CleanupAck>();

  enqueue(ack: CleanupAck): void {
    this.#items.set(ack.releaseId, ack);
  }

  take(limit = 20): CleanupAck[] {
    const batch = [...this.#items.values()].slice(0, limit);
    for (const ack of batch) this.#items.delete(ack.releaseId);
    return batch;
  }

  requeue(acks: CleanupAck[]): void {
    for (const ack of acks) this.#items.set(ack.releaseId, ack);
  }

  get size(): number {
    return this.#items.size;
  }
}

export type LeaseState = { expiresAtMs: number; ttlMs: number; trackedAt: number };

/** 租约计时：用 serverTime + 单调经过量，不用本地墙钟（契约 §4.7）。 */
export class LeaseTracker {
  readonly #leases = new Map<string, LeaseState>();
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  update(attemptId: string, expiresAt: string, ttlMs: number, serverTime: string): void {
    const serverMs = Date.parse(serverTime);
    const expiresMs = Date.parse(expiresAt);
    if (Number.isNaN(serverMs) || Number.isNaN(expiresMs)) return;
    this.#leases.set(attemptId, { expiresAtMs: expiresMs, ttlMs, trackedAt: this.#now() });
  }

  remainingMs(attemptId: string): number | null {
    const lease = this.#leases.get(attemptId);
    if (lease === undefined) return null;
    return lease.expiresAtMs - (Date.now() - (this.#now() - lease.trackedAt));
  }

  expired(attemptId: string): boolean {
    const remaining = this.remainingMs(attemptId);
    return remaining !== null && remaining <= 0;
  }

  forget(attemptId: string): void {
    this.#leases.delete(attemptId);
  }
}
