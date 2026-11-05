---
layer: design
module: global
status: current
generated: true
updated: 2026-11-04
---

# 业务场景索引

> 生成物，不手改。修改场景后运行 `bun run docs:index`；校验运行 `bun run docs:check`。

共 2 个场景。

## 执行面

### 节点执行

| 场景 | 状态 | 流程设计 | 代码入口 | 文档 | 测试 | 外部引用 |
|---|---|---|---|---|---|---|
| [SCN-0001 执行节点并回传结果](execution-plane/node-execution/execute-node-and-report/scenario.md) | designed | [scenario.md#3 运行序](execution-plane/node-execution/execute-node-and-report/scenario.md#3-运行序) |  | [docs/design/architecture.md#5. 主流程](../architecture.md#5-主流程)<br>[docs/design/architecture.md#6. 关键不变量](../architecture.md#6-关键不变量)<br>[docs/design/architecture.md#10. 失败与恢复](../architecture.md#10-失败与恢复)<br>[docs/requirements/REQ-0001-acp-dsh-home-config.md#5. 影响场景](../../requirements/REQ-0001-acp-dsh-home-config.md#5-影响场景)<br>[docs/requirements/REQ-0002-execution-reliability.md#4. 可靠性需求](../../requirements/REQ-0002-execution-reliability.md#4-可靠性需求) | `R1 TC-EXEC-001`（待实现）<br>`R2 TC-EXEC-002`（待实现）<br>`R3 TC-EXEC-003`（待实现）<br>`N1 TC-EXEC-004`（待实现） |  |

### 运行准备

| 场景 | 状态 | 流程设计 | 代码入口 | 文档 | 测试 | 外部引用 |
|---|---|---|---|---|---|---|
| [SCN-0002 配置 client 并完成自检](execution-plane/run-preparation/configure-and-self-check/scenario.md) | designed | [scenario.md#3 运行序](execution-plane/run-preparation/configure-and-self-check/scenario.md#3-运行序) |  | [docs/design/architecture.md#3. 对外接口面](../architecture.md#3-对外接口面)<br>[docs/design/architecture.md#4. 组件与分层](../architecture.md#4-组件与分层)<br>[docs/design/architecture.md#10. 失败与恢复](../architecture.md#10-失败与恢复)<br>[docs/requirements/REQ-0001-acp-dsh-home-config.md#5. 影响场景](../../requirements/REQ-0001-acp-dsh-home-config.md#5-影响场景) | `R1 TC-CONFIG-001`（待实现）<br>`R2 TC-CONFIG-002`（待实现）<br>`R3 TC-CONFIG-003`（待实现）<br>`N1 TC-CONFIG-004`（待实现） |  |
