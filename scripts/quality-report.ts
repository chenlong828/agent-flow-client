// @ts-nocheck -- 工具脚本使用 TypeScript 7 的 unstable AST API，类型不在产品 tsconfig 内。
/**
 * 轻量质量报告：只检查语法与方法结构，不依赖 oxlint/knip/jscpd/ts-morph/
 * pgsql-ast-parser，也不读 OpenAPI、数据库或 git。
 *
 * 输入：tsconfig.json 覆盖的 src/ 源文件；输出：指标表 + 违规明细。
 * 规则是启发式的 AST 计数，不用来替代测试或评审。
 */
import { API } from "typescript/unstable/async";
import {
  SyntaxKind,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isCaseClause,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isConstructorDeclaration,
  isDoStatement,
  isExportAssignment,
  isExportDeclaration,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIfStatement,
  isImportDeclaration,
  isMethodDeclaration,
  isNonNullExpression,
  isPropertyAccessExpression,
  isSetAccessorDeclaration,
  isSwitchStatement,
  isTryStatement,
  isVariableStatement,
  isWhileStatement,
} from "typescript/unstable/ast";
import { join, relative, sep } from "node:path";

type Status = "PASS" | "WARN" | "ERROR" | "INFO";

type Metric = {
  id: string;
  name: string;
  value: string;
  threshold: string;
  status: Status;
  detail?: string;
};

type SourceFileInfo = {
  path: string;
  rel: string;
  text: string;
  sf: any;
  starts: number[];
  lines: number;
};

type Finding = { file: string; line: number; text: string };

const root = process.cwd();
const tsconfig = join(root, "tsconfig.json");
const sourceRoot = join(root, "src");
const gate = process.argv.includes("--gate");
const metrics: Metric[] = [];
const sections: { title: string; rows: string[]; info?: boolean }[] = [];

function add(
  id: string,
  name: string,
  value: string,
  threshold: string,
  ok: boolean,
  detail = "",
  status?: Status,
): void {
  metrics.push({ id, name, value, threshold, status: status ?? (ok ? "PASS" : "WARN"), detail });
}

function section(title: string, rows: string[], info = false): void {
  if (rows.length > 0) sections.push({ title, rows, info });
}

function fail(message: string): never {
  throw new Error(message);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid]! <= position) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function lineCount(text: string): number {
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function hasModifier(node: any, kind: number): boolean {
  return (node.modifiers ?? []).some((modifier: any) => modifier.kind === kind);
}

function isFunctionLike(node: any): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  );
}

function isClassLike(node: any): boolean {
  return isClassDeclaration(node) || isClassExpression(node);
}

function isControlFlow(node: any): boolean {
  return (
    isIfStatement(node) ||
    isForStatement(node) ||
    isForInStatement(node) ||
    isForOfStatement(node) ||
    isWhileStatement(node) ||
    isDoStatement(node) ||
    isSwitchStatement(node) ||
    isTryStatement(node)
  );
}

function isDecision(node: any): boolean {
  if (
    isIfStatement(node) ||
    isConditionalExpression(node) ||
    isForStatement(node) ||
    isForInStatement(node) ||
    isForOfStatement(node) ||
    isWhileStatement(node) ||
    isDoStatement(node) ||
    isCaseClause(node) ||
    isCatchClause(node)
  ) {
    return true;
  }
  if (isBinaryExpression(node)) {
    const kind = node.operatorToken?.kind;
    return (
      kind === SyntaxKind.AmpersandAmpersandToken ||
      kind === SyntaxKind.BarBarToken ||
      kind === SyntaxKind.QuestionQuestionToken
    );
  }
  return false;
}

function walk(node: any, visit: (child: any) => void): void {
  visit(node);
  node.forEachChild((child: any) => walk(child, visit));
}

function functionName(node: any, file: SourceFileInfo): string {
  if (node.name) return String(node.name.getText(file.sf));
  return "<anonymous>";
}

