import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAttemptStore } from "../../../src/components/observer/attempt-store.ts";
import { ObservationRecorder } from "../../../src/components/observer/recorder.ts";
import { SessionRichHub } from "../../../src/components/observer/rich-hub.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("观测记录器", () => {
  test("attempt/session/prompt/preview/rich/settle", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-recorder-"));
    roots.push(stateRoot);
    const attempts = new FileAttemptStore({ stateRoot });
    const rich = new SessionRichHub();
    const recorder = new ObservationRecorder({ stateRoot, attempts, rich });
    const attemptId = await recorder.startAttempt({ taskId: "t1", attemptNo: 1, instanceId: "i", nodeId: "n3", runId: "run-1", startedAt: "2026-11-17T10:00:00Z" });
    expect(attemptId).not.toBeNull();
    if (attemptId === null) return;
    await recorder.session(attemptId, "s1", "/ws");
    await recorder.prompt(attemptId, "s1", "do work");
    await recorder.observe(attemptId, "s1", "session/update", { update: { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "hello" } } });
    await recorder.observe(attemptId, "s1", "session/update", { update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "echo" } } });
    const events = await attempts.events(attemptId, { limit: 20 });
    expect(events.items.map((item) => item.event)).toContain("agent_message_chunk");
    expect(rich.snapshot("s1", 10).map((item) => item.kind)).toContain("message");
    expect(rich.snapshot("s1", 10).map((item) => item.kind)).toContain("tool_call");

    await recorder.settle(attemptId, {
      taskId: "t1", attempt: 1, status: "succeeded", message: "done", truncated: false,
      stopReason: "end_turn", usage: null, error: null, sessionId: "s1",
      startedAt: "2026-11-17T10:00:00Z", finishedAt: "2026-11-17T10:00:05Z",
    });
    const settled = await attempts.get(attemptId);
    expect(settled).toMatchObject({ status: "completed", phase: "settled", durationMs: 5000 });
    expect(rich.snapshot("s1", 10).map((item) => item.lifecycle)).toContain("prompt.result");
  });
});
