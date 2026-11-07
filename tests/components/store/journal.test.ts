import { describe, expect, test } from "bun:test";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "../../../src/components/store/journal.ts";
import type { AttemptRecord, NodeResult } from "../../../src/components/executor/ports.ts";

function record(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    v: 1,
    ts: "2026-11-08T00:00:00.000Z",
    attemptId: "attempt-1",
    instanceId: "instance-1",
    nodeId: "node-1",
    state: "claimed",
    ...overrides,
  };
}

const successResult: NodeResult = {
  attemptId: "attempt-1",
  status: "succeeded",
  sessionId: "session-1",
  message: "OK",
  truncated: false,
  stopReason: "end_turn",
  usage: null,
  error: null,
};

describe("journal 追加与折叠", () => {
  test("按 attemptId 折叠最后状态；pending 排除终态", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-journal-"));
    const journal = new FileJournal({ stateRoot });
    await journal.init();

    await journal.append(record());
    await journal.mark("attempt-1", "running");
    await journal.mark("attempt-1", "settled", { result: successResult });

    const pending = await journal.pending("instance-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("settled");

    await journal.mark("attempt-1", "reported");
    await journal.mark("attempt-1", "closed");
    expect(await journal.pending("instance-1")).toEqual([]);
    expect(await journal.listInstances()).toEqual(["instance-1"]);
  });

  test("append 写一行且不覆盖", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-journal-"));
    const journal = new FileJournal({ stateRoot });
    await journal.init();
    await journal.append(record());
    await journal.append(record({ state: "bound" }));
    const text = await readFile(join(stateRoot, "journal.jsonl"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
  });

  test("损坏行降级跳过，不阻塞启动", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-journal-"));
    await writeFile(
      join(stateRoot, "journal.jsonl"),
      `${JSON.stringify(record())}\n{not-json\n${JSON.stringify(record({ state: "running" }))}\n`,
    );
    const journal = new FileJournal({ stateRoot });
    await journal.init();
    const pending = await journal.pending("instance-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("running");
  });

  test("compact 保留每个 attempt 最新记录", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-journal-"));
    const journal = new FileJournal({ stateRoot });
    await journal.init();
    await journal.append(record());
    await journal.append(record({ attemptId: "attempt-2", state: "running" }));
    await journal.mark("attempt-1", "running");
    await journal.mark("attempt-1", "settled", { result: successResult });
    await journal.compact();
    const lines = (await readFile(join(stateRoot, "journal.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const states = lines.map((line) => JSON.parse(line).state).sort();
    expect(states).toEqual(["running", "settled"]);
  });

  test("超过阈值自动压缩不死锁", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-journal-"));
    const journal = new FileJournal({ stateRoot, compactLines: 1 });
    await journal.init();
    await journal.append(record());
    await journal.append(record({ attemptId: "attempt-2" }));
    await journal.mark("attempt-1", "running");
    const lines = (await readFile(join(stateRoot, "journal.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("mark 不存在的 attempt 报错", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "afc-journal-"));
    const journal = new FileJournal({ stateRoot });
    await journal.init();
    await expect(journal.mark("missing", "running")).rejects.toThrow("不存在");
  });
});
