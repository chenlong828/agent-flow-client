import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFileReader, RunFileError } from "../../../src/components/workspace/files.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "afc-files-"));
  roots.push(root);
  await mkdir(join(root, "reports"));
  await writeFile(join(root, "reports", "a.md"), "# hello\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00]));
  return root;
}

describe("运行文件读取", () => {
  test("列表目录优先、截断标记", async () => {
    const root = await setup();
    const reader = new WorkspaceFileReader();
    const result = await reader.list({ root: "task-space", rootPath: root, path: "", limit: 10 });
    expect(result.entries.map((item) => item.name)).toEqual(["reports", "binary.bin"]);
    expect(result.entries[0]?.type).toBe("dir");
    expect(result.truncated).toBe(false);
  });

  test("读取文本；二进制只给元数据", async () => {
    const root = await setup();
    const reader = new WorkspaceFileReader();
    const text = await reader.read({ root: "task-space", rootPath: root, path: "reports/a.md", maxBytes: 1024 });
    expect(text).toMatchObject({ content: "# hello\n", encoding: "utf-8", binary: false, truncated: false });
    const binary = await reader.read({ root: "task-space", rootPath: root, path: "binary.bin", maxBytes: 1024 });
    expect(binary).toMatchObject({ content: null, encoding: null, binary: true });
  });

  test("路径逃逸/目录读取拒绝", async () => {
    const root = await setup();
    const reader = new WorkspaceFileReader();
    await expect(reader.read({ root: "task-space", rootPath: root, path: "../etc/passwd", maxBytes: 10 })).rejects.toBeInstanceOf(RunFileError);
    await expect(reader.read({ root: "task-space", rootPath: root, path: "reports", maxBytes: 10 })).rejects.toMatchObject({ code: "unsupported_file" });
  });

  test("超过 1 MiB 截断", async () => {
    const root = await setup();
    await writeFile(join(root, "big.txt"), "a".repeat(2 * 1024 * 1024));
    const reader = new WorkspaceFileReader();
    const result = await reader.read({ root: "task-space", rootPath: root, path: "big.txt", maxBytes: 1048576 });
    expect(result.truncated).toBe(true);
    expect(result.content?.length).toBe(1048576);
  });
});
