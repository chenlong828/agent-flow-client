---
layer: design
module: global
status: current
updated: 2026-11-03
---

# 执行面客户端架构

> 范围：client 的对外接口面、组件切分、主流程、数据所有权与关键不变量。字段级契约、DSH/ACP 细节与实现细节不在本文。
>
> 设计过程与取舍见 `docs/history/works/2026-11-03-client-concept-design/`（历史记录，不作为现行依据）。
>
> 上游边界与职责：`../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md`。

## 1. 定位

- client 是**执行面**：把调度器下发的节点在本机执行出来，只回少量控制信息；编排决策全部在调度器。
- 单进程 Bun CLI：常驻 `serve` 与单次 `run` 共用一个执行内核；**不提供本地 HTTP 服务或 IPC**。
- 跨边界只走 HTTP，client 主动出站；调度器不主动连 client。编排事件随 client 的心跳长轮询下发。

## 2. 运行模型

| 维度 | 规则 |
|---|---|
| 进程 | 一个 client 进程；`serve` 常驻，`run` 单次；同一执行内核 |
| 实例 | 一个实例一个 DSH 进程；client 可同时承载多个实例，受容量限制 |
| session | 一个可执行节点一个 session；建 session → 上报 id → 取技能集 → prompt；用完即关，不复用 |
| 工作区 | 一实例一个**容器**：准备阶段预置，含 0..N 个带 `.git` 的仓库；顺序节点共享；fan-out 分支共享同一容器与同一技能集 |
| 技能 | 节点级集合；落地在容器根 `.dsh/skills`；刷新是替换，按 digest 幂等 |
| 心跳 | 30s 长轮询，兼作控制事件通道；请求到达即续租，租约过期裁决离线 |
| 取消 | 实例级整体取消（含整个 fan-out），立即终止，不等跑完 |

## 3. 对外接口面

### 3.1 调度器契约面（client 是消费方，权威在调度器）

| 交互面 | 占位操作 | 目的 |
|---|---|---|
| 注册与心跳 | `register` / `heartbeat`（长轮询） | 身份、版本、容量、存活；回带控制指令 |
| 领取与租约 | `claim` / `renew` | 取绑定本 client 的节点请求；表达租约 |
| 会话绑定与技能集 | `bindSession` | 上报 session id；取该节点技能集 |
| 结果上报 | `reportResult` | 少量结果与错误类别 |
| 取消/关闭控制 | `control`（随心跳响应下发） | 取消实例、暂停/恢复、关闭 |

字段级契约由 M1 冻结；client 只实现消费端，不自定义字段。

### 3.2 CLI 操作面

`serve` / `run` / `doctor` / `version`；配置启动时一次性加载、校验、冻结。退出码：`0` 成功、`2` 用法/配置、`3` 鉴权或版本不兼容、`4` DSH/运行时、`5` 工作区或资产、`6` 调度器不可达、`130` SIGINT。SIGINT/SIGTERM：停止领取 → 取消活跃尝试 → flush journal → 关 session/进程 → 退出；第二次信号强杀并记录未收口尝试。

## 4. 组件与分层

| 层 | 组件 | 职责 |
|---|---|---|
| L2 | `CMP-cli` | 命令与配置、`serve` 循环、组合根装配、信号与退出码 |
| L1b | `CMP-executor` | 节点尝试状态机、定义 5 个端口、attempt 幂等、取消/超时分岔、技能刷新幂等 |
| L1a | `CMP-result` | `NodeResult` 组装、错误分类、结果截断（纯策略） |
| L0 | `CMP-gateway` | `SchedulerPort`、HTTP 长轮询与重连、鉴权、版本协商、幂等键、租约计时 |
| L0 | `CMP-runtime` | DSH 进程、实例 profile 补丁、ACP session 与事件、取消与进程回收 |
| L0 | `CMP-workspace` | 容器校验、`.dsh/skills` 安装点、路径约束、清理 |
| L0 | `CMP-assets` | 技能包获取/校验、原子替换、脚本赋权、缓存与失效 |
| L0 | `CMP-store` | journal、实例锁、孤儿进程记录 |
| L0 | `CMP-observability` | 结构化日志、`doctor`、脱敏、可选进度事件 |

端口（`SchedulerPort` / `RuntimePort` / `WorkspacePort` / `AssetPort` / `JournalPort`）全部定义在 `CMP-executor`，L0 实现并在组合根注入。依赖方向：L2 → L1 → 端口 ← L0，L0 之间不横向调用。

## 5. 主流程

1. 领取（租约）：`claim` 取绑定本实例的 `NodeRequest`（含容器路径、技能集引用与 prompt）。
2. 准备：`CMP-workspace` 校验预置容器；`CMP-runtime` 确保实例 DSH 进程（独立 `DSH_HOME`，profile 补丁写入技能可见性配置）。
3. 建 session：`session/new`，`cwd` 固定为容器根；上报 `sessionId`。
4. 取技能集：`bindSession` 返回该节点技能集。
5. 刷技能：`CMP-assets` 原子替换容器根 `.dsh/skills`（按 digest 幂等），脚本赋权。
6. 执行：下发 prompt，消费 ACP 事件，累积最终消息、停止原因与用量。
7. 结算：`CMP-result` 组装 `NodeResult`，`CMP-gateway` 上报（同 attempt 幂等）。
8. 收尾：关 session；实例结束或取消时关进程、按策略清理容器与 `DSH_HOME`。

技能刷新失败不降级执行；刷新失败、容器校验失败、DSH 启动失败都按节点失败上报。

## 6. 关键不变量

