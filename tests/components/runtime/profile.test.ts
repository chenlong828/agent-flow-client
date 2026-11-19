import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S0_MODEL, writeProfilePatch, type ProfileModel } from "../../../src/components/runtime/profile.ts";

async function patchOf(model?: ProfileModel): Promise<Record<string, unknown>[]> {
  const home = await mkdtemp(join(tmpdir(), "afc-profile-"));
  const path = model === undefined ? await writeProfilePatch(home) : await writeProfilePatch(home, model);
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>[];
}

function modelEntry(patch: Record<string, unknown>[]): { id: string; name: string; input?: string[] } {
  const llm = patch.find((entry) => entry.id === "llm-pi-ai") as
    | { config: { providers: Record<string, { models: { id: string; name: string; input?: string[] }[] }> } }
    | undefined;
  const provider = llm?.config.providers["hundsun-public"];
  if (provider === undefined) throw new Error("profile 补丁缺少 llm-pi-ai 的 hundsun-public 路由");
  const entry = provider.models[0];
  if (entry === undefined) throw new Error("profile 补丁缺少模型条目");
  return entry;
}

describe("模型路由补丁", () => {
  test("S0 默认声明 text+image 两种输入模态", async () => {
    expect(S0_MODEL.input).toEqual(["text", "image"]);
    expect(modelEntry(await patchOf())).toEqual({
      id: "hs-deepseek-flash-latest",
      name: "hs-deepseek-flash-latest",
      input: ["text", "image"],
    });
  });

  test("自定义模型声明只透传自己的模态", async () => {
    const model: ProfileModel = {
      provider: "hundsun-public",
      model: "text-only",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnv: "KEY",
      input: ["text"],
    };
    expect(modelEntry(await patchOf(model)).input).toEqual(["text"]);
  });

  test("自定义模型未声明 input 时默认 text+image", async () => {
    const model: ProfileModel = {
      provider: "hundsun-public",
      model: "no-input-declared",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnv: "KEY",
    };
    expect(modelEntry(await patchOf(model)).input).toEqual(["text", "image"]);
  });
});
