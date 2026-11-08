---
layer: works
module: global
status: frozen
updated: 2026-11-08
---

# 工序 Brief：S1 契约骨架

> 输入：`docs/plan/roadmap.md` 批次 2；冻结契约 `docs/design/contracts/executor-http-v1.md`（v1，`protocolVersion = 2026-11-07.1`）；`CMP-gateway`/`CMP-cli`/`CMP-assets`/`CMP-executor` 规格；`SCN-0001` UC-19–23；`REQ-0002` R-01/R-02/R-08。

## 1. 目标与非目标

**目标**：接桩调度器跑通单节点全链路：`CMP-gateway` 实现 `SchedulerPort`，`serve` 注册/心跳/领取/执行/上报/清理，`CMP-assets` 按 `C-05` 下载并解包技能包；出口是 `proposal.md` §14.3 的门禁（见 §5）。

**非目标**：

- 不实现真实调度器（桩只在测试与本地联调）；
- 不做多实例 per-instance home 派生（OQ-009）、不做轮换/TLS 客户端证书（S3）；
- 不做观测 HTTP（独立 P1）；
- 不把 `serve` 做成系统服务/守护进程（S3 打包）。

## 2. 冻结/决定（2026-11-08，用户确认）

### 2.1 配置键（S1 新增）

```toml
[scheduler]
url = "https://scheduler.example.com"
token = "..."   # 可选；生产建议留空，用环境变量覆盖
```

- 优先级：**非空 `AF_SCHEDULER_TOKEN` > `[scheduler].token`**（token 可直读 `.env`，Bun 自动加载；也接受调度器侧协商的注入方式）。
- `[scheduler].url` 仅配置文件（无 env 覆盖）；`serve` 缺失 → 退出 2；`run` 不要求。
- 非 HTTPS 且非 loopback → 退出 2（契约 §4.2）；loopback：`127.0.0.1` / `::1` / `localhost`。
- token 为空时允许启动但 `doctor` 报 warn（仅限 loopback 开发）；非 loopback 空 token → 退出 2。
- token 不写日志、不进结果、不出现在错误 message。

### 2.2 身份与幂等参数

- `clientId`：持久化 `<stateRoot>/client-id`（0600），不存在时生成 UUIDv7；一安装一值。
- `runId`：每次进程生成 UUIDv7，不持久化；`register` 之后所有请求带 `X-Client-Run-Id`。
- `X-Request-Id`：每请求生成并回显到日志关联键。
- `claimRequestId`：每次领取生成并持有；传输重试复用；`204`/成功后换新（`CMP-gateway#ClaimIdempotency`）。
- 幂等保留窗口按 `OQ-023`：`>= 尝试租约 TTL + 结果确认窗口`，S1 实现默认 10min（调度器侧参数，不进契约）。

### 2.3 S1 运行机制

- `serve` 主循环：注册 → 清理对账 → 恢复 → 独立心跳任务 + 领取循环；同一 `instanceId` 用 `journal.lockInstance` 串行，取锁失败报 `failed(workspace)`。
- 容量单位：实例数（`[capacity].max_instances`，默认 4）；`activeInstances` 取活跃 attempt 的去重实例数。
- 心跳客户端超时 35s、领取 25s、服务端挂起 30s/20s（契约 §4.6）；`nextPollAfterMs` 取 max。
- `run_superseded`：停领、取消活跃、收口后退出 7；`unauthorized`/`version_incompatible` 退出 3；持续不可达按阈值退出 6（S1 先用连续 10 次失败/指数退避上限 60s）。
- `cleanupAcks`：gateway 队列（≤20/跳），失败重发；`cleanupPending` 交 `executor.reconcileCleanup`。
- 技能包 `C-05`：`file://`/本地目录（S0 保留）+ `http(s)://`；zip 用系统 `unzip`（macOS/Linux）解包，解包前后做路径/符号链接校验；缓存键 digest；跨 host 不带 token。
- 模型路由沿用 S0 profile 补丁；`serve` 不改变。

## 3. 任务表

