# DSH MCP 最小实测（2026-11-18）

对应工序 [`../brief.md`](../brief.md) 的 `T-02`，结论见 [`../review.md`](../review.md) §2。

## 环境

| 项 | 值 |
|---|---|
| DSH | `0.2.2-alpha.2`（dev checkout `apps/cli/lib/bin.js`，`node v26.8.1`） |
| profile | `acp`，补丁只含模型路由（`hundsun-public / hs-deepseek-flash-latest`） |
| MCP server | `signal-server.mjs`：行分隔 JSON-RPC，单工具 `signal`，`verdict` 非枚举值时返回 `isError: true` |
| 挂载方式 | `session/new` 的 `mcpServers: [{ name: "agentflow", command: <bun 绝对路径>, args: [<脚本绝对路径>], env: [{ name, value }] }]` |

## 文件

| 文件 | 作用 |
|---|---|
| `signal-server.mjs` | 最小 stdio MCP server；把 `start`/`recv`/`tool-call`/`sigterm` 事件追加到 `AF_SPIKE_LOG` |
| `drive.mjs` | ACP 客户端驱动：`initialize` → `session/new`（挂 server）→ `session/prompt`（先传非法 verdict，再按错误重试）→ `session/close` → 启动失败用例 → 强杀进程组用例 |
| `concurrent.mjs` | 同一 DSH 进程内两个 session 并发挂同名 `agentflow`，检查是否冲突 |
| `discover-probe.mjs` | 变体 server 静默忽略 `server/discover`，测探针等待时长（实测 60 s 才回落 legacy，见 `discover-ignore-server-log.jsonl`） |
| `report.json` | 最近一次完整跑（`drive.mjs`）的机器可读结果 |
| `mcp-server-log.jsonl` | `drive.mjs` 跑动时 server 侧事件流 |
| `concurrent-server-log.jsonl` | 并发用例的 server 侧事件流 |
| `discover-ignore-server-log.jsonl` | `discover-probe.mjs` 的 server 事件流：第一个进程只收到 `server/discover`，约 60 s 后才有第二个进程 `initialize` |
| `fresh-home-server-log.jsonl` | 空 `DSH_HOME` 下两个 session 并发的 server 侧事件流（排除历史 session 干扰） |

## 复跑

```bash
# 需要：本机 .env 里的 HUNDSUN_PUBLIC_API_KEY（脚本自己读，不打印）
cd <repo>
bun docs/works/2026-11-18-mcp-signal-feedback/probe/drive.mjs
bun docs/works/2026-11-18-mcp-signal-feedback/probe/concurrent.mjs
# 探针：静默忽略 server/discover 的 server，约 60 s 后回落（确认 S-07）
AF_SPIKE_RUN=/tmp/af-mcp-discover docs/works/2026-11-18-mcp-signal-feedback/probe/discover-probe.mjs
```

`drive.mjs` / `concurrent.mjs` 的 `DSH_HOME`、`ENTRY`、`patch.json`、workspace 都相对脚本目录生成（`patch.json` 由 `drive.mjs` 写，`concurrent.mjs` 复用）。`discover-probe.mjs` 自包含，运行产物默认写 `$TMPDIR/af-mcp-spike-discover/`，可用 `AF_SPIKE_RUN` 改；不建议直接在 `probe/` 下留运行产物。

## 注意

- 驱动会把模型真实调用一次（约 1 s），消耗一次 `hs-deepseek-flash-latest` 额度；不打印凭据。
- `drive.mjs` 的 B/C 段会故意用不存在的 command 建 session、并 `SIGKILL` 整个 DSH 进程组；只在桌面系统上跑。
- 原始日志里的时间戳是 UTC。
