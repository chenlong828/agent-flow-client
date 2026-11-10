import { describe, expect, test } from "bun:test";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "../../../src/components/store/journal.ts";
import type { TaskRecord, TaskResult } from "../../../src/components/executor/types.ts";

const result: TaskResult = {
  taskId: "task-1",
  attempt: 1,
  status: "succeeded",
  message: "OK",
  truncated: false,
  stopReason: "end_turn",
  usage: null,
  error: null,
};

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    v: 2,
    ts: "2026-11-10T00:00:00.000Z",
    taskId: "task-1",
    attempt: 1,
    instanceId: "instance-1",
    nodeId: "node-1",
    state: "received",
    ...overrides,
  };
}

describe("v2 journal", () => {
  test("折叠最后状态；settled 只返回结果未确认的任务", async () => {
    const root = await mkdtemp(join(tmpdir(), "afc-v2-journal-"));
    const journal = new FileJournal({ stateRoot: root });
    await journal.init();
    await journal.append(record());
    await journal.mark("task-1", "running");
    await journal.mark("task-1", "settled", { result });
    expect((await journal.settled()).map((item) => item.taskId)).toEqual(["task-1"]);
    await journal.mark("task-1", "reported");
    expect(await journal.settled()).toEqual([]);
  });

  test("损坏行与 v1 记录被忽略", async () => {
    const root = await mkdtemp(join(tmpdir(), "afc-v2-journal-"));
    await writeFile(
      join(root, "journal.jsonl"),
      `${JSON.stringify(record())}\n{broken\n${JSON.stringify({ v: 1, attemptId: "old", state: "settled" })}\n`,
    );
    const journal = new FileJournal({ stateRoot: root });
    await journal.init();
    await journal.mark("task-1", "running");
    const text = await readFile(join(root, "journal.jsonl"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(4);
  });

  test("mark 不存在的任务报错", async () => {
    const root = await mkdtemp(join(tmpdir(), "afc-v2-journal-"));
    const journal = new FileJournal({ stateRoot: root });
    await journal.init();
    await expect(journal.mark("missing", "running")).rejects.toThrow("不存在");
  });
});
