import { readdir, stat } from "node:fs/promises";

export function digestSlug(digest: string): string {
  return digest.replace(/^sha256:/, "").slice(0, 20) || "empty";
}

export async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true).catch(() => false);
}

export async function installedNames(skillRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(skillRoot, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => (entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/, "")));
  } catch {
    return [];
  }
}