| ID | 类型 | 组件 | 任务 | 状态 | 装载清单 |
|---|---|---|---|---|---|
| `T1` | feature | `CMP-cli` | `[scheduler]` 配置、token env 覆盖、HTTPS 校验、clientId/runId/UUIDv7 | 进行中 | `CMP-cli` §2.3、契约 §4.2/§4.3 |
| `T2` | feature | `CMP-gateway` | HttpTransport、鉴权、版本协商、重试/退避、HTTP 错误 → 端口错误 | 待开始 | `CMP-gateway` §2.1/§2.5/§3.3、契约 §4.4 |
| `T3` | feature | `CMP-gateway` | heartbeat/ackSeq/control 去重、claimRequestId、renew、bindSession、reportResult、cleanupAcks | 待开始 | `CMP-gateway` §2.2–2.4、契约 §5.1–§5.7 |
| `T4` | test | 全部 | 桩调度器（附录 A 最小面）+ 契约测试骨架 | 待开始 | 契约附录 A |
| `T5` | feature | `CMP-assets` | `C-05` HTTP 下载、zip 解包、缓存、校验、跨 host 凭据规则 | 待开始 | `CMP-assets` §2.2–2.4、契约 §5.5 |
| `T6` | feature | `CMP-cli` | `serve` 主循环：注册/心跳/领取/容量/加锁/控制事件/清理/信号/退出码 | 待开始 | `CMP-cli` §2.4、`architecture` §9/§10 |
| `T7` | gate | 全部 | S1 门禁（7 条）+ 桩端到端 + 文档/规格收口 | 待开始 | 本 brief §5、`proposal.md` §14.3 |

## 4. 测试映射

沿用 `docs/design/test-matrix.md`；S1 新增：

| 用例 | 测试文件 |
|---|---|
| UC-19 调度器不可达 | `tests/components/gateway/transport.test.ts`、`tests/scenarios/s1-serve.test.ts` |
| UC-20 心跳长轮询/补发 | `tests/components/gateway/heartbeat.test.ts` |
| UC-21 租约过期/迟到结果 | `tests/components/gateway/report.test.ts`、`tests/components/gateway/renew.test.ts` |
| UC-22 重复投递/上报 | `tests/components/gateway/claim.test.ts`、`tests/components/gateway/report.test.ts` |
| UC-23 版本/鉴权失败 | `tests/components/gateway/transport.test.ts`、`tests/scenarios/s1-serve.test.ts` |
| 契约全序列 | `tests/scenarios/s1-contract.test.ts`（桩调度器 + 桩 ACP） |
| `C-05` 下载 | `tests/components/assets/download.test.ts` |

## 5. S1 门禁（`proposal.md` §14.3）

1. 断网/重复投递下不重复执行（R-01）；
2. `settled` 结果在崩溃重启后可重报（R-02）；
3. 取消/关闭无残留进程（R-03）；
4. 租约过期/迟到结果有确定行为（UC-21）；
5. 版本/鉴权失败退出 3（UC-23）；
6. 结果超限截断且可解析（UC-12）；
7. 控制事件不丢、不重复应用（UC-20）；
8. 释放/清理意图不丢：旧 run 事件丢弃后，`cleanupPending` 仍能驱动清理并回执（`SCH-20`）。

## 6. 验收与收口

- 每任务：`bun test` + `bun run typecheck` + `bun run check`；组件规格 `planned → active`（只改落地组件）；一任务一 commit。
- T7：7/8 条门禁各有测试或真机证据；`bun run check` 全绿；桩端到端跑通注册→心跳→领取→执行→上报→清理。
- 收口：`result.md` + roadmap/architecture/OQ/test-matrix 更新，工序归档。

## 7. 风险

| 风险 | 处理 |
|---|---|
| 真实调度器不存在 | 桩按契约附录 A 实现；契约测试为唯一事实 |
| zip 解包依赖系统 `unzip` | macOS/Linux 自带；Windows 后补（OQ-007）；解包前校验条目、解包后拒符号链接 |
| 长轮询与代理/NAT | 30s 心跳 + 35s 客户端超时；断线退避；以租约裁决 |
| `serve` 与执行共享事件循环 | 心跳独立定时器；prompt 长等不阻塞心跳；测试用慢 prompt 断言心跳继续 |
| token 落 `.config` | 用户已确认方案；`AF_SCHEDULER_TOKEN` 覆盖优先；日志/错误/结果脱敏；`doctor` 不输出 token |
