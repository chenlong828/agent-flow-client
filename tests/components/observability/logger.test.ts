import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonLogger, redactRecord } from "../../../src/components/observability/logger.ts";

describe("结构化日志", () => {
  test("级别过滤与子 logger 关联键", () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ level: "info", stderr: (line) => lines.push(line) });
    logger.log({ level: "debug", event: "debug.event" });
    logger.log({ level: "info", event: "info.event" });
    const child = logger.child({ attemptId: "a-1", instanceId: "i-1" });
    child.log({ level: "warn", event: "child.event" });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ event: "child.event", attemptId: "a-1", instanceId: "i-1" });
  });

  test("凭据键脱敏，prompt/结果只留长度与摘要", () => {
    const redacted = redactRecord({ authorization: "Bearer secret", password: "p", prompt: "hello", message: "world", code: "x" });
    expect(redacted.authorization).toBe("[redacted]");
    expect(redacted.password).toBe("[redacted]");
    expect(redacted.prompt).toEqual({ bytes: 5, sha256: expect.any(String) });
    expect(redacted.message).toEqual({ bytes: 5, sha256: expect.any(String) });
    expect(redacted.code).toBe("x");
  });

  test("文件 sink 异步落盘，flush 后可按行解析", async () => {
    const root = await mkdtemp(join(tmpdir(), "afc-log-"));
    const filePath = join(root, "logs", "client.jsonl");
    const logger = new JsonLogger({ level: "debug", stderr: () => undefined, filePath });
    logger.log({ level: "info", event: "one" });
    logger.log({ level: "info", event: "two" });
    await logger.flush();
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["one", "two"]);
  });

  test("超过 maxBytes 轮转并保留备份", async () => {
    const root = await mkdtemp(join(tmpdir(), "afc-log-"));
    const filePath = join(root, "logs", "client.jsonl");
    const logger = new JsonLogger({ level: "info", stderr: () => undefined, filePath, maxBytes: 120, keep: 2 });
    for (let index = 0; index < 6; index += 1) logger.log({ level: "info", event: `event-${index}` });
    await logger.flush();
    const names = (await readdir(join(root, "logs"))).sort();
    expect(names).toContain("client.jsonl");
    expect(names.some((name) => name.startsWith("client.jsonl."))).toBe(true);
  });
});
