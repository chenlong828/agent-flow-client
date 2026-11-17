import { createHash, timingSafeEqual } from "node:crypto";
import type { AttemptStatus, AttemptSummary, ObservationEvent, SessionRichEvent, SessionSummary } from "./types.ts";
import { OBSERVABILITY_VERSION } from "./types.ts";
import { errorResponse, json } from "./http.ts";
import { attemptDetail, attemptLogs, health, listAttempts, raw, runFileContent, runFiles, sessionDetail, sessionEvents } from "./routes.ts";
import { attemptStream, sessionStream } from "./sse.ts";
import type { ObserverConfig, ObserverDeps, RunFileRoot } from "./http-types.ts";
import { attemptStats } from "./attempt-query.ts";
import { join } from "node:path";
import { ObserverError } from "./http-types.ts";

const BASE = "/api/v1/observability";
const MAX_STREAMS_DEFAULT = 20;

export type ObserverHandle = {
  readonly port: number;
  readonly url: string;
  stop(): void;
};

export function createObserverHandler(deps: ObserverDeps): (request: Request) => Promise<Response> {
  let activeStreams = 0;
  const startedAt = Date.now();
  const now = deps.now ?? (() => new Date());

  return async function handle(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? undefined;
    try {
      if (request.method !== "GET") throw new ObserverError(405, "method_not_allowed", "只支持 GET");
      if (!authorized(request, deps.config)) throw new ObserverError(401, "unauthorized", "未授权");
      const url = new URL(request.url);
      if (!url.pathname.startsWith(BASE)) throw new ObserverError(404, "not_found", "路径不存在");
      const path = url.pathname.slice(BASE.length);
      const segments = path.split("/").filter((item) => item !== "");
      const response = await route(deps, request, url, segments, {
        startedAt,
        now,
        streams: () => activeStreams,
        openStream: () => {
          if (activeStreams >= (deps.config.maxStreams || MAX_STREAMS_DEFAULT)) {
            throw new ObserverError(429, "rate_limited", "SSE 并发超限");
          }
          activeStreams += 1;
          return () => {
            activeStreams = Math.max(0, activeStreams - 1);
          };
        },
      });
      if (requestId !== undefined) response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      const response = errorResponse(error);
      if (requestId !== undefined) response.headers.set("x-request-id", requestId);
      return response;
    }
  };
}

export function startObserverServer(deps: ObserverDeps): ObserverHandle {
  const handler = createObserverHandler(deps);
  const server = Bun.serve({
    hostname: deps.config.bind,
    port: deps.config.port,
    idleTimeout: 30,
    fetch: handler,
  });
  return {
    port: server.port ?? deps.config.port,
    url: deps.config.advertiseUrl,
    stop: () => server.stop(true),
  };
}

type StreamContext = {
  startedAt: number;
  now: () => Date;
  streams: () => number;
  openStream: () => () => void;
};

async function route(deps: ObserverDeps, request: Request, url: URL, segments: string[], stream: StreamContext): Promise<Response> {
  if (segments.length === 1 && segments[0] === "health") return json(await health(deps, stream.startedAt));
  if (segments[0] === "attempts") return await routeAttempts(deps, request, url, segments, stream);
  if (segments[0] === "sessions") return await routeSessions(deps, request, url, segments, stream);
  if (segments[0] === "runs") return await routeRuns(deps, url, segments);
  throw new ObserverError(404, "not_found", "路径不存在");
}

async function routeAttempts(deps: ObserverDeps, request: Request, url: URL, segments: string[], stream: StreamContext): Promise<Response> {
  if (segments.length === 1) return json(await listAttempts(deps, url));
  const attemptId = segments[1] as string;
  if (segments.length === 2) return json(await attemptDetail(deps, attemptId));
  if (segments.length === 3 && segments[2] === "logs") return json(await attemptLogs(deps, attemptId, url));
  if (segments.length === 4 && segments[2] === "logs" && segments[3] === "stream") return await attemptStream(deps, request, attemptId, stream);
  throw new ObserverError(404, "not_found", "路径不存在");
}

async function routeSessions(deps: ObserverDeps, request: Request, url: URL, segments: string[], stream: StreamContext): Promise<Response> {
  const sessionId = segments[1];
  if (sessionId === undefined) throw new ObserverError(404, "not_found", "路径不存在");
  if (segments.length === 2) return json(await sessionDetail(deps, sessionId));
  if (segments.length === 3 && segments[2] === "events") return json(await sessionEvents(deps, sessionId, url));
  if (segments.length === 3 && segments[2] === "raw") return await raw(deps, sessionId);
  if (segments.length === 4 && segments[2] === "events" && segments[3] === "stream") return await sessionStream(deps, request, sessionId, stream);
  throw new ObserverError(404, "not_found", "路径不存在");
}

async function routeRuns(deps: ObserverDeps, url: URL, segments: string[]): Promise<Response> {
  const runId = segments[1];
  if (runId === undefined || segments[2] !== "files") throw new ObserverError(404, "not_found", "路径不存在");
  if (segments.length === 3) return json(await runFiles(deps, runId, url));
  if (segments.length === 4 && segments[3] === "content") return json(await runFileContent(deps, runId, url));
  throw new ObserverError(404, "not_found", "路径不存在");
}

function authorized(request: Request, config: ObserverConfig): boolean {
  if (config.token === null || config.token === "") return true;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const provided = Buffer.from(match[1] as string);
  const expected = Buffer.from(config.token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

