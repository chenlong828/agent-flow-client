# agent-flow-client

AgentFlow 执行面客户端：在本机准备实例工作区、技能与 DSH 运行时，执行调度器下发的节点，并回传少量结果。

## 当前状态

项目骨架已初始化，尚未接入调度器与 DSH。当前可运行：

- `bun run src/cli.ts --help` / `--version`
- `bun test`

`serve`、`run`、`doctor` 只保留命令入口，尚未实现；实现顺序见 [docs/plan/roadmap.md](docs/plan/roadmap.md)。

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

## 文档

先读 [docs/README.md](docs/README.md)。上游边界与职责设计在 `../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/`。

## 目录

- `src/`：CLI 与后续执行内核
- `tests/`：测试
- `docs/`：需求、计划、设计、工序、历史（五态分离）
- `.agents/skills/`：本项目使用的开发技能

## 边界

本仓库只做执行面：不做编排决策、不读调度器数据库、不上传产物、不改 DSH。跨项目只按 HTTP 契约交互。
