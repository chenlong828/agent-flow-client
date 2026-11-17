import type { ObservationPort } from "../executor/ports.ts";
import type { TaskResult } from "../executor/types.ts";
import { SerialQueue } from "../store/journal-io.ts";
import { archiveSession } from "./archive.ts";
import { writeSessionMeta } from "./session-meta.ts";
import { AcpObservationMapper } from "./mapper.ts";
import { truncate } from "./text.ts";
import { SessionRichHub } from "./rich-hub.ts";
import { FileAttemptStore } from "./attempt-store.ts";
import type { AttemptStatus, SessionRichEventInput } from "./types.ts";
import type { ObserverHealth } from "./health.ts";

const PROMPT_LIMIT = 16384;
const ignore = (): undefined => undefined;

/** 把执行事实写入 attempt 事件（preview）与 session 富事件 ring；所有写入串行，失败不影响任务。 */
export class ObservationRecorder implements ObservationPort {
  readonly #attempts: FileAttemptStore;
  readonly #rich: SessionRichHub;
  readonly #mapper: AcpObservationMapper;
  readonly #stateRoot: string;
  readonly #queue = new SerialQueue();
  readonly #now: () => Date;
  readonly #health: ObserverHealth | undefined;
  readonly #attemptsBySession = new Map<string, string>();

  constructor(options: {
    stateRoot: string;
    attempts: FileAttemptStore;
    rich: SessionRichHub;
    mapper?: AcpObservationMapper;
    now?: () => Date;
    health?: ObserverHealth;
  }) {
    this.#stateRoot = options.stateRoot;
    this.#attempts = options.attempts;
    this.#rich = options.rich;
    this.#mapper = options.mapper ?? new AcpObservationMapper();
    this.#now = options.now ?? (() => new Date());
    this.#health = options.health;
  }

