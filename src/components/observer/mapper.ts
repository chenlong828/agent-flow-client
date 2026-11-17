import { createHash } from "node:crypto";
import type { ObservationEventInput, SessionRichEventInput } from "./types.ts";
import { truncate } from "./text.ts";

const PREVIEW_LIMIT = 4096;
const RICH_LIMIT = 16384;

type ToolFact = { name: string; input?: unknown; startedAt: number };

/** ACP session/update → preview（O-04/O-05/O-07）与 rich（O-11）。不记录完整 system prompt。 */
export class AcpObservationMapper {
  readonly #tools = new Map<string, Map<string, ToolFact>>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  handle(sessionId: string, method: string, params: unknown): {
    preview?: ObservationEventInput;
    rich?: SessionRichEventInput;
  } {
    if (method !== "session/update") return {};
    const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
    if (update === undefined || update === null) return {};
    const type = String(update.sessionUpdate ?? "");
    if (type === "") return {};
    switch (type) {
      case "agent_message_chunk": return this.#message(update, type);
      case "agent_thought_chunk": return this.#thought(update, type);
      case "tool_call": return this.#toolCall(sessionId, update, type);
      case "tool_call_update": return this.#toolResult(sessionId, update, type);
      case "usage_update": return this.#usage(update, type);
      case "config_option_update": return this.#other(update, type, "config");
      default: return this.#other(update, type);
    }
  }

  #message(update: Record<string, unknown>, type: string): { preview: ObservationEventInput; rich: SessionRichEventInput } {
    const text = readText(update);
    const messageId = readMessageId(update);
    return {
      preview: preview(type, previewText("assistant", text), { acpType: type }),
      rich: { kind: "message", ...(messageId === undefined ? {} : { messageId }), ...textPart(text) },
    };
  }

  #thought(update: Record<string, unknown>, type: string): { preview: ObservationEventInput; rich: SessionRichEventInput } {
    const text = readText(update);
    const messageId = readMessageId(update);
    return {
      preview: preview(type, `thought: ${Buffer.byteLength(text, "utf8")} bytes`, { acpType: type }),
      rich: { kind: "thought", ...(messageId === undefined ? {} : { messageId }), ...textPart(text) },
    };
  }

  #toolCall(sessionId: string, update: Record<string, unknown>, type: string): { preview: ObservationEventInput; rich: SessionRichEventInput } {
    const toolCallId = String(update.toolCallId ?? "");
    const name = String(update.title ?? "");
    const fact: ToolFact = { name, input: update.rawInput, startedAt: this.#now() };
    this.#sessionTools(sessionId).set(toolCallId, fact);
    return {
      preview: preview("tool_call", `tool call: ${name}`, { acpType: type, tool: name, status: String(update.status ?? "in_progress") }),
      rich: { kind: "tool_call", toolCallId, tool: { name, status: "in_progress", ...(fact.input === undefined ? {} : { input: capValue(fact.input) }) } },
    };
  }

  #toolResult(sessionId: string, update: Record<string, unknown>, type: string): { preview: ObservationEventInput; rich: SessionRichEventInput } {
    const toolCallId = String(update.toolCallId ?? "");
    const fact = this.#sessionTools(sessionId).get(toolCallId);
    const name = fact?.name ?? "tool";
    const status = update.status === "failed" ? "failed" : "completed";
    const output = readToolOutput(update);
    if (fact !== undefined) this.#sessionTools(sessionId).delete(toolCallId);
    return {
      preview: preview("tool_call_update", `tool ${name}: ${status}`, { acpType: type, tool: name, status }),
      rich: {
        kind: "tool_result",
        toolCallId,
        tool: {
          name,
          status,
          ...(output === undefined ? {} : { output: truncate(output, RICH_LIMIT) }),
          ...(fact === undefined ? {} : { durationMs: Math.max(0, this.#now() - fact.startedAt) }),
        },
      },
    };
  }

  #usage(update: Record<string, unknown>, type: string): { preview?: ObservationEventInput; rich?: SessionRichEventInput } {
    const used = typeof update.used === "number" ? update.used : undefined;
    const size = typeof update.size === "number" ? update.size : undefined;
    if (used === undefined || size === undefined) return {};
    return {
      preview: preview("usage_update", `usage: ${used}/${size}`, { acpType: type, usage: { used, size } }),
      rich: { kind: "usage", usage: { used, size } },
    };
  }

  #other(update: Record<string, unknown>, type: string, kind: "config" | "other" = "other"): { preview: ObservationEventInput; rich: SessionRichEventInput } {
    if (kind === "config") {
      return {
        preview: preview(type, "config options updated", { acpType: type }),
        rich: { kind: "config", acpType: type, data: { configOptions: capValue(update.configOptions) } },
      };
    }
    return {
      preview: preview(type, `acp: ${type}`, { acpType: type }),
      rich: { kind: "other", acpType: type, data: { update: capValue(update) } },
    };
  }

  permission(sessionId: string, params: unknown, decision: "allow" | "reject"): {
    preview: ObservationEventInput;
    rich: SessionRichEventInput;
  } {
    const record = params as { toolCall?: { toolCallId?: unknown }; options?: { kind?: unknown; name?: unknown }[] } | undefined;
    const toolCallId = String(record?.toolCall?.toolCallId ?? "");
    const fact = this.#sessionTools(sessionId).get(toolCallId);
    const options = (record?.options ?? []).map((option) => ({ kind: String(option.kind ?? ""), name: String(option.name ?? "") }));
    return {
      preview: preview("session/request_permission", `permission: ${decision}`, {
        acpType: "session/request_permission",
        tool: fact?.name ?? null,
        status: decision,
      }),
      rich: {
        kind: "permission",
        ...(toolCallId === "" ? {} : { toolCallId }),
        permission: {
          ...(fact === undefined ? {} : { tool: { name: fact.name, ...(fact.input === undefined ? {} : { inputSummary: summarize(fact.input) }) } }),
          options,
          decision,
        },
      },
    };
  }

  #sessionTools(sessionId: string): Map<string, ToolFact> {
    const existing = this.#tools.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Map<string, ToolFact>();
    this.#tools.set(sessionId, created);
    return created;
  }
}

