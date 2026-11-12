#!/usr/bin/env bun
/**
 * 后台常驻 `serve` 管理脚本（本机联调用，正常模式：不改 serve 行为、不注入故障）。
 *
 * `serve` 自身是前台进程、没有 pid 文件；本脚本补的是进程托管这一层：
 * 抢占式启动、pid 记录、日志落盘、状态查询、优雅停止，以及 `--supervise`
 * 的自动重启（联调时对端调度器会频繁重启、client 也会因连续不可达退出）。
 *
 * 用法：
 *   bun run scripts/serve-bg.ts start   [--supervise|--dev] [--config <path>] [--state-root <path>] [--log-level <level>] [--permission deny|allow]
 *   bun run scripts/serve-bg.ts status  [--config <path>] [--state-root <path>]
 *   bun run scripts/serve-bg.ts logs    [--lines <n>] [--follow] [--config <path>] [--state-root <path>]
 *   bun run scripts/serve-bg.ts reload  [--config <path>] [--state-root <path>]
 *   bun run scripts/serve-bg.ts stop    [--force] [--config <path>] [--state-root <path>]
 *   bun run scripts/serve-bg.ts restart [接 start 的选项]
 *
 * 运行文件（均在 `<state.root>` 下）：
 *   run/serve.pid     托管的进程信息；存在即表示本脚本拉起的实例
 *   logs/serve.out    serve 的 stdout/stderr（client.jsonl 仍是结构化日志）
 *   logs/supervise.out  --supervise/--dev 时监督进程自己的事件与退出码
 *
 * 重启策略：
 *   --supervise  serve 以 0/130/143 退出视为正常停止，不再拉起；其余退出码
 *                按 1s、2s、4s… 上限 30s 退避重启；连续 5 次在启动后 3s 内
 *                退出（配置/DSH 入口等确定性错误）则放弃，避免无意义循环。
 *   --dev        调试用：任何退出（含被 SIGTERM/SIGKILL 杀掉）都自动拉起；
 *                快速连续失败不改放弃，改用 30s 固定重试。`reload` 立即重启
 *                serve 而不动监督进程。
 *
 * 启动入口只能在系统终端里用：DSH 会话内启动的进程会继承 DSH 文件沙箱，
 * 写容器目录时报 EPERM（permission_denied：容器不可写）。真要在沙箱内启动时
 * 加 `--allow-nested`（调试用，不推荐）。
 */
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { loadConfig, type AppConfig } from "../src/components/cli/config.ts";
import { resolveRunDir } from "../src/components/cli/run-dir.ts";

type Command = "start" | "stop" | "status" | "logs" | "restart" | "reload" | "supervise" | "help";

type Options = {
  command: Command;
  configPath?: string;
  stateRoot?: string;
  logLevel?: string;
  permission?: string;
  force: boolean;
  follow: boolean;
  supervise: boolean;
  dev: boolean;
  allowNested: boolean;
  lines: number;
};

type PidInfo = {
  pid: number;
  mode: "serve" | "supervise";
  startedAt: string;
  configPath: string;
  stateRoot: string;
  schedulerUrl: string | null;
  logPath: string;
  childPid?: number;
  restarts?: number;
  lastExitCode?: number | null;
  lastExitAt?: string;
  gaveUp?: string;
  dev?: boolean;
};

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--config", "--state-root", "--log-level", "--permission", "--lines"]);
const BOOLEAN_FLAGS = new Set([
  "--force",
  "--follow",
  "--supervise",
  "--dev",
  "--allow-nested",
  "--help",
  "-h",
]);
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 20_000;
const FAST_FAIL_MS = 3_000;
const FAST_FAIL_LIMIT = 5;
const MAX_BACKOFF_MS = 30_000;

