export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export function errorResponse(error: unknown): Response {
  const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "internal";
  const message = error instanceof Error ? error.message : "internal error";
  return json({ error: { code, message } }, status);
}

export function sse(body: ReadableStream): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export function sseEnded(status: string, finishedAt: string | null): Response {
  const body = `event: end\ndata: ${JSON.stringify({ status, finishedAt })}\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}
