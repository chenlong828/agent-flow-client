---
layer: design
module: global
status: current
updated: 2026-11-08
---

# 场景 UC → 测试矩阵

> 用途：把 `SCN-0001` / `SCN-0002` 的用例映射到计划中的测试文件，作为 S0/S1/S2 验收与覆盖证明的单一入口（`OQ-024` / `AH-08`）。
> 状态：`planned` 表示测试文件尚未创建；`existing` 表示已有测试。测试 ID 在对应工序拆任务时分配，分配后回填本表。

## 1. 执行节点（`SCN-0001`）

| UC | 场景 | 阶段 | 主责组件 | 计划测试文件 | 测试 ID | 状态 |
|---|---|---|---|---|---|---|
| UC-01 | 单节点执行 | S0 | executor/result | `tests/components/executor/execute-node.test.ts` | `TC-EXEC-001` | planned |
| UC-02 | 顺序多节点 | S0.1/S2 | executor | `tests/components/executor/sequential-nodes.test.ts` | `TC-EXEC-002` | planned |
| UC-03 | fan-out 并发 | S2 | executor | `tests/components/executor/fanout.test.ts` | TBD | planned |
| UC-04 | 技能切换 | S0.1/S2 | assets/executor | `tests/components/assets/install.test.ts` | TBD | planned |
| UC-05 | 容器非法 | S0 | workspace | `tests/components/workspace/layout.test.ts` | `TC-EXEC-004` | planned |
| UC-06 | 技能包异常 | S0 | assets | `tests/components/assets/install.test.ts` | `TC-EXEC-004` | planned |
| UC-07 | 运行时不可用 | S0/S1 | runtime | `tests/components/runtime/session.test.ts` | TBD | planned |
| UC-08 | 工作区不可写/磁盘满 | S0 | workspace | `tests/components/workspace/layout.test.ts` | TBD | planned |
| UC-09 | prompt 超时 | S0/S1 | runtime | `tests/components/runtime/session.test.ts` | TBD | planned |
| UC-10 | 工具失败/权限拒绝 | S0 | runtime | `tests/components/runtime/session.test.ts` | TBD | planned |
| UC-11 | DSH 进程崩溃 | S0 | runtime | `tests/components/runtime/recovery.test.ts` | TBD | planned |
| UC-12 | 结果过大 | S1 | result | `tests/components/result/truncate.test.ts` | TBD | planned |
| UC-13 | 取消执行 | S0/S2 | runtime/executor | `tests/components/runtime/cancel.test.ts` | `TC-EXEC-003` | planned |
| UC-14 | 关闭/二次信号 | S0/S2 | cli | `tests/components/cli/signals.test.ts` | `TC-EXEC-003` | planned |
| UC-15 | client 崩溃重启 | S0（仅清理）/S2 | cli/executor/store | `tests/components/cli/serve-loop.test.ts`、`tests/components/store/recovery.test.ts` | TBD | planned |
| UC-16 | 孤儿进程 | S0 | runtime | `tests/components/runtime/recovery.test.ts` | TBD | planned |
| UC-17 | 崩溃 session/lock | S0 | runtime/store | `tests/components/runtime/recovery.test.ts`、`tests/components/store/locks.test.ts` | TBD | planned |
| UC-18 | 重跑幂等 | S0.1/S1 | executor | `tests/components/executor/state-machine.test.ts` | TBD | planned |
| UC-19 | 调度器不可达 | S1 | gateway/cli | `tests/components/gateway/transport.test.ts` | TBD | planned |
| UC-20 | 心跳长轮询断开 | S1 | gateway | `tests/components/gateway/long-poll.test.ts` | TBD | planned |
| UC-21 | 租约过期/迟到结果 | S1 | gateway/executor | `tests/components/gateway/long-poll.test.ts`、`tests/components/executor/state-machine.test.ts` | TBD | planned |
| UC-22 | 重复投递/上报 | S1 | gateway/executor | `tests/components/gateway/transport.test.ts`、`tests/components/executor/state-machine.test.ts` | TBD | planned |
| UC-23 | 版本/鉴权失败 | S1 | gateway/cli | `tests/components/gateway/transport.test.ts` | TBD | planned |
| UC-24 | 同容器同技能集并发 | S2 | executor | `tests/components/executor/fanout.test.ts` | TBD | planned |
| UC-25 | 不同技能集并发 | S2 | executor/assets | `tests/components/executor/fanout.test.ts`、`tests/components/assets/install.test.ts` | TBD | planned |
| UC-26 | 多实例/容量上限 | S1/S2 | cli | `tests/components/cli/serve-loop.test.ts` | TBD | planned |
| UC-27 | 日志/结果/磁盘上限 | S1/S3 | result/observability/store | `tests/components/result/truncate.test.ts`、`tests/components/observability/logging.test.ts` | TBD | planned |
| UC-28 | 不可信路径 | S0 | workspace | `tests/components/workspace/path.test.ts` | TBD | planned |
| UC-29 | 不可信压缩包 | S0/S3 | assets | `tests/components/assets/security.test.ts` | TBD | planned |
| UC-30 | 凭据泄漏 | S3 | observability/result | `tests/components/observability/logging.test.ts` | TBD | planned |
| UC-31 | 会话隔离 | S0/S3 | runtime/cli | `tests/components/runtime/session.test.ts`、`tests/components/cli/config.test.ts` | TBD | planned |

## 2. 配置与自检（`SCN-0002`）

| 用例 | 场景 | 阶段 | 主责组件 | 计划测试文件 | 测试 ID | 状态 |
|---|---|---|---|---|---|---|
| R1 | 无配置、无 env：默认 home | S0 | cli | `tests/components/cli/config.test.ts` | `TC-CONFIG-001` | planned |
| R2 | 配置相对/绝对路径 | S0 | cli | `tests/components/cli/config.test.ts` | `TC-CONFIG-002` | planned |
| R3 | env 覆盖配置 | S0 | cli | `tests/components/cli/config.test.ts` | `TC-CONFIG-003` | planned |
| N1 | 非法 TOML/空值/不可写/指向 `~/.dsh` | S0 | cli | `tests/components/cli/config.test.ts` | `TC-CONFIG-004` | planned |
| 补充 | `doctor` 缺 DSH/版本/容器/残留/凭据 | S0 | cli/observability | `tests/components/cli/doctor.test.ts` | TBD | planned |

## 3. 覆盖门禁

- 每个 S0 UC（`UC-01/05/06/07/08/13/14/16/17/28/29` 与 `UC-31` 部分）必须有至少一个测试文件；`UC-15` 的 S0 部分只覆盖清理。
- `TC-EXEC-001`…`004` 与 `TC-CONFIG-001`…`004` 是首批锚点；其余测试 ID 在 S0/S1/S2 工序拆任务时分配并回填。
- 新增/修改场景 UC 时同步更新本表；没有映射的 UC 不得标记 `verified`。
- CI 至少跑 `bun test`、`bun run typecheck`、`bun run docs:check`；契约测试见 `design/contracts/executor-http-v1.md` 附录 A。
