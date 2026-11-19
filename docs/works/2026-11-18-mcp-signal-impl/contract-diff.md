---
layer: works
module: global
status: active
updated: 2026-11-18
---

# 契约增量：结果信号（client 侧交付，供调度层对接验证）

> 对应工序 [`brief.md`](brief.md)。权威契约仍是 [`executor-http-v3.md`](../../design/contracts/executor-http-v3.md)（已按本文更新）；本文只列**增量**与**验证方式**。
> 结论：**加法，不升协议版本**（`X-Executor-Protocol` 仍为 `3`）；旧 orchestrator 与旧 client 的组合行为不变。

## 1 字段增量

| 位置 | 字段 | 必填 | 说明 |
|---|---|---|---|
| `P-01` → `TaskRequest` | `resultSignal?: ResultSignalContract` | 否 | review 节点由 `CMP-run` 下发；scheduler 视为 opaque JSON 持久化并透传；重派时不变（`S-05`）；`validateDraft` 限 ≤ 8 KiB |
| `P-02` ← `TaskResult` | `signals?: TaskSignal[]` | 否 | 只在 `succeeded` 且采集到合法信号时出现；缺省不传空数组 |
| `P-02` ← `TaskError.code` | `signal_prepare_failed` / `signal_mount_failed` | — | `class` 均为 `protocol` |
| `P-01` → `TaskRequest` | `resumeSessionId?: string` | 否 | 第二场景（§5.5 / `T-RVM-09`）：`CMP-run` 在人工 `decide` 后生成续跑任务时下发；存在即 `session/resume` 同一 session |

```ts
type ResultSignalContract = {
  version: number;                     // client 只接受 1
  kind: "review_verdict" | "confirmation_request";  // v1 两个 kind
  required: boolean;                   // v1 恒 true；client 不据此判失败，只记 signal_missing
  schema: RestrictedSchema;            // 只描述 data 字段；kind 由工具固定
};

type RestrictedSchema = {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, RestrictedField>;
};

type RestrictedField =
  | { type: "string"; enum?: string[]; minLength?: number; maxLength?: number; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "number"; minimum?: number; maximum?: number; description?: string }
  | { type: "string[]"; maxItems?: number; maxLength?: number; description?: string };

type TaskSignal = {
  seq: number;                         // 本 attempt 内从 1 单调递增
  at: string;                          // ISO-8601 UTC
  kind: "review_verdict" | "confirmation_request";
  data: Record<string, unknown>;       // 已按 schema 校验
};
```

## 2 语义增量

| 项 | 约定 |
|---|---|
| 工具公开名 | 由 `resultSignal.kind` 决定：`review_verdict` → `mcp__agentflow__signal`；`confirmation_request` → `mcp__agentflow__confirm`。`agentflow_signal`/`agentflow_confirm` 只是语义别名，skill/验收按公开名写 |
| 挂载 | `session/new.mcpServers = [{ name:"agentflow", command:<bun 绝对路径>, args:[<signal-server 绝对路径>], env:[{name:"AF_SIGNAL_CONFIG",value:<config 绝对路径>}] }]` |
| 触发条件 | 只有 `resultSignal` 存在且 `version=1`/`kind=review_verdict`/schema 合法时才挂 MCP；不支持时忽略字段、按旧行为执行（不挂 MCP、不发 signals） |
| 失败语义 | 预检失败 → `failed(protocol, signal_prepare_failed)`；挂载失败**用相同 `mcpServers` 重建一次**，仍失败 → `failed(protocol, signal_mount_failed)`；不降级、不回退消息 |
| 归因 | 只有 `session/new` 错误的 `data.details` 命中 `mcp-client(agentflow)` 才判挂载失败；DSH 崩溃/启动失败仍报 `spawn_failed`/`process_exited`/`protocol_error` |
| 模型行为 | 模型没调用工具：记 `signal_missing`、不发 signals（`required=true` 不升级为失败）；参数非法：server 返回 `isError`，模型可在同一 session 内修正 |
| 预算 | `signals ≤ 16 KiB / 8 条`；单条 `reason ≤ 8 KiB`、`evidence ≤ 16 项 × 512 B`（UTF-8 字节）；`message + signals + JSON 开销 ≤ maxResultBytes (256 KiB)`；整段超 16 KiB 时丢弃 `signals`，`truncated` 仍只描述 message |
| 续跑 | `resumeSessionId` 存在时用 `session/resume`（cwd 必须与持久化一致、需重传 `mcpServers`），实测 close 后与 DSH 重启后均可续跑；新建路径不变 |
| 确认点（两阶段） | 模型调用 `mcp__agentflow__confirm` 后**停止本轮**；client 采集 `confirmation_request` 随 `succeeded` 回传（带 `sessionId`）；`CMP-run` 置 `waiting_confirm`，UI 用现有 `decide`；随后派发**续跑任务**（新 `taskId`、同 `run_node`、`resumeSessionId=<原 sessionId>`，人工决定/意见写进 prompt）；client `session/resume` 后继续，不新建 session、不重跑、不加 visit |
| 信号存放 | `<stateRoot>/signals/<taskId>/<attempt>/`（`0700`/`0600`），不进 task-space、不进归档；默认保留 7 天，`[signal].retention_days` 可调 |
| 配置键（client） | `[acp].session_new_timeout_ms`（默认 10000，≥1000）、`[signal].retention_days`（默认 7，1..365） |

