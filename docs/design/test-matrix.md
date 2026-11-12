---
layer: design
module: global
status: current
updated: 2026-11-12
---

# 场景 UC → 测试矩阵（executor contract v3）

> 用途：把 `SCN-0001` / `SCN-0002` 的用例映射到测试文件，作为验收与覆盖证明的单一入口（`OQ-024` / `AH-08`）。
> 状态：`planned` 表示尚未创建；`existing` 表示已有测试。测试 ID 唯一，测试标题以 ID 开头。

## 1. 执行任务（`SCN-0001`）

| UC | 场景 | 阶段 | 主责组件 | 测试文件 | 测试 ID | 状态 |
|---|---|---|---|---|---|---|
| UC-01 | 单任务执行 | S0/S1 | executor/result | `tests/scenarios/s0-exec.test.ts` | `TC-EXEC-001` | existing |
| UC-02 | 顺序/并发两任务 | S2 | executor/cli | `tests/scenarios/v2-serve.test.ts` | `TC-EXEC-002` | existing |
| UC-03 | 同实例 fan-out 并发 | S2 | executor/cli | `tests/scenarios/v2-serve.test.ts` | TBD | existing |
| UC-04 | 技能切换 | S2 | assets/executor | `tests/components/assets/assets.test.ts` | TBD | existing |
| UC-05 | 容器非法 | S0 | workspace | `tests/components/workspace/workspace.test.ts` | TBD | existing |
| UC-06 | 技能包异常 | S0 | assets | `tests/scenarios/s0-exec.test.ts` | `TC-EXEC-004` | existing |
| UC-07 | 运行时不可用 | S0 | runtime | `tests/components/runtime/runtime.test.ts` | TBD | existing |
| UC-08 | 工作区不可写 | S0 | workspace | `tests/components/workspace/workspace.test.ts` | TBD | existing |
| UC-09 | prompt 超时 | S0 | runtime | `tests/components/runtime/runtime.test.ts` | TBD | existing |
| UC-10 | 工具权限 | S0 | runtime | `tests/components/runtime/runtime.test.ts` | TBD | existing |
| UC-11 | DSH 进程崩溃 | S0 | runtime | `tests/components/runtime/runtime.test.ts` | TBD | existing |
| UC-12 | 结果过大 | S1 | result/executor | `tests/components/result/result.test.ts`、`tests/components/executor/execute.test.ts` | TBD | existing |
| UC-13 | 取消执行 | S0/S2 | runtime/executor | `tests/scenarios/v2-serve.test.ts` | `TC-EXEC-003` | existing |
| UC-14 | 信号收口 | S0 | cli | `tests/components/cli/signals.test.ts` | TBD | existing |
| UC-15 | 崩溃重启补报 | S0/S2 | cli/store | `tests/components/store/journal.test.ts`、`tests/scenarios/v2-serve.test.ts` | TBD | existing |
| UC-16 | 孤儿进程 | S0 | runtime | `tests/components/runtime/runtime.test.ts` | TBD | existing |
| UC-17 | session 不复用 | S0 | runtime/executor | `tests/components/executor/execute.test.ts` | TBD | existing |
| UC-18 | 重跑/首份结果 | S1/S2 | gateway/executor | `tests/components/gateway/gateway.test.ts`、`tests/components/executor/execute.test.ts` | TBD | existing |
| UC-19 | 调度器不可达 | S1 | gateway/cli | `tests/components/gateway/transport.test.ts`、`tests/scenarios/v2-serve.test.ts` | TBD | existing |
| UC-20 | poll 断开/重连 | S1 | cli | `tests/scenarios/v2-serve.test.ts` | TBD | existing |
| UC-21 | 超时/重复派发 | S1 | gateway/executor | `tests/scenarios/v2-serve.test.ts` | TBD | existing |
| UC-22 | 重复投递/上报 | S1 | gateway | `tests/components/gateway/gateway.test.ts` | TBD | existing |
| UC-23 | 协议/鉴权失败 | S1 | gateway/cli | `tests/scenarios/v2-serve.test.ts`、`tests/components/gateway/transport.test.ts` | TBD | existing |
| UC-24 | 同容器同技能集并发 | S2 | executor/cli | `tests/scenarios/v2-serve.test.ts` | TBD | existing |
| UC-25 | 不同技能集并发 | S2 | assets | `tests/components/assets/package.test.ts` | TBD | existing |
| UC-26 | 容量上限 | S1/S2 | cli | `tests/scenarios/v2-serve.test.ts` | TBD | existing |
| UC-27 | 日志/结果上限 | S1/S3 | result/observability | `tests/components/result/result.test.ts` | TBD | existing |
| UC-28 | 不可信路径 | S0 | workspace | `tests/components/workspace/workspace.test.ts` | TBD | existing |
| UC-29 | 不可信包 | S0/S3 | assets | `tests/components/assets/assets.test.ts`、`tests/components/assets/package.test.ts` | TBD | existing |
| UC-30 | 凭据泄漏 | S3 | observability/result | `tests/components/observability/logger.test.ts` | TBD | existing |
| UC-31 | 会话隔离 | S0/S3 | runtime/cli | `tests/components/runtime/runtime.test.ts`、`tests/scenarios/s0-config.test.ts` | TBD | existing |

