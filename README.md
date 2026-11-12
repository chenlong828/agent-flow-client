# agent-flow-client

AgentFlow 执行面客户端：在本机准备实例工作区、技能与 DSH 运行时，执行调度器下发的节点，并回传少量结果。

## 当前状态

已按执行面契约 **v3**（五端点、task-space、会话日志、运行归档、协议 3）实现；联调待调度器侧（见 `docs/works/2026-11-12-contract-v3-handoff/`）。当前可用能力：

- `serve`：常驻 `poll` 循环，取任务、执行、先传会话日志再报结果，收 `stop`/`cancelInstances`/`archiveRequests`；
- `run --request`：本地单任务，stdout 输出 `TaskResult` JSON；
- `doctor`：配置、DSH、凭据、容器与残留检查；
- `version`：client 版本与 ACP/DSH 基线。

契约权威：[docs/design/contracts/executor-http-v3.md](docs/design/contracts/executor-http-v3.md)；里程碑见 [docs/plan/roadmap.md](docs/plan/roadmap.md)。真实调度器联调与 S3（凭据/打包/平台）仍待推进。

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

`serve` 按 executor contract v3 对接五个端点：`POST /api/v1/executor/poll`、`POST /api/v1/executor/tasks/{taskId}/result`、`GET /api/v1/executor/skill-packages/{packageId}`、`POST /api/v1/executor/tasks/{taskId}/session-log`、`POST /api/v1/executor/runs/{runId}/archive`。

本机自测可直接用桩调度器：

```bash
# 1. 准备任务 JSON（TaskRequest）与配置文件（[scheduler] url/token、[capacity] max_concurrent）
# 2. 启动桩（端口固定、首份结果为准、--stop-after N 在收到 N 份结果后下发 stop）
bun run scripts/mock-scheduler.ts --token dev-token --task ./task.json --port 17999 --stop-after 1
# 3. 另一个终端启动 client
DSH_BIN=/path/to/dsh bun run src/cli.ts serve --config /path/to/.config
```

联调期间不想占终端，可用 `scripts/serve-bg.ts` 把 `serve` 放后台托管（pid 文件、日志、优雅停止）：

```bash
bun run scripts/serve-bg.ts start --config /path/to/.config
bun run scripts/serve-bg.ts status
bun run scripts/serve-bg.ts logs --follow
bun run scripts/serve-bg.ts stop
```

把 client 当桩、由调度器侧来调它时（例如开发 `agent-flow-orchaster`），加 `--supervise` 让它在异常退出后自动拉起：

```bash
bun run scripts/serve-bg.ts start --supervise --config /path/to/.config
bun run scripts/serve-bg.ts status   # 监督模式会显示 serve pid、重启次数、最近退出码
```

`serve` 以 0/130/143 退出视为正常停止；其余退出码按 1s→30s 退避重启；连续 5 次在启动后 3s 内退出（配置/DSH 入口这类确定性错误）则放弃并记录原因。监督事件写在 `<state.root>/logs/supervise.out`。

pid 在 `<state.root>/run/serve.pid`，stdout/stderr 在 `<state.root>/logs/serve.out`（结构化日志仍是 `client.jsonl`）。shell 里已导出 `DSH_HOME` 时（例如在 DSH 会话内）先 `env -u DSH_HOME` 再启动，否则它会覆盖配置里的 `[acp].dsh_home`，client 会拒绝 `~/.dsh`。

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
