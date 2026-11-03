---
layer: history
module: runtime
status: frozen
updated: 2026-11-03
---

# ACP 探针使用说明

`acp-probe.mjs` 是一个零依赖的 Node 脚本：spawn `dsh --profile acp`，按 ACP v1（newline-delimited JSON-RPC）走一遍最小会话，并把结果打印为 JSON。

它只用于预研与回归验证，不是 CMP-runtime 的产品实现。

## 前置

- Node ≥ 24.9（实测 v26.8.1）。
- 一个可运行的 dsh CLI 入口。当前用源码 checkout 的构建产物：
  `/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js`。
- 模型凭据，二选一：
  - 推荐：给探针进程设置 `DEEPSEEK_API_KEY` 环境变量，会透传给 dsh，不落盘；
  - 或把现有 `~/.dsh/.credentials.yaml` 复制到 `--home` 指向的 `DSH_HOME`（权限 600，仅本地调试，用完删除）。

隔离 `DSH_HOME` 很重要：profile、凭据、持久化 session、日志都落在该目录，避免污染日常使用的 `~/.dsh`。

## 运行

```bash
mkdir -p /tmp/dsh-acp-ws

# 凭据走环境变量（推荐）
export DEEPSEEK_API_KEY=...   # 用你自己的 key，不要把值写进仓库或日志

node docs/history/works/2026-11-03-dsh-acp-preflight/probe/acp-probe.mjs \
  --dsh /Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js \
  --home /tmp/dsh-acp-home \
  --cwd /tmp/dsh-acp-ws \
  --prompt "Reply with exactly: ACP-OK"
```

成功时 stdout 是一段 JSON，包含 `sessionId`、`stopReason`、`assistantText`、`permissions`、`updateKinds`、`listedSessionIds`。`listedSessionIds` 是该 `DSH_HOME` 下历史持久化会话，会随重复运行累积。

## 常用变体

```bash
# 工具调用 + 自动允许权限
node .../acp-probe.mjs --permission allow \
  --prompt "用 bash 工具执行 echo ACP-TOOL-OK，然后只回复命令的输出。"

# 发出 prompt 3 秒后取消
node .../acp-probe.mjs --cancel-after 3000 \
  --prompt "用 bash 工具执行 sleep 8 && echo DONE，然后报告结果。"

# 保存完整协议 transcript（排查用）
node .../acp-probe.mjs --transcript /tmp/acp-transcript.json
```

## 参数

| 参数 | 说明 |
|---|---|
| `--dsh <path>` | dsh 入口；`.js` 用 node 跑，其他可执行文件直接执行；也可用 `DSH_BIN` |
| `--home <dir>` | 隔离的 `DSH_HOME`，默认 `/tmp/dsh-acp-probe-home` |
| `--cwd <dir>` | 子进程 cwd 与 `session/new` 的 `cwd`，默认当前目录 |
| `--node <path>` | 跑 `.js` 入口的 node，默认当前 node |
| `--prompt <text>` | 提示词 |
| `--permission allow\|reject` | 权限请求应答策略，默认 reject |
| `--cancel-after <ms>` | 发 prompt 后等待指定毫秒再 `session/cancel` |
| `--timeout <sec>` | prompt 超时，默认 300 |
| `--transcript <file>` | 写出全部协议消息 |
| `--quiet` | 不转发 dsh stderr |
| `--no-list` / `--no-close` | 跳过 `session/list` / `session/close` |

## 已知环境差异

- 源码 checkout 的 `lib/` 与 `node_modules` 是 2026-10-02 的构建，落后于 HEAD（0.2.2-alpha.2）；启动时会跳过 7 个插件（见 `result.md`）。ACP 路径不受影响。
- 在 DSH 沙箱内的会话里嵌套运行本探针时，子 dsh 的 `sandbox-exec` 可能不可用，工具调用会退回完整访问权限；这是嵌套环境的假象，不是 ACP 行为。
