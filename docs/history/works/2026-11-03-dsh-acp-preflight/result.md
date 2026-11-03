---
layer: history
module: runtime
status: frozen
updated: 2026-11-03
---

# 工序结果：DSH ACP 对接预研

## 结论摘要

- 能跑通：从源码 checkout 用 `node apps/cli/lib/bin.js --profile acp` 启动 ACP 服务器，真实模型完成一次 prompt，返回 `stopReason=end_turn`。
- ACP v1 的 stdio JSON-RPC 足够覆盖 client 的执行面：`initialize`、`session/new`、`session/prompt`、`session/update`、`session/request_permission`、`session/cancel`、`session/close`、`session/list`。
- 工具调用（bash）会以 `session/request_permission` 询问客户端；客户端选 `allow_once` 后命令执行，结果回到模型。拒绝（`cancelled`）路径待干净环境补验。
- `session/cancel` 是 notification，prompt 以 `stopReason=cancelled` 结算；`session/close` 后进程随 stdin EOF 退出，退出码 0。
- 凭据两条路都成立：`$DSH_HOME/.credentials.yaml` 或启动环境里的 `DEEPSEEK_API_KEY`。后者适合 client 注入，不必落盘。
- 风险点：源码 checkout 的 `lib/` 与 `node_modules` 是 2026-10-02 的构建，落后 HEAD，启动时跳过 7 个插件；ACP 路径不受影响，但生产不能依赖这份不一致的构建。

可复现入口：`probe/acp-probe.mjs`，用法见 [`probe/README.md`](probe/README.md)。

## 验收结果

| 验收项 | 结果 | 证据 |
|---|---|---|
| A1 隔离 home 启动、profile 自动初始化、接受 initialize | 通过 | 首次启动自动生成 `$DSH_HOME/profiles/acp/{package.json,cordis.patch.yml}`；`initialize` 返回 `protocolVersion: 1` |
| A2 真实模型 prompt | 通过 | `stopReason: end_turn`，`assistantText: "ACP-OK"` |
| A3 权限请求应答 | 通过（允许路径） | 收到 `session/request_permission`（选项含 `allow_once` / `reject_once`）；选 `allow_once` 后 bash 执行，最终文本 `ACP-TOOL-OK`。拒绝路径未取得干净证据：嵌套沙箱下 bash 在审批前就因 `sandbox-exec` 失败 |
| A4 close 后退出、list 可见持久化会话 | 通过 | `session/close` → `ok`；stdin EOF 后 dsh `exit code 0`；`session/list` 在 close 后包含当前 sessionId |
| A5 一条命令可复现、失败信息可读 | 通过 | 见 `probe/README.md`；无凭据时返回 `-32603: ... no API key ...`，错误 key 时返回 `Authentication Fails ...` |

任务表全部完成：T-01（启动路径）、T-02（协议序列）、T-03（边界验证）、T-04（结论沉淀）。

## 实测环境

| 项 | 值 |
|---|---|
| 入口 | `/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js` |
| 包版本 | `@deepseek-ai/dsh` 0.2.2-alpha.2（源码 HEAD，2026-11-03） |
| 构建产物 | `lib/` 与 `node_modules` 时间为 2026-10-02，落后 HEAD |
| Node | v26.8.1（系统）；engines 要求 ≥ 24.9 |
| ACP | protocolVersion 1；`authMethods: []` |
| profile | `$DSH_HOME/profiles/acp`，bundles = `dsh-base` + `dsh-acp-app`，首次启动自动复制模板 |
| 默认模型 | `deepseek-official` / `deepseek-v4-flash`，`reasoning_effort=high` |
| 凭据 | 隔离 home 下复制 `.credentials.yaml`；另验证 `DEEPSEEK_API_KEY` 环境变量生效 |
| 会话存储 | `$DSH_HOME/sessions/<cwd 转义>/`，JSONL 持久化 |

## 调用序列（实测）

| 方向 | 方法 | 要点 |
|---|---|---|
| client → agent | `initialize` | `protocolVersion: 1`、`clientCapabilities: {}`；返回 agent 能力与空 authMethods |
| client → agent | `session/new` | 绝对 `cwd`、`mcpServers: []`；返回 `sessionId`、`configOptions`（model / reasoning_effort） |
| client → agent | `session/prompt` | `prompt` 是内容块数组（文本 `{type:"text",text}`）；一个会话同一时刻只允许一个进行中的 prompt |
| agent → client | `session/update`（notification） | 实测出现 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`usage_update` |
| agent → client | `session/request_permission`（request） | 客户端回 `{outcome:{outcome:"selected",optionId}}` 或 `{outcome:{outcome:"cancelled"}}` |
| client → agent | `session/cancel`（notification） | prompt 以 `stopReason=cancelled` 结算 |
| client → agent | `session/close` | 释放 Agent 作用域；持久化状态保留，可被 list（resume 未实测） |
| client → agent | `session/list` | 返回**已持久化、非活跃**会话；当前活跃会话在 close 前不出现 |
| agent → client | `session/prompt` 响应 | `{stopReason, usage}`；`usage` 本次实测为 `null` |