## 3 承诺增量

| ID | 承诺 |
|---|---|
| `C-13` | 收到 `resultSignal` 且支持时建 per-attempt 目录并挂载 `agentflow` stdio server；不支持/形状非法时按旧行为执行；预检/挂载失败按 `signal_*_failed` 上报失败，不降级 |
| `C-14` | `signals` 只在 `succeeded` 且采集到合法信号时出现，缺省不传空数组；与 `message` 共享 `maxResultBytes`；超限整段丢弃而不是截断 `reason` |

## 4 调度面验证清单

| # | 场景 | 期望 |
|---|---|---|
| 1 | 新 scheduler + 新 client，review 节点 | `tasks[].resultSignal` 出现在 `P-01`；`P-02` 带 `signals`；`run` 按信号判定 |
| 2 | 新 scheduler + 旧 client | 旧 client 忽略 `resultSignal`、不挂 MCP、不发 `signals`；run 走消息回退 |
| 3 | 旧 scheduler + 新 client | 不下发 `resultSignal`；client 不挂 MCP、不发 `signals`；行为与现状一致 |
| 4 | 旧 scheduler + 旧 client | 与现状完全一致（回归） |
| 5 | 模型不调用工具 | `P-02.signals` 缺省；run 走消息回退；client 日志有 `signal.missing` |
| 6 | 挂载失败（signal server 路径错误） | 同参重建一次后 `P-02.status=failed`、`error.code=signal_mount_failed`、`class=protocol`；先有 0 行会话日志 |
| 7 | 预检失败（config 目录不可写） | `failed(protocol, signal_prepare_failed)`，不建 session |
| 8 | signals 超 16 KiB / 8 条 | 只保留最后窗口；`P-02` body ≤ 256 KiB |
| 9 | 结果超长 message + signals | `message` 被截断，`signals` 完整；`truncated=true` 只描述 message |
| 10 | `resultSignal` 形状非法 | client 忽略字段、不挂 MCP、任务照常执行（不因契约脏数据失败） |

## 5 确认点样例（第二场景）

第一次任务（模型需要人拍板时）：

```json
{
  "taskId": "01J9Z...A",
  "attempt": 1,
  "status": "succeeded",
  "sessionId": "<session-id>",
  "message": "需要确认方案后再继续",
  "signals": [
    { "seq": 1, "at": "2026-11-18T05:10:00.000Z", "kind": "confirmation_request",
      "data": { "question": "选择哪个方案？", "context": "A 改动小、B 可扩展", "options": ["A", "B"] } }
  ]
}
```

续跑任务（`CMP-run` 在 `decide` 之后生成）：

```json
{
  "taskId": "01J9Z...B",
  "attempt": 1,
  "resumeSessionId": "<同一个 session-id>",
  "prompt": "人工确认结果：pass（comment：选 B，理由…）",
  "resultSignal": { "version": 1, "kind": "confirmation_request", "required": true, "schema": { } }
}
```

- `reject` **也是续跑**（人工意见进 prompt，模型调整后继续），不是失败；只有 review 的 `needs_human` reject 才走回退。
- 续跑任务若还需要最终判决，`resultSignal` 可按节点类型换成 `review_verdict`（client 与新建路径同一套逻辑）。
- 第一次任务返回的是 `succeeded` + 信号，不是 `waiting_*` 状态；等待由 `CMP-run` 的 `waiting_confirm` 表达，`S-02` 不会重派已结算任务。

## 6 已知边界（调度面需知）

1. `signals` 最多上报最后 8 条；`CMP-run` 取其中最后一条合法记录判定。
2. 挂载失败重建一次发生在**同一 attempt**，不改变 `attempt` 号、不重派。
3. `resultSignal` 形状非法时视为「不支持」，不会让任务失败——脏契约会被静默降级为消息回退，调度面应在生成端做校验（`validateDraft`）。
4. Windows 与单二进制打包形态未实测（`T-RVM-02` 遗留）；当前实现用 `process.execPath`（Bun）+ 绝对 TS 脚本路径。
5. 确认点的等待语义在编排侧（`CMP-run.waiting_confirm` + `decide`）；client 只负责「挂工具、回传信号、resume 续跑」。中断期间 `session` 必须保留（`DSH_HOME` 不被清理；实测 close 后、DSH 重启后都可 resume）。
6. 确认点任务与续跑任务都必须由编排侧保证 `cwd`/工作区不变，否则 `session/resume` 会因 cwd 不一致失败（client 按 `protocol_error` 报失败）。
