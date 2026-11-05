/**
 * 业务场景索引生成器/校验器。
 *
 * 源自 agent-flow-orchaster，按本仓库现状做了三处适配：
 * - entries/docs/tests/externalRefs 允许缺省为空数组，避免为了过校验先造占位；
 * - designed 场景允许 3+1 测试 ID 尚未落地；verified 场景仍要求测试真实存在；
 * - externalRefs 不再只支持 OpenAPI operation，只校验引用文件存在。
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

type ScenarioEntry = {
  component: string;
  path: string;
  symbol: string;
};

type DocRef = {
  path: string;
  heading: string;
};

type TestRef = {
  role: string;
  id: string;
};

type ExternalRef = {
  path: string;
  anchor: string;
  kind: string;
};

type Scenario = {
  file: string;
  domain: string;
  valueStream: string;
  title: string;
  status: string;
  flow: string;
  id: string;
  updated: string;
  entries: ScenarioEntry[];
  docs: DocRef[];
  tests: TestRef[];
  externalRefs: ExternalRef[];
};

const root = process.cwd();
const scenariosRoot = join(root, "docs/design/scenarios");
const indexFile = join(scenariosRoot, "_index.md");
const check = process.argv.includes("--check");

function fail(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} 必须是非空字符串`);
  }
  return value;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} 必须是数组`);
  return value;
}

function asOptionalArray(value: unknown, label: string): unknown[] {
  return value === undefined ? [] : asArray(value, label);
}

async function readText(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) fail(`文件不存在：${path}`);
  return file.text();
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path, suffix)));
    else if (entry.name.endsWith(suffix)) out.push(path);
  }
  return out.sort();
}

function parseFrontmatter(text: string, file: string): Record<string, unknown> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match === null) fail(`${file} 缺少 frontmatter`);
  const parsed = Bun.YAML.parse(match[1]!);
  return asRecord(parsed, `${file} frontmatter`);
}

function headings(text: string): Set<string> {
  const result = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match) result.add(match[2]!.trim());
  }
  return result;
}

function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function hasExportedSymbol(_file: string, symbol: string, text: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`export\\s+(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`export\\s+class\\s+${escaped}\\b`),
    new RegExp(`export\\s+(?:interface|type|enum)\\s+${escaped}\\b`),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

async function loadTests(): Promise<Map<string, { file: string; title: string }>> {
  const files = await listFiles(join(root, "tests"), ".test.ts");
  const found = new Map<string, { file: string; title: string }>();
  for (const file of files) {
    const text = await readText(file);
    const pattern = /test\(\s*["']((TC-[A-Z]+-\d{3})\b[^"']*)["']/g;
    for (const match of text.matchAll(pattern)) {
      const title = match[1]!;
      const id = match[2]!;
      if (found.has(id)) fail(`测试 ID 重复：${id}（${found.get(id)!.file} / ${relative(root, file)}）`);
      found.set(id, { file: relative(root, file), title });
    }
  }
  return found;
}

function validateFlow(flow: string, file: string): void {
  if (!/^FLOW-[A-Z0-9-]+$/.test(flow)) fail(`${file} flow 格式非法：${flow}`);
}

function validateScenarioPath(relativePath: string): void {
  const parts = relativePath.replaceAll("\\", "/").split("/");
  if (
    parts.length !== 7 ||
    parts[0] !== "docs" ||
    parts[1] !== "design" ||
    parts[2] !== "scenarios" ||
    parts[6] !== "scenario.md"
  ) {
    fail(`场景路径必须是 docs/design/scenarios/<业务域>/<价值流>/<场景>/scenario.md：${relativePath}`);
  }
}

async function loadScenarios(testIndex: Map<string, { file: string; title: string }>): Promise<Scenario[]> {
  const files = await listFiles(scenariosRoot, "scenario.md");
  if (files.length === 0) fail("没有找到 scenario.md");
  const ids = new Set<string>();
  const result: Scenario[] = [];
  for (const absolute of files) {
    const file = relative(root, absolute);
    validateScenarioPath(file);
    const frontmatter = parseFrontmatter(await readText(absolute), file);
    if (frontmatter.layer !== "design") fail(`${file} layer 必须是 design`);
    const status = asString(frontmatter.status, `${file} status`);
    if (!["draft", "designed", "verified"].includes(status)) {
      fail(`${file} status 非法：${status}`);
    }
    const isDraft = status === "draft";
    const id = asString(frontmatter.scenario, `${file} scenario`);
    if (!/^SCN-\d{4}$/.test(id)) fail(`${file} scenario 格式非法：${id}`);
    if (ids.has(id)) fail(`场景 ID 重复：${id}`);
    ids.add(id);
    const flow = asString(frontmatter.flow, `${file} flow`);
    validateFlow(flow, file);
    const entries = asOptionalArray(frontmatter.entries, `${file} entries`).map((raw, index) => {
      const item = asRecord(raw, `${file} entries[${index}]`);
      return {
        component: asString(item.component, `${file} entries[${index}].component`),
        path: asString(item.path, `${file} entries[${index}].path`),
        symbol: asString(item.symbol, `${file} entries[${index}].symbol`),
      };
    });
    for (const entry of entries) {
      const entryPath = join(root, entry.path);
      const text = await readText(entryPath);
      if (!hasExportedSymbol(entryPath, entry.symbol, text)) {
        fail(`${file} 入口符号不存在：${entry.path}#${entry.symbol}`);
      }
    }
    const docs = asOptionalArray(frontmatter.docs, `${file} docs`).map((raw, index) => {
      const item = asRecord(raw, `${file} docs[${index}]`);
      return {
        path: asString(item.path, `${file} docs[${index}].path`),
        heading: asString(item.heading, `${file} docs[${index}].heading`),
      };
    });
    for (const doc of docs) {
      const docPath = join(root, doc.path);
      const text = await readText(docPath);
      if (!headings(text).has(doc.heading)) {
        fail(`${file} 文档章节不存在：${doc.path}#${doc.heading}`);
      }
    }
    const tests = asOptionalArray(frontmatter.tests, `${file} tests`).map((raw, index) => {
      const item = asRecord(raw, `${file} tests[${index}]`);
      return {
        role: asString(item.role, `${file} tests[${index}].role`),
        id: asString(item.id, `${file} tests[${index}].id`),
      };
    });
    if (!isDraft) {
      const roles = tests.map((test) => test.role).sort().join(",");
      if (roles !== "N1,R1,R2,R3") fail(`${file} tests 必须是 R1/R2/R3/N1`);
    }
    const pendingTests: string[] = [];
    for (const test of tests) {
      if (!/^TC-[A-Z]+-\d{3}$/.test(test.id)) fail(`${file} 测试 ID 格式非法：${test.id}`);
      if (!testIndex.has(test.id)) {
        if (status === "verified") fail(`${file} 测试 ID 不存在：${test.id}`);
        pendingTests.push(test.id);
      }
    }
    if (pendingTests.length > 0) {
      console.warn(`${file} 测试待实现：${pendingTests.join(", ")}`);
    }
    const externalRefs = asOptionalArray(frontmatter.externalRefs, `${file} externalRefs`).map(
      (raw, index) => {
        const item = asRecord(raw, `${file} externalRefs[${index}]`);
        return {
          path: asString(item.path, `${file} externalRefs[${index}].path`),
          anchor: asString(item.anchor, `${file} externalRefs[${index}].anchor`),
          kind: asString(item.kind, `${file} externalRefs[${index}].kind`),
        };
      },
    );
    for (const ref of externalRefs) {
      await readText(join(root, ref.path));
    }
    result.push({
      file,
      domain: asString(frontmatter.domain, `${file} domain`),
      valueStream: asString(frontmatter.valueStream, `${file} valueStream`),
      title: asString(frontmatter.title, `${file} title`),
      status,
      flow,
      id,
      updated: asString(frontmatter.updated, `${file} updated`),
      entries,
      docs,
      tests,
      externalRefs,
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function docLink(path: string, heading: string): string {
  const relativePath = relative(scenariosRoot, join(root, path)).replaceAll("\\", "/");
  return `${relativePath}#${githubSlug(heading)}`;
}

function render(scenarios: Scenario[]): string {
  const updated = scenarios.map((scenario) => scenario.updated).sort().at(-1) ?? "1970-01-01";
  const lines: string[] = [
    "---",
    "layer: design",
    "module: global",
    "status: current",
    "generated: true",
    `updated: ${updated}`,
    "---",
    "",
    "# 业务场景索引",
    "",
    "> 生成物，不手改。修改场景后运行 `bun run docs:index`；校验运行 `bun run docs:check`。",
    "",
    `共 ${scenarios.length} 个场景。`,
  ];
  const domains = new Map<string, Scenario[]>();
  for (const scenario of scenarios) {
    const list = domains.get(scenario.domain) ?? [];
    list.push(scenario);
    domains.set(scenario.domain, list);
  }
  for (const [domain, domainScenarios] of domains) {
    lines.push("", `## ${domain}`);
    const streams = new Map<string, Scenario[]>();
    for (const scenario of domainScenarios) {
      const list = streams.get(scenario.valueStream) ?? [];
      list.push(scenario);
      streams.set(scenario.valueStream, list);
    }
    for (const [stream, streamScenarios] of streams) {
      lines.push("", `### ${stream}`, "", "| 场景 | 状态 | 流程设计 | 代码入口 | 文档 | 测试 | 外部引用 |", "|---|---|---|---|---|---|---|");
      for (const scenario of streamScenarios) {
        const relativeScenario = scenario.file.replace(/^docs\/design\/scenarios\//, "");
        const scenarioPath = relativeScenario.split("/").slice(0, 3).join("/");
        const scenarioRoot = `${scenarioPath}/scenario.md`;
        const scenarioLink = `[${scenario.id} ${scenario.title}](${scenarioRoot})`;
        const flowLink = `[scenario.md#3 运行序](${scenarioRoot}#3-运行序)`;
        const pending = (value: string) =>
          value === "" && scenario.status === "draft" ? "待实现" : value;
        const entries = pending(
          scenario.entries
            .map((entry) => `\`${entry.component} ${entry.path}#${entry.symbol}\``)
            .join("<br>"),
        );
        const docs = pending(
          scenario.docs
            .map((doc) => `[${doc.path}#${doc.heading}](${docLink(doc.path, doc.heading)})`)
            .join("<br>"),
        );
        const tests = pending(
          scenario.tests
            .map((test) => {
              const found = scenarioTestIndex.get(test.id);
              if (!found) return `\`${test.role} ${test.id}\`（待实现）`;
              const title = found.title.replace(`${test.id} `, "").trim();
              return `\`${test.role} ${test.id}\`${title ? ` ${title}` : ""}`;
            })
            .join("<br>"),
        );
        const refs = pending(
          scenario.externalRefs
            .map((ref) => `\`${ref.path}#${ref.anchor}\``)
            .join("<br>"),
        );
        lines.push(
          `| ${scenarioLink} | ${scenario.status} | ${flowLink} | ${entries} | ${docs} | ${tests} | ${refs} |`,
        );
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

const scenarioTestIndex = await loadTests();
const scenarios = await loadScenarios(scenarioTestIndex);
const output = render(scenarios);
if (check) {
  const existing = (await Bun.file(indexFile).exists()) ? await Bun.file(indexFile).text() : "";
  if (existing !== output) {
    console.error("场景索引过期：运行 `bun run docs:index` 后重新提交。");
    process.exit(1);
  }
  console.log(`场景索引已是最新：${scenarios.length} 个场景`);
} else {
  await Bun.write(indexFile, output);
  console.log(`已生成 ${relative(root, indexFile)}：${scenarios.length} 个场景`);
}