type FunctionStats = {
  file: SourceFileInfo;
  name: string;
  line: number;
  lines: number;
  params: number;
  depth: number;
  complexity: number;
};

function analyzeFunction(node: any, file: SourceFileInfo): FunctionStats {
  const start = node.getStart(file.sf);
  const end = node.getEnd();
  const body = node.body;
  let depth = 0;
  let complexity = 1;

  if (body) {
    const visit = (current: any, currentDepth: number): void => {
      if (current !== body && isFunctionLike(current)) return;
      const nextDepth = isControlFlow(current) ? currentDepth + 1 : currentDepth;
      if (nextDepth > depth) depth = nextDepth;
      if (isDecision(current)) complexity += 1;
      current.forEachChild((child: any) => visit(child, nextDepth));
    };
    visit(body, 0);
  }

  return {
    file,
    name: functionName(node, file),
    line: lineAt(file.starts, start),
    lines: lineAt(file.starts, Math.max(start, end - 1)) - lineAt(file.starts, start) + 1,
    params: node.parameters?.length ?? 0,
    depth,
    complexity,
  };
}

function countDirectExports(file: SourceFileInfo): number {
  let total = 0;
  for (const statement of file.sf.statements) {
    if (isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier) {
        total += statement.exportClause?.elements?.length ?? 1;
      }
      continue;
    }
    if (isExportAssignment(statement)) {
      total += 1;
      continue;
    }
    if (!hasModifier(statement, SyntaxKind.ExportKeyword)) continue;
    if (isVariableStatement(statement)) {
      total += statement.declarationList.declarations.length;
    } else {
      total += 1;
    }
  }
  return total;
}

function countFunctions(file: SourceFileInfo): number {
  let total = 0;
  walk(file.sf, (node) => {
    if (isFunctionLike(node)) total += 1;
  });
  return total;
}

function findAny(file: SourceFileInfo): Finding[] {
  const result: Finding[] = [];
  walk(file.sf, (node) => {
    if (node.kind === SyntaxKind.AnyKeyword) {
      result.push({ file: file.rel, line: lineAt(file.starts, node.getStart(file.sf)), text: "any" });
    }
  });
  return result;
}

function findNonNull(file: SourceFileInfo): Finding[] {
  const result: Finding[] = [];
  walk(file.sf, (node) => {
    if (isNonNullExpression(node)) {
      result.push({
        file: file.rel,
        line: lineAt(file.starts, node.getStart(file.sf)),
        text: node.getText(file.sf).slice(0, 90),
      });
    }
  });
  return result;
}

function findConsole(file: SourceFileInfo): Finding[] {
  if (file.rel === "src/cli.ts" || file.rel.startsWith(`src/cli${sep}`)) return [];
  const result: Finding[] = [];
  walk(file.sf, (node) => {
    if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return;
    const target = node.expression.expression;
    if (target.getText(file.sf) !== "console") return;
    result.push({
      file: file.rel,
      line: lineAt(file.starts, node.getStart(file.sf)),
      text: node.getText(file.sf).slice(0, 90),
    });
  });
  return result;
}

function findTodo(file: SourceFileInfo): Finding[] {
  const result: Finding[] = [];
  for (const match of file.text.matchAll(/\b(TODO|FIXME)\b/g)) {
    result.push({
      file: file.rel,
      line: lineAt(file.starts, match.index ?? 0),
      text: match[0],
    });
  }
  return result;
}

function findTsComments(file: SourceFileInfo): Finding[] {
  const result: Finding[] = [];
  for (const match of file.text.matchAll(/@ts-(?:ignore|expect-error)\b/g)) {
    result.push({
      file: file.rel,
      line: lineAt(file.starts, match.index ?? 0),
      text: match[0],
    });
  }
  return result;
}

function maxBy<T>(items: T[], value: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const current = value(item);
    if (current > bestValue) {
      best = item;
      bestValue = current;
    }
  }
  return best;
}

