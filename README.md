# agent-flow-client

AgentFlow 执行面客户端：在本机准备实例工作区、技能与 DSH 运行时，执行调度器下发的节点，并回传少量结果。

## 当前状态

已按执行面契约 **v2**（三端点、at-least-once）实现：

- `serve`：常驻 `poll` 循环，取任务、执行、上报结果、收 `stop`/`cancelInstances`；
- `run --request`：本地单任务，stdout 输出 `TaskResult` JSON；
- `doctor`：配置、DSH、凭据、容器与残留检查；
- `version`：client 版本与 ACP/DSH 基线。

契约权威：[docs/design/contracts/executor-http-v2.md](docs/design/contracts/executor-http-v2.md)；里程碑见 [docs/plan/roadmap.md](docs/plan/roadmap.md)。真实调度器联调与 S3（凭据/打包/平台）仍待推进。

## 快速开始

需要系统 Bun（1.4.4+）：

```bash
bun --version
bun install
bun run src/cli.ts --help
bun test
bun run typecheck
```

Bun 已安装在 `~/.bun/bin` 并加入 `PATH`；项目不携带本地 Bun。

## 与调度器联调

`serve` 按 executor contract v2 对接三个端点：`POST /api/v1/executor/poll`、`POST /api/v1/executor/tasks/{taskId}/result`、`GET /api/v1/executor/skill-packages/{packageId}`。

本机自测可直接用桩调度器：

```bash
# 1. 准备任务 JSON（TaskRequest）与配置文件（[scheduler] url/token、[capacity] max_concurrent）
# 2. 启动桩（端口固定、首份结果为准、--stop-after N 在收到 N 份结果后下发 stop）
bun run scripts/mock-scheduler.ts --token dev-token --task ./task.json --port 17999 --stop-after 1
# 3. 另一个终端启动 client
DSH_BIN=/path/to/dsh bun run src/cli.ts serve --config /path/to/.config
```

`serve` 的日志在 `state/logs/client.jsonl`，任务状态在 `state/journal.jsonl`；`stop` 或 SIGINT/SIGTERM 会收口在跑任务后退出。

## 文档

先读 [docs/README.md](docs/README.md)。上游边界与职责设计在 `../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/`。

## 目录

- `src/`：CLI 与后续执行内核
- `tests/`：测试
- `docs/`：需求、计划、设计、工序、历史（五态分离）
- `.agents/skills/`：本项目使用的开发技能

## 边界

本仓库只做执行面：不做编排决策、不读调度器数据库、不上传产物、不改 DSH。跨项目只按 HTTP 契约交互。
