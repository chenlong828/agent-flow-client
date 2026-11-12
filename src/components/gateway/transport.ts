import { GatewayError, mapHttpError, transportError } from "./errors.ts";

export type TransportOptions = {
  baseUrl: string;
  token: string | null;
  fetchImpl?: typeof fetch;
};

export type HttpResult = {
  status: number;
  body: unknown;
  bytes: Uint8Array | null;
};

const BASE_PATH = "/api/v1/executor";
const PROTOCOL_HEADER = "X-Executor-Protocol";
const PROTOCOL_VERSION = "3";

/** HTTP 传输（CMP-gateway）：公共头、超时、错误归一；不重试。 */
export class HttpTransport {
  readonly #options: TransportOptions;

  constructor(options: TransportOptions) {
    this.#options = options;
  }

  async post(path: string, body: unknown, timeoutMs: number): Promise<HttpResult> {
    return await this.#request("POST", path, { body, timeoutMs });
  }

  async getBytes(path: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<HttpResult> {
    return await this.#request("GET", path, { timeoutMs, headers, binary: true });
  }

  async postBytes(path: string, bytes: Uint8Array, timeoutMs: number, headers: Record<string, string> = {}): Promise<HttpResult> {
    return await this.#request("POST", path, { timeoutMs, headers, raw: bytes });
  }

  get baseUrl(): string {
    return this.#options.baseUrl;
  }

  get token(): string | null {
    return this.#options.token;
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; timeoutMs: number; headers?: Record<string, string>; binary?: boolean; raw?: Uint8Array },
  ): Promise<HttpResult> {
    const { body, timeoutMs, headers: extraHeaders = {}, binary = false } = options;
    const url = `${this.#options.baseUrl}${BASE_PATH}${path}`;
    const headers: Record<string, string> = {
      [PROTOCOL_HEADER]: PROTOCOL_VERSION,
      "X-Request-Id": crypto.randomUUID(),
      ...extraHeaders,
    };
    if (this.#options.token !== null) headers.Authorization = `Bearer ${this.#options.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    const payload = options.raw ?? (body === undefined ? undefined : JSON.stringify(body));

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, timeoutMs);

    try {
      const response = await (this.#options.fetchImpl ?? fetch)(url, {
        method,
        headers,
        body: payload as BodyInit,
        signal: controller.signal,
      });
      if (binary && response.status === 304) return { status: 304, body: null, bytes: null };
      if (binary && response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, body: null, bytes };
      }
      const text = await response.text();
      let parsed: unknown = null;
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (response.ok) throw new GatewayError("protocol_error", "响应不是合法 JSON");
        }
      }
      if (!response.ok) throw mapHttpError(response.status, parsed, path);
      return { status: response.status, body: parsed, bytes: null };
    } catch (error) {
      throw transportError(error, timedOut);
    } finally {
      clearTimeout(timer);
    }
  }
}