const HELP = `后台常驻 serve 管理（联调 / 调试）

用法：
  bun run scripts/serve-bg.ts <command> [options]

命令：
  start     后台启动 serve（已在运行则拒绝，不重复拉进程）；--supervise 时由监督进程托管、退出后自动拉起
  status    查看运行状态、重启次数、最近任务与最近日志
  logs      查看 serve.out；--follow 持续跟踪；--lines 指定行数（默认 50）
  reload    让监督进程立即重启 serve（只发信号，新 serve 由监督进程拉起）
  stop      优雅停止（SIGTERM，最多等 20s）；--force 直接 SIGKILL
  restart   先 stop 再 start（只在系统终端里用，不要用 reload 替代）
  help      打印帮助

选项：
  --dev                 调试模式：隐含 --supervise；serve 被任何方式杀掉都会自动
                        拉起，快速连续失败改用 30s 固定重试而不放弃
  --supervise           自动重启（联调对端频繁重启时用）
  --allow-nested        允许在 DSH 会话内启动（默认拒绝：会继承 DSH 文件沙箱，
                        写容器目录报 EPERM）
  --config <path>       配置文件，默认 <repo>/.config（与 serve 一致）
  --state-root <path>   覆盖 state.root（与 serve 一致）
  --log-level <level>   debug | info | warn | error
  --permission <mode>   deny | allow

退出码：0 成功；1 未运行/启动失败；2 用法、配置或启动环境错误。
`;