错误通道：失败以 JSON-RPC error 返回（实测 `-32603`），message 保留 DSH 的人类可读细节，例如缺 key、鉴权失败。client 应原样记录 message，映射为节点失败。

## 关键发现与注意点

1. **profile 自动初始化**：`$DSH_HOME/profiles/<name>` 不存在时，启动器从随包模板复制 bundles 列表，不需要预置目录，也不需要联网。
2. **DSH_HOME 是运行态边界**：profiles、凭据、持久化 sessions、storages、日志都在 home 下。会话按 cwd 分目录存储，`session/list` 只列当前 home 的会话。client 若多实例共用一个 home，会互相看到会话（虽然 id 不同），建议一实例一 home 或至少一 client 一 home。
3. **stdout 纯协议**：ACP 服务器 stdout 只走 ndjson JSON-RPC；诊断在 stderr。client 必须按行解析，不能把 stderr 混进协议流。
4. **权限是协议层一等公民**：工具调用前 agent 发 `session/request_permission`；不回答会一直等。默认拒绝（`cancelled`）是安全基线；允许时应只选 `allow_once`，避免 `allow_always` 放大授权。
5. **会话生命周期**：一个连接可并发多个会话，但一个会话同时只有一个 prompt。节点结束即 close；`session/list` 用于恢复/审计，不是活跃会话清单。
6. **取消是通知不是请求**：`session/cancel` 没有响应；以 prompt 的 `stopReason` 为准，client 需要同时设本地超时与进程级兜底。
7. **凭据注入**：`DEEPSEEK_API_KEY` 启动环境变量可用，且错误信息不会回显完整 key；适合 client 从调度器拿一次性凭据后注入子进程环境。
8. **checkout 构建陈旧**：启动时 7 个插件 `failed to import`——`remote-access`、`working-directory`、`tool-working-directory`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`web-deepseek-api`、`tool-executor-native`（另有 `session-telemetry-otel` 初始化报错）。根因是 `node_modules` 缺少新包（如 `dsh-subagent-in-process-driver`、`dsh-working-directory`）且 `lib/` 未重建。ACP 主链路不受影响，但 `working-directory` 缺失意味着模型侧拿不到 cwd 用户上下文；生产必须用版本一致的安装。
9. **嵌套沙箱**：在 DSH 沙箱会话内再跑 dsh 时，子 dsh 的 `sandbox-exec` 可能不可用，工具调用会提示退回完整访问权限。这是嵌套环境的假象，client 在真实桌面环境运行不会遇到。

## 对 CMP-runtime 的建议

1. 进程模型：一实例一 `dsh --profile acp` 进程，stdin/stdout 走协议，stderr 落本地日志；节点结束 close 后关闭 stdin，等进程退出（超时再 SIGTERM/SIGKILL）。
2. 会话模型：一节点一 `session/new`，`cwd` 用绝对路径且必须存在；拼 prompt 时只发文本内容块，产品上下文由调度器决定。
3. 权限：client 内置应答器，默认 reject；节点需要工具时按策略回 `allow_once`，并记录每次决定（toolCall id/kind）用于审计。
4. 取消：调度器取消 → 发 `session/cancel` → 等 prompt 结算 → 若超时则杀进程；两条路都要能回收。
5. 结果：从 `session/update` 累积 `agent_message_chunk` 得到最终文本；`stopReason` 与 JSON-RPC error 映射为节点状态，不把整段会话记录外传。
6. 凭据：每实例独立 `DSH_HOME`，凭据走 `DEEPSEEK_API_KEY` 环境变量注入，进程退出即失效；不复制 `.credentials.yaml` 到共享位置。
7. 版本：固定与调度器约定的 dsh 发行版（OQ-003/OQ-008），不要用源码 checkout 的陈旧 `lib/`。

## 未验证（留给 S0 后续）

- `session/resume` 恢复后的提示词语义；
- 同一连接多会话并发、以及一个会话内多次 prompt；
- 技能目录在 ACP profile 下的可见性（`dsh-skill`、`dsh-skill-filesystem` 已挂载，但未验证读取时机）——直接对应 OQ-001/OQ-002；
- fs 工具、MCP server 挂载、图片输入；
- SIGTERM/SIGINT 下的停稳式清理与持久化 flush；
- 在真实（非嵌套）桌面上运行时的沙箱与权限行为，以及干净的权限拒绝（reject）路径。

## 结论落点表

| 结论 | 落点 |
|---|---|
| ACP 启动方式、调用序列、边界行为 | 本文 + [`probe/README.md`](probe/README.md)；S0 写 `CMP-runtime` 规格时引用 |
| 二进制供给与版本基线 | `docs/plan/open-questions.md` OQ-003、OQ-008 |
| 凭据注入方式 | `docs/plan/open-questions.md` OQ-004 |
| DSH_HOME 隔离粒度 | `docs/plan/open-questions.md` OQ-009（新增） |
| 本机实测版本与 checkout 构建差异 | 本文「实测环境」「关键发现 8」 |

## 裁决摘要

P3 工序，免 review。blocker 0 / decision 0 / hold 0。
