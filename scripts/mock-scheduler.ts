#!/usr/bin/env bun
/**
 * 联调用最小桩调度器（executor contract v2）。
 *
 * 用法：
 *   bun run scripts/mock-scheduler.ts --token dev-token --task ./task.json [--skill name=dir] [--port 17999]
 *
 * 仅用于本机联调：内存任务列表、首份结果为准、按 free 批量下发、可选 stop/cancel 演示。
 * 不实现静默回队/超时回队（这些由真实调度器负责）。
 */
import { StubScheduler } from "../tests/support/stub-scheduler.ts";
import { readFileSync } from "node:fs";
import type { SkillSet, TaskRequest } from "../src/components/executor/types.ts";

type Options = {
  token: string;
  port: number;
  tasks: TaskRequest[];
  stopAfter: number | null;
};

function parseArgs(argv: string[]): Options {
  let token = process.env.MOCK_SCHEDULER_TOKEN ?? "dev-token";
  let port = Number(process.env.MOCK_SCHEDULER_PORT ?? "17999");
  const taskFiles: string[] = [];
  let stopAfter: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--token") token = argv[++index] as string;
    else if (arg === "--port") port = Number(argv[++index]);
    else if (arg === "--task") taskFiles.push(argv[++index] as string);
    else if (arg === "--stop-after") stopAfter = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") {
      console.log("用法：bun run scripts/mock-scheduler.ts --task <task.json> [--token t] [--port 17999] [--stop-after N]");
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (taskFiles.length === 0) throw new Error("至少需要一个 --task <file>");
  const tasks = taskFiles.map((file) => JSON.parse(readFileSync(file, "utf8")) as TaskRequest);
  return { token, port, tasks, stopAfter };
}

const options = parseArgs(process.argv.slice(2));
const stub = new StubScheduler({ token: options.token, pollHoldMs: 30000 });

// 端口覆盖：StubScheduler 用随机端口，这里再起一个转发的固定端口服务。
const server = Bun.serve({
  port: options.port,
  async fetch(request) {
    const url = new URL(request.url);
    const target = `${stub.url}${url.pathname}${url.search}`;
    const proxied = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? await request.text() : undefined,
    });
    const headers = new Headers(proxied.headers);
    headers.set("x-mock-scheduler", "1");
    if (proxied.status >= 400) console.error(`[mock] ${request.method} ${url.pathname} → ${proxied.status}`);
    return new Response(proxied.body, { status: proxied.status, headers });
  },
});

for (const task of options.tasks) {
  stub.enqueueTask(task);
  console.error(`[mock] 入队 taskId=${task.taskId} instance=${task.instanceId} attempt=${task.attempt}`);
}
let finishedCount = 0;
if (options.stopAfter !== null) {
  const timer = setInterval(() => {
    const accepted = stub.results().length;
    if (accepted === finishedCount) return;
    finishedCount = accepted;
    if (accepted >= (options.stopAfter as number)) {
      stub.setStop(true);
      clearInterval(timer);
      console.error(`[mock] 已接受 ${accepted} 份结果，下发 stop`);
    }
  }, 200);
}

console.error(`[mock] 调度器监听 http://127.0.0.1:${options.port}，token=${options.token}，任务数=${options.tasks.length}`);
console.error(`[mock] client 配置：[scheduler] url = "http://127.0.0.1:${options.port}"，token = "${options.token}"`);

process.on("SIGINT", () => {
  console.error("[mock] 收到 SIGINT，退出");
  stub.server.stop(true);
  server.stop(true);
  process.exit(0);
});
