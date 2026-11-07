import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ProfileModel = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
};

export const S0_MODEL: ProfileModel = {
  provider: "hundsun-public",
  model: "hs-deepseek-flash-latest",
  baseUrl: "http://47.93.127.129:10088/v1",
  apiKeyEnv: "HUNDSUN_PUBLIC_API_KEY",
};

/**
 * 生成实例 profile 补丁（CMP-runtime §2.3）：全局技能根指向空目录，
 * 保留项目 `.dsh` / `.agents`；同时注入 S0 的模型路由。
 */
export async function writeProfilePatch(homeDir: string, model: ProfileModel = S0_MODEL): Promise<string> {
  const emptyRoot = join(homeDir, "empty");
  for (const name of ["dsh", "agents", "bundled"]) {
    await mkdir(join(emptyRoot, name), { recursive: true, mode: 0o700 });
  }
  const patchPath = join(homeDir, "af", "profile.skill-patch.yml");
  await mkdir(join(homeDir, "af"), { recursive: true, mode: 0o700 });
  const patch = [
    {
      id: "skill-filesystem",
      config: {
        dshHome: join(emptyRoot, "dsh"),
        agentsHome: join(emptyRoot, "agents"),
        bundledSkillDir: join(emptyRoot, "bundled"),
      },
    },
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          [model.provider]: {
            displayName: model.provider,
            apiKeyEnv: model.apiKeyEnv,
            api: "openai-completions",
            baseURL: model.baseUrl,
            models: [{ id: model.model, name: model.model }],
          },
        },
      },
    },
    { id: "agent-default-model", config: { provider: model.provider, model: model.model } },
  ];
  await writeFile(patchPath, JSON.stringify(patch, null, 2), { mode: 0o600 });
  return patchPath;
}
