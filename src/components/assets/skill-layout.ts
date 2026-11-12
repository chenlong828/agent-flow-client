import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { AssetError } from "./errors.ts";
import { readSkillName } from "./format.ts";
import { exists } from "./installed.ts";

/**
 * 把一个已落地的技能包并入技能集根目录（CMP-assets §2.1）：
 *
 * - 包根有 `SKILL.md`：编排侧 `P-03` 包的形状（单技能，附件在 `scripts/`、`references/`），
 *   按 frontmatter `name` 改名为 `<name>/`，让每个技能有独立目录（DSH 也按该目录解析资源）；
 * - 否则按「多技能树」逐项并入：兼容 S0 本地目录来源的 `<name>/SKILL.md` / `<name>.md`。
 *
 * 目标已存在视为技能名冲突：报错而不是覆盖（覆盖会让前一个技能静默消失，摘要校验也发现不了）。
 */
export async function mergePackageRoot(packageRoot: string, skillsRoot: string): Promise<void> {
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const skillFile = entries.find((entry) => entry.name === "SKILL.md");
  if (skillFile !== undefined && skillFile.isFile()) {
    const name = await readSkillName(join(packageRoot, "SKILL.md"));
    await moveTo(packageRoot, join(skillsRoot, name), name);
    return;
  }
  for (const entry of entries) {
    await moveTo(join(packageRoot, entry.name), join(skillsRoot, entry.name), entry.name);
  }
}

async function moveTo(source: string, target: string, label: string): Promise<void> {
  if (await exists(target)) {
    throw new AssetError("invalid_skill_format", `技能名冲突：${label}（多个包解析到同一技能名，拒绝覆盖）`);
  }
  await rename(source, target);
}