function preview(event: string, message: string, data: Record<string, unknown>): ObservationEventInput {
  return { kind: "acp", event, message: truncate(message, PREVIEW_LIMIT), data };
}

function previewText(label: string, text: string): string {
  return `${label}: ${truncate(text, 800)}`;
}

function readText(update: Record<string, unknown>): string {
  const content = update.content as { text?: unknown } | undefined;
  return typeof content?.text === "string" ? content.text : "";
}

function readMessageId(update: Record<string, unknown>): string | undefined {
  return typeof update.messageId === "string" ? update.messageId : undefined;
}

function textPart(text: string): { text?: string; truncated?: boolean; originalBytes?: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (text === "") return {};
  if (bytes <= RICH_LIMIT) return { text };
  return { text: truncate(text, RICH_LIMIT), truncated: true, originalBytes: bytes };
}

function readToolOutput(update: Record<string, unknown>): string | undefined {
  const content = Array.isArray(update.content) ? update.content : [];
  const parts: string[] = [];
  for (const block of content) {
    const text = (block as { content?: { text?: unknown } } | undefined)?.content?.text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function capValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text, "utf8") <= RICH_LIMIT) return value;
    return { truncated: true, preview: truncate(text, RICH_LIMIT), sha256: createHash("sha256").update(text).digest("hex") };
  } catch {
    return undefined;
  }
}

function summarize(value: unknown): string {
  if (typeof value === "string") return truncate(value, 200);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "name"]) {
      if (typeof record[key] === "string") return truncate(record[key] as string, 200);
    }
    return truncate(JSON.stringify(value), 200);
  }
  return truncate(String(value), 200);
}


