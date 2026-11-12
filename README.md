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

开发期自报身份（调度器 `EXECUTOR_AUTH=off`，默认）：`.config` 里给一个稳定的 `[scheduler] client_id`（或用 `AF_CLIENT_ID` 覆盖），client 会在五个端点统一带 `X-Client-Id`；调度器首次见到该值就自动登记节点，不需要先建 Harness 资产、不需要 `API-41`、不需要 token。`client_id` 必须跨重启稳定，缺省取本机 `hostname()`；非 loopback 且无 token 时还需 `allow_unauthenticated = true`：

```toml
[scheduler]
url = "https://sched.example.com"
client_id = "chenlong-mac-01"
# 开发期放开「非 loopback + 无 token」；生产回补时删掉并改用 token
allow_unauthenticated = true
```

`doctor` 会列出 `scheduler.client_id` 的取值与来源，并在无 token 时提示当前身份方式。`EXECUTOR_AUTH=on` 后 `X-Client-Id` 被服务端忽略，client 继续用 `Bearer`，两者可共存。

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

本机调试用 `scripts/serve-dev.sh`（系统终端里执行，包装了 `start --dev`）：

```bash
./scripts/serve-dev.sh            # 起一次；serve 被任何方式杀掉都会自动拉起
./scripts/serve-dev.sh status
./scripts/serve-dev.sh reload     # 改完代码立即重启（等价于杀掉 serve）
./scripts/serve-dev.sh stop
```

启动必须在系统终端里做（DSH 会话里启动会继承文件沙箱，容器目录写入报 `EPERM`），完整规则见 `AGENTS.md`「本机联调」。

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