function parseArgs(argv: readonly string[]): Options {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) throw new UsageError(`${name} 不接受值`);
      booleans.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`未知选项：${name}`);
    const value = inline ?? argv[index + 1];
    if (value === undefined || value === "") throw new UsageError(`${name} 需要一个值`);
    values.set(name, value);
    if (inline === undefined) index += 1;
  }
  const help = booleans.has("--help") || booleans.has("-h");
  const command = (help ? "help" : (positionals[0] ?? "help")) as Command;
  if (!["start", "stop", "status", "logs", "restart", "reload", "supervise", "help"].includes(command)) {
    throw new UsageError(`未知命令：${command}`);
  }
  const rawLines = values.get("--lines");
  const lines = rawLines === undefined ? 50 : Number(rawLines);
  if (!Number.isInteger(lines) || lines < 1) throw new UsageError("--lines 必须是正整数");
  return {
    command,
    ...(values.get("--config") === undefined ? {} : { configPath: values.get("--config") as string }),
    ...(values.get("--state-root") === undefined ? {} : { stateRoot: values.get("--state-root") as string }),
    ...(values.get("--log-level") === undefined ? {} : { logLevel: values.get("--log-level") as string }),
    ...(values.get("--permission") === undefined ? {} : { permission: values.get("--permission") as string }),
    force: booleans.has("--force"),
    follow: booleans.has("--follow"),
    supervise: booleans.has("--supervise"),
    dev: booleans.has("--dev"),
    allowNested: booleans.has("--allow-nested"),
    lines,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无信号权，按存活处理。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPidInfo(path: string): Promise<PidInfo | "invalid" | null> {
  let text: string;
  try {
    text = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (text === "") return "invalid";
  try {
    const parsed = JSON.parse(text) as Partial<PidInfo>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return "invalid";
    return { mode: "serve", ...parsed } as PidInfo;
  } catch {
    return "invalid";
  }
}

function writePidInfo(path: string, info: PidInfo): void {
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
}

async function readTail(path: string, maxBytes = 64 * 1024): Promise<string> {
  const text = await readFile(path).catch(() => Buffer.alloc(0));
  return text.subarray(Math.max(0, text.length - maxBytes)).toString("utf8");
}

async function readFrom(path: string, offset: number): Promise<string> {
  const text = await readFile(path).catch(() => Buffer.alloc(0));
  return text.subarray(Math.min(offset, text.length)).toString("utf8");
}

async function lastLine(path: string): Promise<string | null> {
  const text = await readTail(path, 16 * 1024);
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) ?? null;
}

function describeDuration(startedAt: string): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return "未知";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

type Paths = {
  stateRoot: string;
  runDir: string;
  pidPath: string;
  logPath: string;
  superviseLogPath: string;
  configPath: string;
};

function serveArgs(runDir: string, options: Options, configPath: string): string[] {
  const args = ["run", join(runDir, "src/cli.ts"), "serve", "--config", configPath];
  if (options.stateRoot !== undefined) args.push("--state-root", options.stateRoot);
  if (options.logLevel !== undefined) args.push("--log-level", options.logLevel);
  if (options.permission !== undefined) args.push("--permission", options.permission);
  return args;
}

async function claimPidFile(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

/** 已有存活实例则报错；陈旧/损坏的 pid 文件清掉。 */
async function assertNotRunning(pidPath: string): Promise<boolean> {
  const existing = await readPidInfo(pidPath);
  if (existing !== null && existing !== "invalid" && isAlive(existing.pid)) {
    console.error(`serve 已在后台运行：pid=${existing.pid}（${existing.mode}），startedAt=${existing.startedAt}`);
    console.error("需要重启时用：bun run scripts/serve-bg.ts restart");
    return false;
  }
  if (existing === "invalid") {
    // 内容不完整可能是另一个 start 刚抢占、尚未写入；只有陈旧文件才清理。
    const info = await stat(pidPath).catch(() => null);
    if (info !== null && Date.now() - info.mtimeMs < 60_000) {
      console.error("pid 文件存在但内容不完整，可能有另一个 start 正在进行；稍后重试");
      return false;
    }
  }
  if (existing !== null) await unlink(pidPath).catch(() => undefined);
  return true;
}

/**
 * DSH 会话内启动的进程会继承 DSH 文件沙箱（workspace-write），容器目录在会话
 * 工作区之外时写不进去，表现为 EPERM → client 报「容器不可写」。这里在入口处
 * 拦住，避免把环境问题误判成容器权限问题。
 */
function nestedSandboxError(): string | null {
  if (process.env.DSH_SESSION_ID === undefined || process.env.DSH_SESSION_ID === "") return null;
  return [
    "检测到 DSH 会话环境（DSH_SESSION_ID）：从这里启动的 client 会继承 DSH 文件沙箱，",
    "写容器目录时报 EPERM（permission_denied：容器不可写）。",
    "请在系统终端（Terminal.app / iTerm）里执行同一条命令。",
    "client 已在运行时，改完代码用 `reload` 重启（只发信号，不经过沙箱）。",
    "确认要冒这个风险时加 --allow-nested。",
  ].join("\n");
}

async function start(options: Options, paths: Paths, config: AppConfig): Promise<number> {
  const { stateRoot, pidPath } = paths;
  if (config.scheduler.url === null) {
    console.error("配置缺少 [scheduler].url：serve 启动会直接失败，先补配置再 start");
    return 2;
  }
  await mkdir(join(stateRoot, "run"), { recursive: true, mode: 0o700 });
  await mkdir(join(stateRoot, "logs"), { recursive: true, mode: 0o700 });
  if (!(await assertNotRunning(pidPath))) return 1;
  return options.supervise || options.dev
    ? await startSupervised(options, paths, config)
    : await startPlain(options, paths, config);
}

async function startPlain(options: Options, paths: Paths, config: AppConfig): Promise<number> {
  const { pidPath, logPath, stateRoot, configPath, runDir } = paths;
  const handle = await claimPidFile(pidPath);
  if (handle === null) {
    console.error("另一个 start 正在进行（pid 文件已被占用），稍后重试");
    return 1;
  }
  const offset = existsSync(logPath) ? (await stat(logPath)).size : 0;
  let child;
  try {
    const logFd = openSync(logPath, "a", 0o600);
    try {
      child = spawn(process.execPath, serveArgs(runDir, options, configPath), {
        cwd: runDir,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
    } finally {
      closeSync(logFd);
    }
    if (child.pid === undefined) throw new Error("spawn 没有返回 pid");
    child.unref();
    const info: PidInfo = {
      pid: child.pid,
      mode: "serve",
      startedAt: new Date().toISOString(),
      configPath,
      stateRoot,
      schedulerUrl: config.scheduler.url,
      logPath,
    };
    writePidInfo(pidPath, info);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(pidPath).catch(() => undefined);
    throw error;
  }

  const started = await waitForStarted(logPath, offset, () => isAlive(child.pid));
  if (!started) {
    const tail = await readTail(logPath);
    await unlink(pidPath).catch(() => undefined);
    console.error("serve 启动后立即退出，日志尾部：");
    console.error(tail.trim() === "" ? "（serve.out 为空）" : tail.trim());
    return 1;
  }
  return reportStarted(child.pid, "serve", paths, config, false);
}

async function startSupervised(options: Options, paths: Paths, config: AppConfig): Promise<number> {
  const { pidPath, logPath, stateRoot, configPath, runDir, superviseLogPath } = paths;
  const script = join(runDir, "scripts/serve-bg.ts");
  const args = ["run", script, "supervise", "--config", configPath];
  if (options.dev) args.push("--dev");
  if (options.allowNested) args.push("--allow-nested");
  if (options.stateRoot !== undefined) args.push("--state-root", options.stateRoot);
  if (options.logLevel !== undefined) args.push("--log-level", options.logLevel);
  if (options.permission !== undefined) args.push("--permission", options.permission);

  const logOffset = existsSync(logPath) ? (await stat(logPath)).size : 0;
  const superviseFd = openSync(superviseLogPath, "a", 0o600);
  let supervisor;
  try {
    supervisor = spawn(process.execPath, args, {
      cwd: runDir,
      detached: true,
      stdio: ["ignore", superviseFd, superviseFd],
      env: process.env,
    });
  } finally {
    closeSync(superviseFd);
  }
  if (supervisor.pid === undefined) {
    console.error("spawn 监督进程失败：没有返回 pid");
    return 1;
  }
  supervisor.unref();
  const supervisorPid = supervisor.pid;

  // 等监督进程落 pid 文件，再等 serve 打出 serve.started。
  const info = await waitForPidInfo(pidPath, supervisorPid);
  const started = info !== null && (await waitForStarted(logPath, logOffset, () => isAlive(supervisorPid)));
  if (info === null || !started) {
    const tail = await readTail(superviseLogPath);
    const serveTail = await readTail(logPath);
    process.kill(supervisorPid, "SIGKILL");
    await unlink(pidPath).catch(() => undefined);
    console.error("监督进程没有把 serve 拉起，日志尾部：");
    console.error(tail.trim() === "" ? "（supervise.out 为空）" : tail.trim());
    if (serveTail.trim() !== "") console.error(serveTail.trim());
    return 1;
  }
  return reportStarted(supervisorPid, "supervise", paths, config, options.dev);
}

async function waitForPidInfo(path: string, expectedPid: number): Promise<PidInfo | null> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await readPidInfo(path);
    if (info !== null && info !== "invalid" && info.pid === expectedPid && isAlive(expectedPid)) return info;
    if (!isAlive(expectedPid)) return null;
    await Bun.sleep(100);
  }
  return null;
}

async function waitForStarted(logPath: string, offset: number, alive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!alive()) return false;
    if ((await readFrom(logPath, offset)).includes('"event":"serve.started"')) return true;
    await Bun.sleep(150);
  }
  return false;
}

