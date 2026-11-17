import type { AttemptStatus, SessionRichEvent, SessionRichEventInput } from "./types.ts";
import type { RichStreamPort } from "./http-types.ts";

type Entry = {
  events: SessionRichEvent[];
  seq: number;
  listeners: Set<(event: SessionRichEvent) => void>;
  closers: Set<(status: AttemptStatus) => void>;
  status?: AttemptStatus;
};

/** O-11 的运行中富事件 ring；只在内存，不落盘。 */
export class SessionRichHub implements RichStreamPort {
  readonly #sessions = new Map<string, Entry>();
  readonly #maxEvents: number;
  readonly #now: () => Date;

  constructor(options: { maxEvents?: number; now?: () => Date } = {}) {
    this.#maxEvents = options.maxEvents ?? 1000;
    this.#now = options.now ?? (() => new Date());
  }

  publish(sessionId: string, input: SessionRichEventInput): SessionRichEvent {
    const entry = this.#entry(sessionId);
    const event: SessionRichEvent = {
      ...input,
      seq: entry.seq + 1,
      ts: input.ts ?? this.#now().toISOString(),
      sessionId,
    };
    entry.seq = event.seq;
    entry.events.push(event);
    if (entry.events.length > this.#maxEvents) entry.events.splice(0, entry.events.length - this.#maxEvents);
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者失败不影响其它订阅者。
      }
    }
    return event;
  }

  snapshot(sessionId: string, limit: number): SessionRichEvent[] {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return [];
    return entry.events.slice(-Math.max(1, limit)).map((event) => ({ ...event }));
  }

  subscribe(sessionId: string, listener: (event: SessionRichEvent) => void): () => void {
    const entry = this.#entry(sessionId);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  onClose(sessionId: string, listener: (status: AttemptStatus) => void): () => void {
    const entry = this.#entry(sessionId);
    entry.closers.add(listener);
    return () => entry.closers.delete(listener);
  }

  close(sessionId: string, status: AttemptStatus): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined || entry.status !== undefined) return;
    entry.status = status;
    for (const listener of entry.closers) {
      try {
        listener(status);
      } catch {
        // 关闭通知失败不影响执行。
      }
    }
    entry.listeners.clear();
    entry.closers.clear();
  }

  #entry(sessionId: string): Entry {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: Entry = { events: [], seq: 0, listeners: new Set(), closers: new Set() };
    this.#sessions.set(sessionId, created);
    return created;
  }
}
