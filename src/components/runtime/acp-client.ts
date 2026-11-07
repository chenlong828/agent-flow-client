import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RuntimeError } from "./errors.ts";
import { delay, killProcessGroup } from "./acp-framing.ts";
import { AcpProtocol, type ProtocolHandlers } from "./acp-protocol.ts";

export type AcpCommand = { command: string; args: string[] };

export type AcpConnectOptions = {
  command: AcpCommand;
  cwd: string;
  env: Record<string, string | undefined>;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null) => void;
  initializeTimeoutMs?: number;
};

/** ACP v1 连接：进程生命周期 + 协议帧（CMP-runtime 内部单元）。 */
export class AcpConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #protocol: AcpProtocol;
  readonly #options: AcpConnectOptions;
  #exitCode: number | null = null;
  readonly #exitPromise: Promise<number | null>;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    protocol: AcpProtocol,
    exitPromise: Promise<number | null>,
    options: AcpConnectOptions,
  ) {
    this.#child = child;
    this.#protocol = protocol;
    this.#exitPromise = exitPromise;
    this.#options = options;
  }

  static async connect(options: AcpConnectOptions): Promise<AcpConnection> {
    const child = spawn(options.command.command, options.command.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const handlers: ProtocolHandlers = {
      ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
      ...(options.onServerRequest === undefined ? {} : { onServerRequest: options.onServerRequest }),
    };
    const protocol = new AcpProtocol((message) => child.stdin.write(`${JSON.stringify(message)}\n`), handlers);
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => {
        protocol.failAll(new RuntimeError("process_exited", `DSH 进程退出（code=${String(code)}）`));
        options.onExit?.(code);
        resolve(code);
      });
    });
    child.stdout.on("data", (chunk: Buffer) => protocol.handleChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") options.onStderr?.(line);
      }
    });
    const connection = new AcpConnection(child, protocol, exitPromise, options);
    await protocol.request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agent-flow-client", version: "0.0.1" } },
      options.initializeTimeoutMs ?? 10_000,
    );
    return connection;
  }

  get pid(): number {
    return this.#child.pid ?? -1;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#exitCode !== null) throw new RuntimeError("process_exited", `DSH 进程已退出：${method}`);
    return await this.#protocol.request(method, params, timeoutMs);
  }

  notify(method: string, params: unknown): void {
    if (this.#exitCode === null) this.#protocol.notify(method, params);
  }

  async close(graceMs = 5000): Promise<void> {
    if (this.#exitCode !== null) return;
    this.#child.stdin.end();
    const exited = await Promise.race([this.#exitPromise, delay(graceMs).then(() => "timeout" as const)]);
    if (exited !== "timeout") return;
    this.kill("SIGTERM");
    const afterTerm = await Promise.race([this.#exitPromise, delay(3000).then(() => "timeout" as const)]);
    if (afterTerm === "timeout") this.kill("SIGKILL");
    this.#exitCode = -1;
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (this.#exitCode !== null) return;
    const pid = this.#child.pid;
    if (pid !== undefined) killProcessGroup(pid, signal);
  }

  async waitExit(timeoutMs: number): Promise<boolean> {
    const result = await Promise.race([this.#exitPromise, delay(timeoutMs).then(() => "timeout" as const)]);
    return result !== "timeout";
  }
}