1. 一个 client 实例同一时刻只执行一个尝试；`attemptId` 去重，重复领取不重复执行。
2. 先建 session、再取技能集、再刷新、再 prompt；顺序不交换。
3. 技能刷新是替换不是叠加；失败不留半套，不 prompt。
4. 一个可执行节点一个 session；session 不复用。
5. 取消是实例级整体终止：所有活跃 session 关闭、杀进程组，各 attempt 报 `cancelled`。
6. 跨边界只传控制信息；产物、完整会话记录、日志不出本机。
7. 工作区单写；路径限制在容器内，拒绝越界与跟随越界符号链接。
8. 容器预置：client 不 clone、不检出、不建仓库。
9. 容器根即技能根：session `cwd` 固定为容器根，不指向子仓库。
10. 容器根不建 `.git`，且位于任何仓库之外；`doctor` 校验 `findProjectRoot(容器根) === 容器根`。
11. 同一容器的并发节点由调度器保证同一技能集；client 按 digest 幂等安装，违约显式失败。
12. 心跳是长轮询：请求到达即续租，断开/超时是离线信号，最终以租约过期裁决。
13. 控制事件至少一次投递、按 `seq` 幂等应用；已结算的取消只 ack。

## 7. 数据所有权

| 数据/状态 | 唯一写入口 | 一致性/保留 |
|---|---|---|
| 工作区容器与产物（根 + 子仓库工作树 + `.dsh/skills`） | `CMP-workspace` | 本地强一致；预置仓库按策略保留，默认不删 |
| 技能缓存与落地 | `CMP-assets` | 原子替换；缓存可失效 |
| DSH 进程 / session / `DSH_HOME` | `CMP-runtime` | 进程退出即回收；一实例一 home |
| journal / 实例锁 / 孤儿记录 | `CMP-store` | 追加写；崩溃可重建 |
| 尝试状态 | `CMP-executor` | 仅运行期；可从 journal 重建 |
| 配置 | `CMP-cli` | 启动校验；运行期不变 |
| 日志 | `CMP-observability` | 本地、脱敏、轮转 |

规则：每份数据只有一个写入口；client 本地记录只用于恢复，不是第二真相；session 绑定语义以调度器为准。

## 8. 工作区与技能可见性

```
<workspace>/                    ← 容器根：技能根、session cwd；位于任何 git 仓库之外
├── .dsh/skills/                ← 当前节点的技能集（替换式刷新；脚本随包）
├── repo-a/    (.git)           ← 准备阶段预置的代码/文档容器
└── repo-b/    (.git)
```

- 容器由准备阶段预置，`NodeRequest` 带容器路径（编排层参数）；仓库清单由目录本身表达。
- 容器根不建 `.git`，且必须位于任何仓库之外；否则 `projectRoot` 上浮，`.dsh/skills` 不可见。
- DSH 的项目根取 `cwd` 向上最近的 `.git`，否则 `cwd`；因此 cwd 必须是容器根。
- 技能可见性：实例 profile 保留 `includeDefaultRoots: true`，把 `dshHome` / `agentsHome` / `bundledSkillDir` 指向三个真实空目录；**只屏蔽全局根，保留项目 `.dsh` / `.agents`**。项目自带 `.agents/skills` 仍可见，同名时 `.dsh` 优先（rank 100 < 200）。
- 不要用 `DSH_HOME` 环境变量关技能；它同时影响 settings、credentials 等插件。
- `skill-filesystem` 的补丁是整份替换 config，不与默认配置深合并；未写字段回落 schema 默认值。

## 9. 控制事件（调度器 → client）

- 通道：心跳长轮询 `heartbeat(state, ackSeq) → ControlBatch`；有事件立即返回，无事件挂起 30s 返回空批；不新增独立通知端点，不做 WebSocket/SSE。
- 事件闭集：`cancel(instanceId, reason)`、`pause(instanceId)`、`resume(instanceId)`、`shutdown(instanceId?)`。
- 流转：调度器按 client 单调 `seq` 入队 → 心跳响应内联 `ControlBatch` → `CMP-gateway` 校验 → `CMP-cli` 分派 → `CMP-executor` 执行 → 下次心跳带 `ackSeq` 累计确认。
- 语义：至少一次 + 按 `seq` 幂等；断连补发；已结算事件回 `stale` 只 ack；`cancel` 立即终止、不等 prompt 自然结算；未知类型 ack 并记录。
- 权限请求的人工审批不在本通道：当前由 client 本地策略裁决；若编排要参与，需新增同步交互面（契约变更）。

## 10. 失败与恢复

- 网络/租约：传输退避重试；租约过期丢弃尝试，迟到结果只入审计。
- 技能资产：原子回滚，不 prompt，节点失败（资产类）。
- 工作区：校验失败即节点失败；不迁移其他 client。
- DSH/ACP：关闭坏 session，必要时杀进程；节点失败（运行时类）。
- 崩溃/重启：清理孤儿进程与残留 session，重新注册领取，重跑当前节点；**不依赖 session 恢复或历史回放**。
- 恢复原则：暂停在节点边界生效；恢复时重跑当前节点。

## 11. 不做

- 不做编排决策（下一节点、评审、分支、fan-out 拆分、回退）。
- 不读调度器数据库、不上传产物、不传完整会话记录、不做跨 client 迁移。
- 不做 DSH 改造、不做 UI、不提供本地 HTTP/IPC 服务。

## 12. 后续

- 每个组件落地前补 `docs/design/components/<id>/spec.md`（契约、数据所有权、预算、单独验证命令）。
- S0 本地闭环工序：以冻结稿的用例与不变量为输入；优先验证取消/崩溃清理、长轮询心跳、容器根技能可见性。
- M1 字段级契约：`NodeRequest` / `NodeResult` / `SkillSet` 字段、技能集下发形态、容量单位、鉴权方式、版本兼容窗口、结果大小上限、租约 TTL（>30s）。
