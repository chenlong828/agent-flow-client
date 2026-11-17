import { describe, expect, test } from "bun:test";
import { createWriter } from "../../../src/components/observer/sse-writer.ts";

describe("sse writer", () => {
  test("慢消费者超过队列上限时发 slow_consumer 并结束", () => {
    const frames: string[] = [];
    let finished = false;
    const controller = {
      desiredSize: 0,
      enqueue: (chunk: Uint8Array): void => {
        frames.push(new TextDecoder().decode(chunk));
      },
      close: (): void => undefined,
    } as unknown as ReadableStreamDefaultController;
    const writer = createWriter(controller, () => {
      finished = true;
    });
    for (let index = 0; index < 1002; index += 1) writer.send("event", index, { index });
    expect(writer.closed).toBe(true);
    expect(finished).toBe(true);
    expect(frames.some((frame) => frame.includes("slow_consumer"))).toBe(true);
  });
});