  async startAttempt(input: {
    taskId: string;
    attemptNo: number;
    instanceId: string;
    nodeId: string;
    runId?: string;
    startedAt: string;
  }): Promise<string | null> {
    return await this.#queue.run(async () => {
      const attempt = await this.#attempts.create(input);
      await this.#attempts.append(attempt.attemptId, {
        kind: "phase",
        phase: "claimed",
        level: "info",
        event: "attempt.claimed",
        message: "attempt claimed",
      });
      return attempt.attemptId;
    });
  }

  async phase(attemptId: string, phase: "bound" | "ready" | "running" | "settled" | "reported" | "closed"): Promise<void> {
    await this.#queue.run(async () => {
      await this.#attempts.update(attemptId, { phase });
      await this.#attempts.append(attemptId, { kind: "phase", phase, level: "info", event: `attempt.${phase}` });
    });
  }

  async session(attemptId: string, sessionId: string, cwd: string): Promise<void> {
    await this.#queue.run(async () => {
      await this.#attempts.update(attemptId, { sessionId, cwd, phase: "bound", archiveStatus: "pending" });
      this.#attemptsBySession.set(sessionId, attemptId);
      await this.#attempts.append(attemptId, { kind: "phase", phase: "bound", level: "info", event: "session.started", data: { sessionId } });
      const attempt = await this.#attempts.get(attemptId);
      await writeSessionMeta(this.#stateRoot, {
        sessionId,
        attemptId,
        ...(attempt === null ? {} : {
          instanceId: attempt.instanceId,
          nodeId: attempt.nodeId,
          ...(attempt.runId === undefined ? {} : { runId: attempt.runId }),
          taskId: attempt.taskId,
        }),
        cwd,
        status: "running",
        startedAt: this.#now().toISOString(),
        finishedAt: null,
        archive: { status: "pending", sizeBytes: null, sha256: null },
      }).catch(ignore);
      this.#rich.publish(sessionId, { kind: "lifecycle", lifecycle: "session.started", data: { cwd } });
    });
  }

  async prompt(attemptId: string, sessionId: string, text: string): Promise<void> {
    await this.#queue.run(async () => {
      await this.#attempts.update(attemptId, { phase: "running" });
      await this.#attempts.append(attemptId, { kind: "phase", phase: "running", level: "info", event: "prompt.sent", data: { bytes: Buffer.byteLength(text, "utf8") } });
      this.#rich.publish(sessionId, { kind: "prompt", text: truncate(text, PROMPT_LIMIT), ...(Buffer.byteLength(text, "utf8") > PROMPT_LIMIT ? { truncated: true, originalBytes: Buffer.byteLength(text, "utf8") } : {}) });
    });
  }

  async observe(attemptId: string, sessionId: string, method: string, params: unknown): Promise<void> {
    await this.#queue.run(async () => {
      const mapped = this.#mapper.handle(sessionId, method, params);
      if (mapped.preview !== undefined) await this.#attempts.append(attemptId, mapped.preview);
      if (mapped.rich !== undefined) this.#rich.publish(sessionId, mapped.rich);
    });
  }

  async permission(sessionId: string, params: unknown, decision: "allow" | "deny"): Promise<void> {
    const attemptId = this.#attemptsBySession.get(sessionId);
    if (attemptId === undefined) return;
    await this.#queue.run(async () => {
      const mapped = this.#mapper.permission(sessionId, params, decision === "allow" ? "allow" : "reject");
      await this.#attempts.append(attemptId, mapped.preview);
      this.#rich.publish(sessionId, mapped.rich);
    });
  }

  async settle(attemptId: string, result: TaskResult): Promise<void> {
    await this.#queue.run(async () => {
      const status: AttemptStatus =
        result.status === "succeeded" ? "completed" : result.status === "cancelled" ? "cancelled" : result.status === "timeout" ? "timeout" : "failed";
      await this.#attempts.update(attemptId, {
        status,
        phase: "settled",
        finishedAt: result.finishedAt ?? this.#now().toISOString(),
        errorClass: result.error?.class ?? null,
      });
      await this.#attempts.append(attemptId, {
        kind: "result",
        level: result.status === "succeeded" ? "info" : "warn",
        event: "task.result",
        message: `task ${result.status}`,
        data: { status: result.status, stopReason: result.stopReason, errorClass: result.error?.class ?? null, code: result.error?.code ?? null },
      });
      if (result.sessionId !== undefined && result.sessionId !== "") {
        await writeSessionMeta(this.#stateRoot, {
          sessionId: result.sessionId,
          status,
          finishedAt: result.finishedAt ?? this.#now().toISOString(),
          eventCount: (await this.#attempts.get(attemptId))?.logCount,
        }).catch(ignore);
        this.#rich.publish(result.sessionId, { kind: "lifecycle", lifecycle: "prompt.result", stopReason: result.stopReason ?? undefined, ...(result.error === null ? {} : { error: { class: result.error.class, code: result.error.code, message: result.error.message } }) });
        this.#rich.publish(result.sessionId, { kind: "lifecycle", lifecycle: "session.closed" });
        this.#rich.close(result.sessionId, status);
      }
    });
  }

  async archive(attemptId: string, sessionId: string, dshHome: string): Promise<void> {
    const archived = await archiveSession({ stateRoot: this.#stateRoot, dshHome, sessionId }).catch(() => null);
    await this.#queue.run(async () => {
      if (archived === null) {
        this.#health?.fail();
        await this.#attempts.update(attemptId, { archiveStatus: "failed", archive: { status: "failed", sizeBytes: null, sha256: null } });
        return;
      }
      await this.#attempts.update(attemptId, {
        archiveStatus: "stored",
        archive: { status: "stored", sizeBytes: archived.sizeBytes, sha256: archived.sha256, sourceFile: archived.sourceFile },
      });
      this.#health?.ok();
      await writeSessionMeta(this.#stateRoot, {
        sessionId,
        archive: { status: "stored", sizeBytes: archived.sizeBytes, sha256: archived.sha256 },
      }).catch(ignore);
    });
  }
}

export type { SessionRichEventInput };
