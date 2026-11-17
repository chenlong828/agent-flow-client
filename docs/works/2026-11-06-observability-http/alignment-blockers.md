---
layer: works
module: global
status: active
updated: 2026-11-17
---

# 实施前对齐：上游确认稿 vs client v2 提案

> 上游确认稿：[`2026-11-17-client-observability`](../../../../agent-flow-orchaster/docs/works/2026-11-17-client-observability/proposal.md)。
> 结论：**不能直接开始实现**，有 3 个契约级冲突必须先定；其余（文件拉取、runId、组件 B、鉴权/绑定、发现）已对齐。

## 1. 已对齐

| 项 | 上游 | client v2 |
|---|---|---|
| 文件端点 | `O-09`/`O-10`，run-scoped 相对路径 | 同 |
| `runId` | `TaskRequest.runId?` + `runs/<runId>.json` | 同 |
| 组件 | 新增 `CMP-observer` | 已改为 B |
| 默认绑定 | `127.0.0.1`，非 loopback 必须 token | 同 |
| 启动降级 | `required=false`，失败不杀 serve | 同 |
| 鉴权 | 复用 executor token | 同 |
| 发现 | 静态优先 + `X-Observability-Url` | 同 |
| 版本 | `2026-11-17.1` | 同 |

## 2. 冲突

| # | 冲突 | 上游 | client v2 | 影响 |
|---|---|---|---|---|
| C1 | attempt 端点 | `O-02`–`O-05`：attempt 列表/详情/日志/日志 SSE，`attemptId` 主键 | 删除，主键 `sessionId` | orchestrator 适配器/产品 API 会调 `/attempts*`，client 不实现则 404 |
| C2 | 事件内容 | `O-07` 是 P1 的规范化事件：`kind=acp` 只是 preview，不写 prompt/推理/tool I/O，全文走 raw | `SessionEvent` full：prompt/正文/思考/tool 输入输出 | 二选一，不能同一 `O-07` 同时返回两种 schema |
| C3 | 实时通道 | `O-05` 是 attempt 日志 SSE | `S-05` 是 session 事件 SSE | 路径/资源不同；orchestrator 不调 session SSE，前端“打开 session 实时看”没有入口 |

次要不一致：

- 上游无 `/sessions` 列表；client v2 的 `S-02` 是新增发现方式，非必需。
- 上游 attempt 事件存 `attempts/<attemptId>/events.jsonl`；client v2 session 事件存 `sessions/<sessionId>/events.jsonl`；合并时要定一份还是两份。
- 上游 `O-01` 增 `registeredRuns/filesEnabled/authRequired`；client v2 有 `activeSessions/retainedSessions/contentLevel`；字段可合并。

## 3. 建议的合并方案

**保留上游 O-01–O-10 作为外部契约，另加一个可选 `O-11` 供 session 实时富视图。**

1. **恢复 attempt 端点与 `attemptId`**：实现 `O-02`–`O-05`，`attemptId` 按上游 uuid-v7；`O-06` 返回 `attemptId`。
2. **事件存储以 attempt 为索引**：`attempts/<attemptId>/events.jsonl` 同时存 phase/log/result 与 ACP 事件；ACP 事件带 `sessionId`。`O-04`/`O-05` 读 attempt 流；`O-07` 按 `sessionId` 过滤同一份事件流，返回富事件。
3. **富内容用 `content_level` 控制**：`full` 时 `O-04`/`O-05`/`O-07` 的 ACP 事件带 prompt/message/thought/tool 输入输出（有上限）；`metadata` 时回到上游 preview。`raw` 仍兜底全文。
4. **实时**：`O-05` 继续叫 attempt 日志 SSE，但事件体在 `full` 下就是富 ACP 事件；另加 `O-11 GET /sessions/{sessionId}/events/stream` 作为“按 session 打开”的便捷入口（内部复用同一 EventHub）。若上游不接受新增端点，只保留 `O-05`，UI 先 `O-06` 拿 `attemptId` 再订阅。
5. **session 列表**：不新增；发现用 `O-02`（可按 `sessionId`/`runId` 过滤）。client v2 的 `S-02` 可删。
6. **组件**：`CMP-observer` 统一 HTTP/SSE/查询/文件；`CMP-observability` 管 attempt/session 事件存储；`CMP-runtime` 管 raw；`CMP-store` 管 run 注册表；`CMP-workspace` 只读文件。

## 4. 需要确认

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 恢复 `O-02`–`O-05` 与 `attemptId`，覆盖此前“不做 attempt”的优先级？ | 是，按上游确认稿 |
| Q2 | `O-04/O-05/O-07` 是否接受 `content_level=full` 的富 ACP 事件？ | 是，否则“打开 session 看 ACP 反馈”只能靠 raw |
| Q3 | 实时用 `O-05`（扩展富事件）还是新增 `O-11` session SSE？ | 两者都做：`O-05` 兼容上游，`O-11` 供 session 直达 |

确认 Q1–Q3 后，client 提案改为合并版，按以下顺序实现：

1. 冻结 client 契约（O-01–O-11 + `content_level` + runId/文件）；
2. `CMP-observer` + `CMP-observability` 事件存储/查询；
3. `CMP-runtime` ACP 归一化 + raw 归档；
4. `CMP-store` run 注册表 + `CMP-executor` 接线；
5. `CMP-workspace` 只读文件 + `O-09`/`O-10`；
6. 测试/文档；orchestrator 适配器另立工序。

## 5. 2026-11-17 决策结果（用户确认）

| # | 决策 | 结果 |
|---|---|---|
| Q1 | attempt 端点 | **按上游恢复** `O-02`–`O-05` 与 `attemptId` |
| Q2 | 事件内容 | **严格按上游 preview**；`O-04`/`O-05`/`O-07` 不返回 prompt/思考/工具 I/O |
| Q3 | 实时通道 | **`O-05` 扩展 + `O-11` session SSE**；`O-11` 承担运行中富事件流 |

结论：冲突已收敛，按合并稿实现；富历史仍走 `O-08` raw，不扩大 `O-07`。