## 2. 配置与自检（`SCN-0002`）

| 用例 | 场景 | 阶段 | 主责组件 | 测试文件 | 测试 ID | 状态 |
|---|---|---|---|---|---|---|
| R1 | 默认 home | S0 | cli | `tests/components/cli/config.test.ts`、`tests/scenarios/s0-config.test.ts` | `TC-CONFIG-001` | existing |
| R2 | 绝对/相对路径 | S0 | cli | `tests/components/cli/config.test.ts` | `TC-CONFIG-002` | existing |
| R3 | env 覆盖 | S0 | cli | `tests/components/cli/config.test.ts` | `TC-CONFIG-003` | existing |
| N1 | 非法配置 | S0 | cli | `tests/components/cli/config.test.ts` | `TC-CONFIG-004` | existing |
| 补充 | `doctor` 缺 DSH/凭据/残留 | S0 | cli/observability | `tests/components/cli/commands.test.ts` | TBD | existing |
| R4 | 自报身份取值/来源/开发期提示 | S1 | cli/gateway | `tests/components/cli/config.test.ts`、`tests/components/cli/commands.test.ts`、`tests/components/gateway/transport.test.ts`、`tests/scenarios/v3-serve.test.ts` | `TC-CLT-ENR-1`…`4` | existing |
| N2 | 非法 `client_id` / `allow_unauthenticated` 类型 | S1 | cli | `tests/components/cli/config.test.ts` | `TC-CLT-ENR-3` | existing |

## 3. 契约 v3 专项

| 契约面 | 测试文件 |
|---|---|
| `P-01` poll 请求/响应/stop/cancelInstances | `tests/components/gateway/gateway.test.ts`、`tests/scenarios/v2-serve.test.ts` |
| `P-02` result 首份为准/404/accepted=false | `tests/components/gateway/gateway.test.ts` |
| `P-03` 下载/304/404/摘要 | `tests/components/gateway/gateway.test.ts`、`tests/components/assets/package.test.ts` |
| 头部/错误码/重试 | `tests/components/gateway/transport.test.ts` |
| 身份头 `X-Client-Id`/`X-Client-Address`（开发期） | `tests/components/gateway/transport.test.ts`、`tests/scenarios/v3-serve.test.ts` |
| `running[]`/`finished[]`/`archivedRuns` | `tests/scenarios/v2-serve.test.ts` |
| `P-04` 日志先于结果、空日志、413 | `tests/components/gateway/gateway.test.ts`、`tests/components/executor/execute.test.ts`、`tests/scenarios/v3-serve.test.ts` |
| `P-05` 归档后到覆盖、`invalid_state`、后台归档 | `tests/components/gateway/gateway.test.ts`、`tests/scenarios/v3-serve.test.ts` |
| task-space 校验/创建（不写内容） | `tests/components/workspace/task-space.test.ts`、`tests/components/executor/execute.test.ts`、`tests/scenarios/v3-serve.test.ts` |
| `archiveRequests`/`archivedRuns` 电平 | `tests/scenarios/v3-serve.test.ts` |

## 4. 覆盖门禁

- `TC-EXEC-001`…`004` 与 `TC-CONFIG-001`…`004` 是锚点；新增/改 UC 时同步更新本表。
- v3 关键门禁：空日志可结算、日志先于结果、task-space 只建目录、归档后台不阻塞 poll、`archivedRuns` 确认、结果先落盘后补报、并发不串、取消无残留。
