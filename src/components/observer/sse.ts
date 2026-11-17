import type { AttemptStatus, SessionRichEvent } from "./types.ts";
import type { ObserverDeps } from "./http-types.ts";
import { ObserverError } from "./http-types.ts";
import { sse } from "./http.ts";
import { requireAttempt } from "./routes.ts";
import { createWriter, ignore, type StreamContext } from "./sse-writer.ts";

export async function attemptStream(deps: ObserverDeps, request: Request, attemptId: string, stream: StreamContext): Promise<Response> {
  const attempt = await requireAttempt(deps, attemptId);
  const close = stream.openStream();
  const lastEventId = Number(request.headers.get("last-event-id") ?? "0");
  const initial = await deps.attempts.events(
    attemptId,
    lastEventId > 0 ? { afterCursor: String(lastEventId), limit: 200 } : { limit: 1000 },
  );
  const all = lastEventId > 0 ? initial.items : initial.items.slice(-200);
  let lastSeq = Math.max(lastEventId, all.at(-1)?.seq ?? lastEventId);
  let poll: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream({
    start(controller) {
      const writer = createWriter(controller, () => {
        if (poll !== undefined) clearInterval(poll);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        close();
      });
      writer.send("snapshot", lastSeq, { events: all, truncatedBefore: initial.truncatedBefore ?? null, reset: lastEventId > 0 && all.length === 0 });
      if (attempt.status !== "running") {
        writer.send("end", lastSeq, { status: attempt.status, finishedAt: attempt.finishedAt });
        writer.finish();
        return;
      }
      poll = setInterval(() => {
        void (async () => {
          if (writer.closed) return;
          const current = await deps.attempts.get(attemptId);
          const next = (await deps.attempts.events(attemptId, { afterCursor: String(lastSeq), limit: 200 })).items;
          for (const item of next) {
            lastSeq = item.seq;
            writer.send("log", item.seq, item);
          }
          if (current !== null && current.status !== "running") {
            writer.send("end", lastSeq, { status: current.status, finishedAt: current.finishedAt });
            writer.finish();
          }
        })().catch(() => writer.finish());
      }, 500);
      heartbeat = setInterval(() => {
        if (!writer.closed) writer.send("heartbeat", -1, { ts: stream.now().toISOString() });
      }, 15000);
      request.signal.addEventListener("abort", () => writer.finish(), { once: true });
    },
    cancel() {
      close();
    },
  });
  return sse(body);
}
export async function sessionStream(deps: ObserverDeps, request: Request, sessionId: string, stream: StreamContext): Promise<Response> {
  if (!deps.config.richStreamEnabled) throw new ObserverError(503, "rich_stream_disabled", "富事件流已关闭");
  const attempt = await deps.attempts.findBySession(sessionId);
  if (attempt === null) throw new ObserverError(404, "session_not_found", `session 不存在：${sessionId}`);
  if (attempt.goneAt !== undefined) throw new ObserverError(410, "observation_gone", "session 已按保留策略清理");
  const close = stream.openStream();
  const lastEventId = Number(request.headers.get("last-event-id") ?? "0");
  const snapshot = deps.rich.snapshot(sessionId, 1000);
  const initial = lastEventId > 0 ? snapshot.filter((item) => item.seq > lastEventId).slice(-200) : snapshot.slice(-200);
  const reset = lastEventId > 0 && initial.length > 0 && (initial[0]?.seq ?? 0) > lastEventId + 1;
  let lastSeq = Math.max(lastEventId, initial.at(-1)?.seq ?? lastEventId);
  let closed = false;
  let pending = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      const send = (event: string, id: number, data: unknown): boolean => {
        if (closed) return false;
        if (pending > 1000) {
          try {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ code: "slow_consumer" })}\n\n`));
          } catch {
            // 已关闭。
          }
          finish();
          return false;
        }
        const desired = controller.desiredSize ?? 1;
        pending = desired <= 0 ? pending + 1 : 0;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const unsubscribe = deps.rich.subscribe(sessionId, (event: SessionRichEvent) => {
        lastSeq = event.seq;
        send("event", event.seq, event);
      });
      const unsubscribeClose = deps.rich.onClose(sessionId, (status) => {
        send("end", lastSeq, { status, finishedAt: new Date().toISOString() });
        finish();
      });
      heartbeat = setInterval(() => {
        if (!closed) send("heartbeat", -1, { ts: stream.now().toISOString() });
      }, 15000);
      const finish = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
        unsubscribeClose();
        close();
        try {
          controller.close();
        } catch {
          // 已关闭。
        }
      };
      send("snapshot", lastSeq, { events: initial, reset });
      if (attempt.status !== "running") {
        send("end", lastSeq, { status: attempt.status, finishedAt: attempt.finishedAt });
        finish();
        return;
      }
      request.signal.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      close();
    },
  });
  return sse(body);
}

