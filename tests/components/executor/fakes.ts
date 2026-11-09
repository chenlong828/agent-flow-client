import type {
  AssetPort,
  ContainerPaths,
  InstalledSkills,
  InstanceHandle,
  JournalPort,
  NodeResult,
  PromptOptions,
  SessionOutcome,
  SessionRef,
  SkillSet,
  WorkspacePort,
} from "../../../src/components/executor/ports.ts";
import type { SchedulerPort, Ack } from "../../../src/components/executor/scheduler-port.ts";
import type { AttemptRecord, AttemptState, InstanceId, OrphanRecord, Unlock } from "../../../src/components/executor/types.ts";

export const container: ContainerPaths = { root: "/tmp/afc-exec-container", skillRoot: "/tmp/afc-exec-container/.dsh/skills", stagingRoot: "/tmp/afc-exec-container/.dsh/.staging" };

export class MemoryJournal implements JournalPort {
  records: AttemptRecord[] = [];
  states: AttemptState[] = [];
  orphans: OrphanRecord[] = [];
  async append(record: AttemptRecord): Promise<void> {
    this.records.push(record);
    this.states.push(record.state);
  }
  async mark(attemptId: string, state: AttemptState, patch?: Partial<AttemptRecord>): Promise<void> {
    const latest = [...this.records].reverse().find((record) => record.attemptId === attemptId);
    this.records.push({ ...(latest as AttemptRecord), ...patch, state, ts: "2026-11-08T00:00:00.000Z" });
    this.states.push(state);
  }
  async pending(instanceId: InstanceId): Promise<AttemptRecord[]> {
    return this.records.filter((record) => record.instanceId === instanceId && !["closed", "abandoned"].includes(record.state));
  }
  async pendingAll(): Promise<AttemptRecord[]> {
    return this.records.filter((record) => !["closed", "abandoned"].includes(record.state));
  }
  async listInstances(): Promise<InstanceId[]> {
    return [...new Set(this.records.map((record) => record.instanceId))];
  }
  async lockInstance(_instanceId: InstanceId): Promise<Unlock> {
    return async () => undefined;
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
  behavior: "ok" | "hang" | "fail" = "ok";
  finalText = "OK";
  async ensureInstance(instance: { instanceId: string }): Promise<InstanceHandle> {
    return { instanceId: instance.instanceId, pid: 1234, pgid: 1234 };
  }
  async newSession(instance: InstanceHandle): Promise<SessionRef> {
    return { sessionId: "s-1", instanceId: instance.instanceId };
  }
  async prompt(session: SessionRef, text: string, opts: PromptOptions): Promise<SessionOutcome> {
    this.prompts.push(text);
    if (this.behavior === "ok") return { sessionId: session.sessionId, finalText: this.finalText, stopReason: "end_turn", usage: null };
    if (this.behavior === "fail") {
      return { sessionId: session.sessionId, finalText: "", stopReason: null, usage: null, error: { code: "spawn_failed", message: "x", class: "runtime" } };
    }
    await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { sessionId: session.sessionId, finalText: "", stopReason: null, usage: null, error: { code: "cancelled", message: "c", class: "cancelled" } };
  }
  async cancel(session: SessionRef): Promise<void> {
    this.cancelled.push(session.sessionId);
  }
  async closeSession(session: SessionRef): Promise<void> {
    this.closed.push(session.sessionId);
  }
  async shutdownInstance(instance: InstanceHandle): Promise<void> {
    this.shutdowns.push(instance.instanceId);
  }
}

export class FakeWorkspace implements WorkspacePort {
  cleaned: string[] = [];
  async ensureContainer(): Promise<ContainerPaths> {
    return container;
  }
  async validate() {
    return { ok: true, root: container.root, repos: [], issues: [] };
  }
  async resolve(_container: ContainerPaths, relPath: string): Promise<string> {
    return relPath;
  }
  async cleanup(_instance: InstanceHandle, policy: string): Promise<void> {
    this.cleaned.push(policy);
  }
}

export class FakeAssets implements AssetPort {
  installed: SkillSet[] = [];
  failWith: { code: string; message: string } | null = null;
  async install(skillSet: SkillSet): Promise<InstalledSkills> {
    if (this.failWith !== null) throw this.failWith;
    this.installed.push(skillSet);
    return { digest: skillSet.digest, skills: [], changed: true };
  }
  async verify() {
    return { ok: true, digest: "sha256:x" };
  }
  async currentDigest(): Promise<string | null> {
    return null;
  }
}

export class FakeScheduler implements SchedulerPort {
  bound: string[] = [];
  bindDigests = new Map<string, string>();
  reported: NodeResult[] = [];
  reportFails = false;
  async register() {
    return { serverTime: "", limits: { maxResultBytes: 1024, maxPromptBytes: 1024, maxRequestBytes: 1024, maxSkillPackageBytes: 1024, maxSkillPackages: 1 }, assignmentsVersion: 1, cleanupPending: [] };
  }
  async heartbeat() {
    return { serverTime: "", control: { seq: 0, events: [] }, cleanupPending: [], assignmentsVersion: 1, nextPollAfterMs: 1000 };
  }
  async claim() {
    return null;
  }
  async renew() {
    return { expiresAt: "", ttlMs: 1000 };
  }
  async bindSession(attemptId: string): Promise<SkillSet> {
    this.bound.push(attemptId);
    return { digest: this.bindDigests.get(attemptId) ?? "sha256:test", packages: [] };
  }
  async reportResult(_attemptId: string, result: NodeResult): Promise<Ack> {
    if (this.reportFails) throw new Error("unreachable");
    this.reported.push(result);
    return { attemptId: result.attemptId, disposition: "accepted", attemptState: "reported", recordedAt: "" };
  }
}
