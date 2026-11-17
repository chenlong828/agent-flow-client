---
layer: history
module: global
status: frozen
updated: 2026-11-17
---

# 坑档案

## 测试临时配置未传给 CLI，依赖仓库根可写

- **现象**：`tests/components/cli/signals.test.ts` UC-14 在只读 checkout / orchestrator 环境稳定失败：约 10s 后 `ENOENT child.pid`，`prompt-started.txt` 未生成；本机仓库根可写时通过。
- **存续条件**：测试把 `.config` 写到临时 `runDir`，但 `bun src/cli.ts run --request ...` 没有传 `--config`。`resolveRunDir` 从模块目录向上找到 client 仓库根，临时配置被忽略；默认 `state.root` 与 `dsh_home` 落在仓库根，只读时 CLI 在进入 prompt 前失败。
- **对策**：CLI 集成测试必须显式传 `--config <绝对路径>` 与 `--state-root <绝对路径>`；配置内的 `dsh_home`/`state.root` 也用绝对路径；等待就绪失败时输出 child exit/stderr，不直接读证据文件。
- **落点**：`tests/components/cli/signals.test.ts`（2026-11-17 修复）。
- **同类检查**：其他 spawn CLI 的测试（`tests/scenarios/v2-serve.test.ts`、`v3-serve.test.ts`）已显式传 `--config`/`--state-root`。
