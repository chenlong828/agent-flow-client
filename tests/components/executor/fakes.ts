import type { AssetPort, ContainerPaths, InstalledSkills, InstanceHandle, JournalPort, PromptOptions, SessionLogPort, SessionOutcome, SessionRef, SkillPackageRef, WorkspacePort } from "../../../src/components/executor/ports.ts";
import type { InstanceId, OrphanRecord, TaskRecord, TaskResult, TaskState } from "../../../src/components/executor/types.ts";

export const container: ContainerPaths = {
  root: "/tmp/afc-v2-container",
  skillRoot: "/tmp/afc-v2-container/.dsh/skills",
  stagingRoot: "/tmp/afc-v2-container/.dsh/.staging",
};

export class MemoryJournal implements JournalPort {
  records: TaskRecord[] = [];
  states: TaskState[] = [];
  orphans: OrphanRecord[] = [];
  async append(record: TaskRecord): Promise<void> {
    this.records.push(record);
    this.states.push(record.state);
  }
  async mark(taskId: string, state: TaskState, patch?: Partial<TaskRecord>): Promise<void> {
    const latest = [...this.records].reverse().find((record) => record.taskId === taskId);
    this.records.push({ ...(latest as TaskRecord), ...patch, state, ts: "2026-11-10T00:00:00.000Z" });
    this.states.push(state);
  }
  async settled(): Promise<TaskRecord[]> {
    return this.records.filter((record) => record.state === "settled");
  }
  async recordOrphan(orphan: OrphanRecord): Promise<void> {
    this.orphans.push(orphan);
  }
  async listOrphans(instanceId?: InstanceId): Promise<OrphanRecord[]> {
    return this.orphans.filter((orphan) => instanceId === undefined || orphan.instanceId === instanceId);
  }
  async clearOrphan(pid: number): Promise<void> {
    this.orphans = this.orphans.filter((orphan) => orphan.pid !== pid);
  }
}

export class FakeRuntime {
  prompts: string[] = [];
  closed: string[] = [];
  cancelled: string[] = [];
  shutdowns: string[] = [];
  ensureCalls = 0;
  finalText = "OK";
  behavior: "ok" | "hang" | "fail" | "timeout" = "ok";
  readonly #sessions = new Set<string>();

  async ensureInstance(instance: { instanceId: string }): Promise<InstanceHandle> {
    this.ensureCalls += 1;
    return { instanceId: instance.instanceId, pid: 1234, pgid: 1234 };
  }
  async newSession(instance: InstanceHandle, _cwd: string): Promise<SessionRef> {
    const ref = { sessionId: `s-${this.#sessions.size + 1}`, instanceId: instance.instanceId };
    this.#sessions.add(ref.sessionId);
    return ref;
  }
  async prompt(session: SessionRef, text: string, opts: PromptOptions): Promise<SessionOutcome> {
    this.prompts.push(text);
    opts.onRawEvent?.({ ts: "2026-11-12T00:00:00.000Z", sessionId: session.sessionId, method: "session/update", params: { sessionId: session.sessionId, update: { sessionUpdate: "agent_message_chunk" } } });
    if (this.behavior === "ok") return { sessionId: session.sessionId, finalText: this.finalText, stopReason: "end_turn", usage: null };
    if (this.behavior === "fail") {
      return { sessionId: session.sessionId, finalText: "", stopReason: null, usage: null, error: { code: "prompt_failed", message: "x", class: "runtime" } };
    }
    if (this.behavior === "timeout") {
      return { sessionId: session.sessionId, finalText: "", stopReason: null, usage: null, error: { code: "timeout", message: "t", class: "timeout" } };
    }
    await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { sessionId: session.sessionId, finalText: "", stopReason: null, usage: null, error: { code: "cancelled", message: "c", class: "cancelled" } };
  }
  async cancel(session: SessionRef): Promise<void> {
    this.cancelled.push(session.sessionId);
  }
  async closeSession(session: SessionRef): Promise<void> {
    this.closed.push(session.sessionId);
    this.#sessions.delete(session.sessionId);
  }
  async shutdownInstance(instance: InstanceHandle): Promise<void> {
    this.shutdowns.push(instance.instanceId);
    this.#sessions.clear();
  }
  activeSessions(): number {
    return this.#sessions.size;
  }
}

export class FakeWorkspace implements WorkspacePort {
  taskSpaces: string[] = [];
  async ensureContainer(): Promise<ContainerPaths> {
    return container;
  }
  async validate() {
    return { ok: true, root: container.root, repos: [], issues: [] };
  }
  async resolve(_container: ContainerPaths, relPath: string): Promise<string> {
    return relPath;
  }
  async assertInsideWorkspace(_root: string, path: string): Promise<string> {
    return path;
  }
  async ensureTaskSpace(_root: string, path: string): Promise<string> {
    this.taskSpaces.push(path);
    return path;
  }
  async packTaskSpace(taskSpacePath: string, targetPath: string): Promise<{ path: string; bytes: number }> {
    this.taskSpaces.push(taskSpacePath);
    return { path: targetPath, bytes: 0 };
  }
}

export class FakeSessionLogs implements SessionLogPort {
  lines: string[] = [];
  async append(_taskId: string, _attempt: number, line: string): Promise<void> {
    this.lines.push(line);
  }
  async read(): Promise<Uint8Array | null> {
    return null;
  }
  async clear(): Promise<void> {
    this.lines = [];
  }
}

export class FakeAssets implements AssetPort {
  installed: string[] = [];
  failWith: { code: string; message: string } | null = null;
  async install(skillSet: { digest: string }): Promise<InstalledSkills> {
    if (this.failWith !== null) throw this.failWith;
    this.installed.push(skillSet.digest);
    return { digest: skillSet.digest, skills: [], changed: true };
  }
  async verify(_pkg: SkillPackageRef) {
    return { ok: true, digest: "sha256:x" };
  }
  async currentDigest(): Promise<string | null> {
    return null;
  }
}

export function makeResult(taskId: string, overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId,
    attempt: 1,
    status: "succeeded",
    message: "OK",
    truncated: false,
    stopReason: "end_turn",
    usage: null,
    error: null,
    ...overrides,
  };
}
