import { join } from "node:path";
import type { AttemptSummary } from "./types.ts";

export type StoredAttempt = AttemptSummary & { updatedAt: string };

export function attemptDir(base: string, attemptId: string): string {
  return join(base, safe(attemptId));
}

export function safe(value: string): string {
  return value.replaceAll(/[^0-9a-zA-Z._-]/g, "_");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    return typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}