function reportStarted(pid: number, mode: PidInfo["mode"], paths: Paths, config: AppConfig, dev: boolean): number {
  console.log(`serve 已在后台启动：pid=${pid}（${mode}${dev ? "，dev" : ""}）`);
  console.log(`  config:    ${paths.configPath}`);
  console.log(`  state:     ${paths.stateRoot}`);
  console.log(`  scheduler: ${config.scheduler.url}`);
  console.log(`  log:       ${paths.logPath}`);
  if (mode === "supervise") {
    console.log(`  监督日志:  ${paths.superviseLogPath}`);
    console.log(
      dev
        ? "  serve 被任何方式杀掉都会自动拉起（快速连续失败改用 30s 重试）；改完代码用 reload 立即重启。"
        : "  serve 异常退出会按 1s…30s 退避自动拉起；0/130/143 视为正常停止。",
    );
  }
  console.log("停止：bun run scripts/serve-bg.ts stop（或 ./scripts/serve-dev.sh stop）");
  return 0;
}

/** `start --supervise` 拉起的监督进程：维持 serve 存活并记录重启。 */
async function supervise(options: Options, paths: Paths, config: AppConfig): Promise<number> {
  const { pidPath, logPath, stateRoot, configPath, runDir, superviseLogPath } = paths;
  if (config.scheduler.url === null) {
    console.error("配置缺少 [scheduler].url，监督进程不启动");
    return 2;
  }
  await mkdir(join(stateRoot, "run"), { recursive: true, mode: 0o700 });
  await mkdir(join(stateRoot, "logs"), { recursive: true, mode: 0o700 });
  if (!(await assertNotRunning(pidPath))) return 1;
  const handle = await claimPidFile(pidPath);
  if (handle === null) {
    console.error("pid 文件已被占用，监督进程退出");
    return 1;
  }
  const restartAlways = options.dev;
  const info: PidInfo = {
    pid: process.pid,
    mode: "supervise",
    startedAt: new Date().toISOString(),
    configPath,
    stateRoot,
    schedulerUrl: config.scheduler.url,
    logPath,
    restarts: 0,
    lastExitCode: null,
    ...(restartAlways ? { dev: true } : {}),
  };
  writePidInfo(pidPath, info);
  logEvent(`supervise started pid=${process.pid} config=${configPath}${restartAlways ? "（dev：任何退出都拉起）" : ""}`);

  let stopping = false;
  let reloadRequested = false;
  let child: ChildProcess | null = null;
  const onStop = (): void => {
    if (stopping) return;
    stopping = true;
    logEvent("收到停止信号，转发给 serve");
    child?.kill("SIGTERM");
  };
  const onReload = (): void => {
    if (stopping) return;
    reloadRequested = true;
    logEvent("收到 reload 信号，重启 serve");
    child?.kill("SIGTERM");
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  process.on("SIGUSR1", onReload);

  const logFd = openSync(logPath, "a", 0o600);
  let restarts = 0;
  let fastFailures = 0;
  let lastCode: number | null = null;
  try {
    while (!stopping) {
      const startedMs = Date.now();
      const running = spawn(process.execPath, serveArgs(runDir, options, configPath), {
        cwd: runDir,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
      if (running.pid === undefined) {
        logEvent("spawn serve 失败：没有返回 pid");
        lastCode = 1;
        break;
      }
      child = running;
      info.childPid = running.pid;
      writePidInfo(pidPath, info);
      logEvent(`serve started pid=${running.pid}（第 ${restarts + 1} 次）`);
      const code = await new Promise<number | null>((resolveExit) => {
        running.on("exit", (exitCode) => resolveExit(exitCode));
      });
      child = null;
      lastCode = code;
      info.lastExitCode = code;
      info.lastExitAt = new Date().toISOString();
      if (stopping) break;
      const reloaded = reloadRequested;
      reloadRequested = false;
      const graceful = code === 0 || code === 130 || code === 143;
      if (graceful && !restartAlways) {
        logEvent(`serve 正常退出 code=${String(code)}，监督进程一并退出`);
        break;
      }
      const ranMs = Date.now() - startedMs;
      fastFailures = reloaded ? 0 : ranMs < FAST_FAIL_MS ? fastFailures + 1 : 0;
      if (fastFailures >= FAST_FAIL_LIMIT && !restartAlways) {
        info.gaveUp = `连续 ${fastFailures} 次在 ${FAST_FAIL_MS}ms 内退出（最后 code=${String(code)}）`;
        logEvent(`放弃自动重启：${info.gaveUp}`);
        writePidInfo(pidPath, info);
        break;
      }
      restarts += 1;
      info.restarts = restarts;
      // reload 立即重启；dev 下快速连续失败改用固定 30s，其余按指数退避。
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(restarts - 1, 5));
      const waitMs = reloaded ? 0 : restartAlways && fastFailures >= FAST_FAIL_LIMIT ? MAX_BACKOFF_MS : backoff;
      writePidInfo(pidPath, info);
      const reason = reloaded ? "收到 reload" : code === null ? "被信号终止" : `退出 code=${String(code)}`;
      logEvent(`${reason}（运行 ${Math.round(ranMs / 1000)}s），第 ${restarts} 次重启在 ${waitMs}ms 后`);
      if (restartAlways && fastFailures === FAST_FAIL_LIMIT) {
        logEvent(`连续 ${FAST_FAIL_LIMIT} 次快速失败，改用 ${MAX_BACKOFF_MS}ms 固定重试；修好后用 reload 立即重启`);
      }
      const deadline = Date.now() + waitMs;
      while (!stopping && !reloadRequested && Date.now() < deadline) await Bun.sleep(100);
    }
  } finally {
    closeSync(logFd);
    await handle.close().catch(() => undefined);
    await unlink(pidPath).catch(() => undefined);
    logEvent(`supervise exit code=${String(stopping ? 143 : lastCode ?? 0)}`);
  }
  return stopping ? 143 : lastCode ?? 0;
}

function logEvent(message: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function stop(options: Options, paths: Paths): Promise<number> {
  const { pidPath } = paths;
  const info = await readPidInfo(pidPath);
  if (info === null) {
    console.log("serve 未在后台运行（没有 pid 文件）");
    return 0;
  }
  if (info === "invalid") {
    await unlink(pidPath).catch(() => undefined);
    console.log("pid 文件损坏，已清理");
    return 0;
  }
  if (!isAlive(info.pid)) {
    await unlink(pidPath).catch(() => undefined);
    console.log(`pid=${info.pid} 已不存在，清理陈旧 pid 文件`);
    return 0;
  }
  process.kill(info.pid, options.force ? "SIGKILL" : "SIGTERM");
  if (options.force && info.mode === "supervise" && info.childPid !== undefined && isAlive(info.childPid)) {
    // SIGKILL 监督进程时它来不及转发，直接回收 serve 子进程，避免遗留。
    process.kill(info.childPid, "SIGKILL");
  }
  const deadline = Date.now() + (options.force ? 3_000 : STOP_TIMEOUT_MS);
  while (Date.now() < deadline && isAlive(info.pid)) await Bun.sleep(150);
  if (isAlive(info.pid)) {
    console.error(`pid=${info.pid} 在超时内没有退出：可再执行 stop，或加 --force 直接 SIGKILL`);
    return 1;
  }
  await unlink(pidPath).catch(() => undefined);
  console.log(`已停止 serve：pid=${info.pid}（${info.mode}）`);
  return 0;
}

/** `reload`：只发 SIGUSR1，让监督进程自己拉起新的 serve；调用方在哪个环境都不影响子进程。 */
async function reload(paths: Paths): Promise<number> {
  const { pidPath } = paths;
  const info = await readPidInfo(pidPath);
  if (info === null || info === "invalid") {
    console.log("serve 未在后台运行：先在系统终端里 start --dev");
    return 1;
  }
  if (!isAlive(info.pid)) {
    console.log(`pid=${info.pid} 已不存在（pid 文件陈旧）：先在系统终端里 start --dev`);
    return 1;
  }
  if (info.mode !== "supervise") {
    console.log("当前是单进程模式，reload 不可用：stop 后在系统终端里 start --dev");
    return 1;
  }
  const previousChild = info.childPid;
  process.kill(info.pid, "SIGUSR1");
  const next = await waitForChildPid(pidPath, previousChild, info.pid);
  if (next === null) {
    console.error("已通知监督进程，但超时内没有看到新的 serve 进程；看 supervise.out 排查");
    return 1;
  }
  console.log(`已重启 serve：pid=${next}（监督进程 pid=${info.pid}）`);
  return 0;
}

async function waitForChildPid(
  pidPath: string,
  previous: number | undefined,
  supervisorPid: number,
): Promise<number | null> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await readPidInfo(pidPath);
    if (
      info !== null &&
      info !== "invalid" &&
      info.pid === supervisorPid &&
      info.childPid !== undefined &&
      info.childPid !== previous &&
      isAlive(info.childPid)
    ) {
      return info.childPid;
    }
    await Bun.sleep(150);
  }
  return null;
}

async function status(paths: Paths): Promise<number> {
  const { pidPath, superviseLogPath } = paths;
  const info = await readPidInfo(pidPath);
  if (info === null) {
    console.log("serve 未在后台运行");
    return 1;
  }
  if (info === "invalid") {
    console.log("serve 未在后台运行（pid 文件损坏）");
    return 1;
  }
  if (!isAlive(info.pid)) {
    console.log(`serve 未在后台运行（pid=${info.pid} 已不存在，pid 文件陈旧）`);
    return 1;
  }
  console.log(info.mode === "supervise" ? "serve 运行中（监督模式）" : "serve 运行中");
  console.log(`  pid:       ${info.pid}`);
  console.log(`  运行时长:  ${describeDuration(info.startedAt)}（startedAt=${info.startedAt}）`);
  if (info.mode === "supervise") {
    if (info.dev === true) console.log("  自动拉起:  是（dev：被任何方式杀掉都会拉起）");
    const childAlive = info.childPid !== undefined && isAlive(info.childPid);
    console.log(`  serve pid: ${info.childPid ?? "无"}${childAlive ? "" : "（当前不在运行，等待重启）"}`);
    console.log(`  重启次数:  ${info.restarts ?? 0}`);
    if (info.lastExitCode !== undefined && info.lastExitCode !== null) {
      console.log(`  最近退出:  code=${info.lastExitCode} at ${info.lastExitAt ?? "未知"}`);
    }
    if (info.gaveUp !== undefined) console.log(`  已放弃:    ${info.gaveUp}`);
  }
  console.log(`  config:    ${info.configPath}`);
  console.log(`  state:     ${info.stateRoot}`);
  console.log(`  scheduler: ${info.schedulerUrl ?? "未配置"}`);
  console.log(`  log:       ${info.logPath}`);
  if (info.mode === "supervise") console.log(`  监督日志:  ${superviseLogPath}`);
  const logLine = await lastLine(info.logPath);
  if (logLine !== null) console.log(`  最近日志:  ${logLine}`);
  const journalLine = await lastLine(join(info.stateRoot, "journal.jsonl"));
  if (journalLine !== null) {
    try {
      const record = JSON.parse(journalLine) as { state?: unknown; taskId?: unknown };
      console.log(`  最近任务:  ${String(record.state)} ${String(record.taskId)}`);
    } catch {
      // journal 尾部损坏不影响状态展示。
    }
  }
  return 0;
}

async function logs(options: Options, paths: Paths): Promise<number> {
  if (!existsSync(paths.logPath)) {
    console.log(`暂无日志：${paths.logPath}`);
    return 1;
  }
  if (options.follow) {
    const child = spawn("tail", ["-f", paths.logPath], { stdio: "inherit" });
    return await new Promise<number>((resolveExit) => {
      child.on("exit", (code) => resolveExit(code ?? 0));
    });
  }
  const text = await readTail(paths.logPath);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  console.log(lines.slice(-options.lines).join("\n"));
  return 0;
}

async function main(): Promise<number> {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.command === "help") {
    console.log(HELP);
    return 0;
  }
  if (["start", "restart", "supervise"].includes(options.command) && !options.allowNested) {
    const nested = nestedSandboxError();
    if (nested !== null) {
      console.error(nested);
      return 2;
    }
  }
  const runDir = resolveRunDir({ execPath: process.execPath, moduleDir: import.meta.dir });
  const configPath = options.configPath === undefined ? join(runDir, ".config") : resolve(process.cwd(), options.configPath);
  const config = await loadConfig({
    runDir,
    env: process.env,
    flags: {
      configPath,
      ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
      ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
      ...(options.permission === undefined ? {} : { permission: options.permission }),
    },
  });
  const paths: Paths = {
    stateRoot: config.state.root,
    runDir,
    pidPath: join(config.state.root, "run", "serve.pid"),
    logPath: join(config.state.root, "logs", "serve.out"),
    superviseLogPath: join(config.state.root, "logs", "supervise.out"),
    configPath,
  };
  switch (options.command) {
    case "start":
      return await start(options, paths, config);
    case "stop":
      return await stop(options, paths);
    case "status":
      return await status(paths);
    case "logs":
      return await logs(options, paths);
    case "reload":
      return await reload(paths);
    case "supervise":
      return await supervise(options, paths, config);
    case "restart": {
      await stop(options, paths);
      return await start(options, paths, config);
    }
    default:
      throw new UsageError(`未知命令：${options.command as string}`);
  }
}

try {
  process.exit(await main());
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n`);
    console.error(HELP);
    process.exit(2);
  }
  console.error(`serve-bg 失败：${(error as Error).message}`);
  process.exit(1);
}
