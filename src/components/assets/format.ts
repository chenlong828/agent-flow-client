import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { AssetError } from "./errors.ts";

export type SkillFormatReport = {
  skills: string[];
};

/** 校验技能树：顶层 bundle `<name>/SKILL.md` 或平铺 `<name>.md`；嵌套/缺 frontmatter 判非法。 */
export async function validateSkillsTree(root: string): Promise<SkillFormatReport> {
  const skills: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findNestedSkill(path, 1);
      if (nested !== null) throw new AssetError("invalid_skill_format", `不支持嵌套技能：${nested}`);
      await readSkillName(join(path, "SKILL.md"));
      skills.push(entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      await readSkillName(path);
      skills.push(basename(entry.name, ".md"));
    }
  }
  return { skills };
}

async function findNestedSkill(dir: string, depth: number): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (await Bun.file(join(path, "SKILL.md")).exists()) return path;
    if (depth < 6) {
      const found = await findNestedSkill(path, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

export async function readSkillName(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new AssetError("invalid_skill_format", `缺少 SKILL.md：${path}`);
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (frontmatter === null) throw new AssetError("invalid_skill_format", `缺少 frontmatter：${path}`);
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(frontmatter[1] as string);
  } catch (error) {
    throw new AssetError("invalid_skill_format", `frontmatter 不是合法 YAML：${path}`);
  }
  const table = parsed as Record<string, unknown> | null;
  const name = table?.name;
  const description = table?.description;
  if (typeof name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new AssetError("invalid_skill_format", `技能 name 必须是 kebab-case：${path}`);
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new AssetError("invalid_skill_format", `技能 description 不能为空：${path}`);
  }
  return name;
}
