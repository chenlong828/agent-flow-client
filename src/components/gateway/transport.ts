import { GatewayError, mapHttpError, transportError } from "./errors.ts";

export type TransportOptions = {
  baseUrl: string;
  clientId: string;
  runId: string;
  token: string | null;
  fetchImpl?: typeof fetch;
};

export type HttpResult = {
  status: number;
  headers: Headers;
  body: unknown;
};

const BASE_PATH = "/api/v1/executor";

function requestId(): string {
  return crypto.randomUUID();
}

/**
 * HTTP 传输（CMP-gateway §2.1）：拼路径与公共头、超时、错误归一。
 * 不重试；重试策略在 `retry.ts`。
 */
export class HttpTransport {
  readonly #options: TransportOptions;

  constructor(options: TransportOptions) {
    this.#options = options;
  }

  async post(path: string, body: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<HttpResult> {
    return await this.#request("POST", path, body, options);
  }

  async get(path: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<HttpResult> {
    return await this.#request("GET", path, undefined, options);
  }

  /** 供 `CMP-assets` 复用同一凭据与 host 规则（`C-05`）。 */
  headersFor(url: string): Record<string, string> {
    const headers: Record<string, string> = { "X-Client-Run-Id": this.#options.runId, "X-Request-Id": requestId() };
    if (this.#options.token !== null && sameHost(url, this.#options.baseUrl)) {
      headers.Authorization = `Bearer ${this.#options.token}`;
    }
    return headers;
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<HttpResult> {
    const url = `${this.#options.baseUrl}${BASE_PATH}${path}`;
    const headers: Record<string, string> = this.headersFor(url);
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, options.timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await (this.#options.fetchImpl ?? fetch)(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (response.ok) throw new GatewayError("unreachable", "响应不是合法 JSON");
        }
      }
      if (!response.ok) throw mapHttpError(response.status, parsed, response.headers);
      return { status: response.status, headers: response.headers, body: parsed };
    } catch (error) {
      if (timedOut) throw new GatewayError("timeout", `请求超时（${options.timeoutMs}ms）`);
      throw transportError(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
