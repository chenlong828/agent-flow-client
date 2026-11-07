---
layer: works
module: global
status: active
updated: 2026-11-07
---

# 观测 HTTP P1 评审记录（调度器附评处置）

> 评审对象：[`proposal.md`](proposal.md)（2026-11-06 设计稿）。
> 评审来源：`../../../../agent-flow-orchaster/docs/works/2026-11-05-scheduler-contract-review/review.md` §9（2026-11-06，P1 附评，独立对象）。
> 结论：**方向通过；`OB-02`–`OB-09` 已落稿；`OB-01` 经产品确认（2026-11-07）保持默认 `0.0.0.0` + 可选 token，作为已接受风险，P1 确认门签字完成**。

## 1. 总览

| 档位 | 数量 | 处置 |
|---|---:|---|
| Blocker（`OB-01`） | 1 | **接受风险，不按评审建议改 loopback 默认**；产品决策为 `0.0.0.0` + 可选 token，风险与降级路径已写死 |
| Decision now（`OB-02`–`OB-05`） | 4 | 全部落稿 |
| Hold（`OB-06`–`OB-09`） | 4 | 全部落稿 |

未改 `docs/design/`、未写代码。

## 2. Blocker：`OB-01` 非 loopback 明文传 raw

**评审建议**：v1 只允许 loopback/unix socket，跨机走 SSH 隧道/反代；或强制 TLS + token 过期 + raw 默认关闭；或接受风险并写明。

**client 处置**：按产品决策（2026-11-06）保留默认 `0.0.0.0:17890`、token 可选、CLI 可改，**接受风险**。理由：用户明确要求调度器可直接访问、先做功能性、通道级安全后补；`0.0.0.0` 不等于可路由，部署仍可只开受控网段。

已写死的补偿：

- token 非空时强制 Bearer；token 为空时不鉴权并记 `observability_insecure`；
- `raw_enabled` 可关闭（返回 `403 raw_disabled`）；
- 审计、`no-store`、保留窗口、SSE 并发上限；
- 明确「调度器被攻破 = 所有 client 会话全文泄露」；
- 若安全优先，`--observability-bind 127.0.0.1` 即回到评审推荐形态，无需改代码。

**未关闭项**：TLS/mTLS、token 过期/轮换、来源 IP 限制、unix socket。

**确认记录（2026-11-07）**：产品明确选择「保持 `0.0.0.0` + 可选 token」，接受上述风险，并要求通道级安全后续作为特性补。因此本项不按评审推荐的 loopback 默认执行；P1 确认门对此签字，风险登记在 `docs/plan/risks.md`。

## 3. Decision now 处置

| ID | 处置 | 落点 |
|---|---|---|
| `OB-02` 写盘进热路径 | 执行路径只入内存队列；后台批量落盘；不 `fsync`；队列 10k 溢出计数丢弃；退出 flush 上限 2s；持续失败才 `degraded` | §4.5 |
| `OB-03` 信任面反转 | 新增 §6.1，写明全文跨边界、调度器被攻破的后果、只读/可关闭/审计约束；v1 不 `register` 上报 `observabilityUrl` | §6.1 |
| `OB-04` 组件预算 | `CMP-observability` 预算改为目标 ≤60k / 上限 120k；超 60k 或端点 >12 拆 B 方案 | §5.3 |
| `OB-05` 归档文件契约 | 正式登记布局、`layoutVersion`、原子写、sha256、谁写谁读、失败语义、并发；数据所有权矩阵加一行 | §4.3、§5.3 |

## 4. Hold 处置

| ID | 处置 |
|---|---|
| `OB-06` `/health.version` 撞名 | 拆为 `observabilityVersion` + `clientVersion` |
| `OB-07` loopback + 空 token 本机可读 | 写明单用户开发机/受控容器前提；多用户机器后续 unix socket + 权限位 |
| `OB-08` 404/410 区分 | 清理保留 `meta.json` tombstone（`retained=false`/`prunedAt`）；`410` = 曾存在已清理，`404` = 从未存在 |
| `OB-09` `maxStreams` 作用域 | 明确按 client 全局，不是 per-attempt |

## 5. 待确认

1. ~~`OB-01` 风险接受~~ 已确认（2026-11-07）：保持 `0.0.0.0` + 可选 token，接受风险。
2. `raw_enabled` 默认值：当前 `true`（功能优先，与 `OB-01` 决定一致）；若之后收紧可改 `false`，不改契约。
3. 是否把观测 HTTP 排进 S1.5，还是等 S2 并发稳定后。
