import { RuntimeError } from "./errors.ts";
import { LineFramer } from "./acp-framing.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ProtocolHandlers = {
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
};

/** JSON-RPC 帧解析、请求匹配与服务端请求应答；不持有进程。 */
export class AcpProtocol {
  readonly #pending = new Map<number, Pending>();
  readonly #framer = new LineFramer();
  readonly #write: (message: unknown) => void;
  readonly #handlers: ProtocolHandlers;
  #nextId = 1;

  constructor(write: (message: unknown) => void, handlers: ProtocolHandlers) {
    this.#write = write;
    this.#handlers = handlers;
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RuntimeError("timeout", `${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  handleChunk(chunk: Buffer): void {
    for (const line of this.#framer.push(chunk)) this.#onLine(line);
  }

  failAll(error: Error): void {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  #onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      void this.#handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id as number);
      if (entry === undefined) return;
      clearTimeout(entry.timer);
      this.#pending.delete(message.id as number);
      if (message.error !== undefined) {
        const error = message.error as { code?: number; message?: string };
        entry.reject(new RuntimeError("prompt_failed", `${String(error.code)}: ${String(error.message)}`));
      } else entry.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") this.#handlers.onNotification?.(message.method, message.params);
  }

  async #handleServerRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as number;
    try {
      const result = await (this.#handlers.onServerRequest?.(String(message.method), message.params) ?? Promise.resolve(undefined));
      this.#send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: (error as Error).message } });
    }
  }

  #send(message: unknown): void {
    try {
      this.#write(message);
    } catch {
      // 进程已退出；由 exit 处理。
    }
  }
}