async function main(): Promise<void> {
  const api = new API();
  let files: SourceFileInfo[] = [];
  const testSources: SourceFileInfo[] = [];
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [tsconfig] });
    const project = snapshot.getProject(tsconfig);
    if (!project) fail(`tsconfig 未加载：${tsconfig}`);

    const names = await project.program.getSourceFileNames();
    for (const name of names) {
      const rel = relative(root, name);
      if (!name.endsWith(".ts")) continue;
      const inSrc = rel.startsWith(`src${sep}`);
      const inTests = rel.startsWith(`tests${sep}`) && name.endsWith(".test.ts");
      if (!inSrc && !inTests) continue;
      const sf = await project.program.getSourceFile(name);
      if (!sf) continue;
      const info: SourceFileInfo = {
        path: name,
        rel: rel.split(sep).join("/"),
        text: sf.text,
        sf,
        starts: lineStarts(sf.text),
        lines: lineCount(sf.text),
      };
      if (inSrc) files.push(info);
      else testSources.push(info);
    }
  } finally {
    await api.close();
  }

  if (files.length === 0) fail("没有找到 src 下的 TypeScript 源文件");

  const functions: FunctionStats[] = [];
  const classes: { file: SourceFileInfo; name: string; methods: number }[] = [];
  for (const file of files) {
    walk(file.sf, (node) => {
      if (isFunctionLike(node)) functions.push(analyzeFunction(node, file));
      if (isClassLike(node)) {
        const methods = (node.members ?? []).filter(
          (member: any) =>
            isMethodDeclaration(member) ||
            isConstructorDeclaration(member) ||
            isGetAccessorDeclaration(member) ||
            isSetAccessorDeclaration(member),
        ).length;
        classes.push({
          file,
          name: node.name?.getText(file.sf) ?? "<anonymous>",
          methods,
        });
      }
    });
  }

  const longestFile = maxBy(files, (file) => file.lines);
  const longestFunction = maxBy(functions, (fn) => fn.lines);
  const mostParams = maxBy(functions, (fn) => fn.params);
  const deepest = maxBy(functions, (fn) => fn.depth);
  const mostComplex = maxBy(functions, (fn) => fn.complexity);
  const mostExports = maxBy(files, (file) => countDirectExports(file));
  const mostImports = maxBy(files, (file) => (file.sf.statements ?? []).filter(isImportDeclaration).length);
  const mostFunctions = maxBy(files, (file) => countFunctions(file));
  const mostMethods = maxBy(classes, (item) => item.methods);

  const anyFindings: Finding[] = [];
  const tsFindings: Finding[] = [];
  const nonNullFindings: Finding[] = [];
  const consoleFindings: Finding[] = [];
  const todoFindings: Finding[] = [];
  for (const file of files) {
    anyFindings.push(...findAny(file));
    tsFindings.push(...findTsComments(file));
    nonNullFindings.push(...findNonNull(file));
    consoleFindings.push(...findConsole(file));
    todoFindings.push(...findTodo(file));
  }

  const testFiles = testSources;
  const weakFindings: Finding[] = [];
  const skipFindings: Finding[] = [];
  for (const file of testFiles) {
    for (const match of file.text.matchAll(/\.(?:toBeDefined|toBeTruthy)\s*\(/g)) {
      weakFindings.push({
        file: file.rel,
        line: lineAt(file.starts, match.index ?? 0),
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/\b(?:describe|it|test)\.(?:skip|todo)\s*\(/g)) {
      skipFindings.push({
        file: file.rel,
        line: lineAt(file.starts, match.index ?? 0),
        text: match[0],
      });
    }
  }

  add(
    "Q-01",
    "文件行数最大值",
    longestFile ? `${longestFile.lines}（${longestFile.rel}）` : "无源文件",
    "≤600（>500 提醒）",
    (longestFile?.lines ?? 0) <= 600,
    files.filter((file) => file.lines > 500).length > 0
      ? `>500 的文件 ${files.filter((file) => file.lines > 500).length} 个`
      : "",
  );
  add(
    "Q-02",
    "函数行数最大值",
    longestFunction ? `${longestFunction.lines}（${longestFunction.file.rel}:${longestFunction.line} ${longestFunction.name}）` : "无函数",
    "≤80",
    (longestFunction?.lines ?? 0) <= 80,
  );
  add(
    "Q-03",
    "函数参数最大值",
    mostParams ? `${mostParams.params}（${mostParams.file.rel}:${mostParams.line} ${mostParams.name}）` : "无函数",
    "≤5",
    (mostParams?.params ?? 0) <= 5,
  );
  add(
    "Q-04",
    "嵌套深度最大值",
    deepest ? `${deepest.depth}（${deepest.file.rel}:${deepest.line} ${deepest.name}）` : "无函数",
    "≤4",
    (deepest?.depth ?? 0) <= 4,
  );
  add(
    "Q-05",
    "圈复杂度最大值",
    mostComplex ? `${mostComplex.complexity}（${mostComplex.file.rel}:${mostComplex.line} ${mostComplex.name}）` : "无函数",
    "≤15",
    (mostComplex?.complexity ?? 0) <= 15,
  );
  add(
    "Q-06",
    "单文件直接导出最大值",
    mostExports ? `${countDirectExports(mostExports)}（${mostExports.rel}）` : "0",
    "≤20",
    (mostExports ? countDirectExports(mostExports) : 0) <= 20,
  );
  add(
    "Q-07",
    "单文件 import 最大值",
    mostImports ? `${(mostImports.sf.statements ?? []).filter(isImportDeclaration).length}（${mostImports.rel}）` : "0",
    "≤20",
    (mostImports ? (mostImports.sf.statements ?? []).filter(isImportDeclaration).length : 0) <= 20,
  );
  add(
    "Q-08",
    "单文件函数数量最大值",
    mostFunctions ? `${countFunctions(mostFunctions)}（${mostFunctions.rel}）` : "0",
    "≤20",
    (mostFunctions ? countFunctions(mostFunctions) : 0) <= 20,
  );
  add(
    "Q-09",
    "单类方法数量最大值",
    mostMethods ? `${mostMethods.methods}（${mostMethods.file.rel} ${mostMethods.name}）` : "无类",
    "≤10",
    (mostMethods?.methods ?? 0) <= 10,
  );
  add(
    "Q-10",
    "显式 any",
    String(anyFindings.length),
    "0",
    anyFindings.length === 0,
    anyFindings.slice(0, 5).map((item) => `${item.file}:${item.line}`).join("; "),
  );
  add(
    "Q-11",
    "ts-ignore / ts-expect-error",
    String(tsFindings.length),
    "0",
    tsFindings.length === 0,
    tsFindings.slice(0, 5).map((item) => `${item.file}:${item.line}`).join("; "),
  );
  add(
    "Q-12",
    "非空断言 !",
    String(nonNullFindings.length),
    "0",
    nonNullFindings.length === 0,
    nonNullFindings.slice(0, 5).map((item) => `${item.file}:${item.line}`).join("; "),
  );
  add(
    "Q-13",
    "非入口 console 调用",
    String(consoleFindings.length),
    "0（src/cli/ 除外）",
    consoleFindings.length === 0,
    consoleFindings.slice(0, 5).map((item) => `${item.file}:${item.line}`).join("; "),
  );
  add(
    "Q-14",
    "TODO / FIXME",
    String(todoFindings.length),
    "仅报告",
    true,
    "",
    "INFO",
  );
  add(
    "Q-15",
    "弱断言 toBeDefined/toBeTruthy",
    testFiles.length === 0 ? "未找到测试文件" : String(weakFindings.length),
    "0",
    testFiles.length > 0 && weakFindings.length === 0,
    testFiles.length === 0 ? "tests/**/*.test.ts 不存在" : "",
    testFiles.length === 0 ? "ERROR" : undefined,
  );
  add(
    "Q-16",
    "skip / todo 测试",
    testFiles.length === 0 ? "未找到测试文件" : String(skipFindings.length),
    "0",
    testFiles.length > 0 && skipFindings.length === 0,
    testFiles.length === 0 ? "tests/**/*.test.ts 不存在" : "",
    testFiles.length === 0 ? "ERROR" : undefined,
  );

  section(
    "文件超过 500 行",
    files
      .filter((file) => file.lines > 500)
      .sort((a, b) => b.lines - a.lines)
      .map((file) => `${file.rel}:1  ${file.lines} 行`),
  );
  section(
    "函数行数超过 80",
    functions
      .filter((fn) => fn.lines > 80)
      .map((fn) => `${fn.file.rel}:${fn.line}  ${fn.name}  ${fn.lines} 行`),
  );
  section(
    "函数参数超过 5",
    functions
      .filter((fn) => fn.params > 5)
      .map((fn) => `${fn.file.rel}:${fn.line}  ${fn.name}  ${fn.params} 个参数`),
  );
  section(
    "嵌套深度超过 4",
    functions
      .filter((fn) => fn.depth > 4)
      .map((fn) => `${fn.file.rel}:${fn.line}  ${fn.name}  ${fn.depth} 层`),
  );
  section(
    "圈复杂度超过 15",
    functions
      .filter((fn) => fn.complexity > 15)
      .map((fn) => `${fn.file.rel}:${fn.line}  ${fn.name}  ${fn.complexity}`),
  );
  section(
    "显式 any",
    anyFindings.map((item) => `${item.file}:${item.line}  ${item.text}`),
  );
  section(
    "ts-ignore / ts-expect-error",
    tsFindings.map((item) => `${item.file}:${item.line}  ${item.text}`),
  );
  section(
    "非空断言 !",
    nonNullFindings.map((item) => `${item.file}:${item.line}  ${item.text}`),
  );
  section(
    "非入口 console 调用",
    consoleFindings.map((item) => `${item.file}:${item.line}  ${item.text}`),
  );
  section(
    "TODO / FIXME（仅报告）",
    todoFindings.map((item) => `${item.file}:${item.line}  ${item.text}`),
    true,
  );
  section(
    "弱断言 toBeDefined/toBeTruthy",
    weakFindings.map((item) => `${item.file}:${item.line}  ${item.text}`),
  );
  section(
    "skip / todo 测试",
    skipFindings.map((item) => `${item.file}:${item.line}  ${item.text}`),
  );

  console.log("id\t指标\t值\t阈值\t状态");
  for (const metric of metrics) {
    console.log(
      `${metric.id}\t${metric.name}\t${metric.value}\t${metric.threshold}\t${metric.status}${
        metric.detail ? `\t${metric.detail}` : ""
      }`,
    );
  }

  let violationTotal = 0;
  let infoTotal = 0;
  if (sections.length > 0) {
    console.log("\n违规明细：");
    for (const item of sections) {
      console.log(`\n[${item.title}]`);
      for (const row of item.rows) console.log(`  ${row}`);
      if (item.info) infoTotal += item.rows.length;
      else violationTotal += item.rows.length;
    }
  }
  console.log(`\n合计：违规 ${violationTotal} 条；仅报告 ${infoTotal} 条；规则 ${metrics.length} 项`);

  const errors = metrics.filter((metric) => metric.status === "ERROR");
  const warnings = metrics.filter((metric) => metric.status === "WARN");
  if (errors.length > 0) {
    console.error(`质量报告不可信：${errors.length} 项 ERROR（${errors.map((metric) => metric.name).join("、")}）`);
    process.exitCode = 2;
  } else if (gate && warnings.length > 0) {
    console.error(`质量门禁失败：${warnings.length} 项 WARN（使用 --gate）`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`质量报告失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
