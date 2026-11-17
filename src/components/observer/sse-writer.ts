export const ignore = (): undefined => undefined;

export type StreamContext = {
  startedAt: number;
  now: () => Date;
  streams: () => number;
  openStream: () => () => void;
};

export function createWriter(controller: ReadableStreamDefaultController, onFinish: () => void) {
  const encoder = new TextEncoder();
  let closed = false;
  let pending = 0;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    onFinish();
    try { controller.close(); } catch { /* closed */ }
  };
  const send = (event: string, id: number, data: unknown): boolean => {
    if (closed) return false;
    if (pending > 1000) {
      try { controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ code: "slow_consumer" })}\n\n`)); } catch { /* closed */ }
      finish();
      return false;
    }
    pending = (controller.desiredSize ?? 1) <= 0 ? pending + 1 : 0;
    try {
      controller.enqueue(encoder.encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`));
      return true;
    } catch {
      closed = true;
      return false;
    }
  };
  return { get closed() { return closed; }, send, finish };
}

