---
layer: history
module: global
status: frozen
updated: 2026-11-03
---

# 执行面客户端概念设计：服务接口面与模块划分

> **状态：已确认并冻结（2026-11-03）。** 现行系统真相见 `docs/design/architecture.md`；决策记录见 `docs/history/decisions/2026-11-03-client-concept.md`。本文作为概念设计细节保留，不再修改。

> 定位：P1 概念设计稿。只回答「client 对外承诺什么、内部由谁负责、依赖指向哪里、失败怎么算」。字段级契约、本地目录布局、库表与实现细节不在本稿，留给 M1 接口设计与组件规格。
>
> 前提（2026-11-03 已实测）：DSH 在每次 `session/prompt` 时重新读取工作区技能，而不是在 `session/new` 时固化。OQ-001 关闭，主流程不再需要备选分叉。
>
> 上游：`../../../../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/boundary-design.md` 与 `client-work.md`。

## 0. 结论摘要

一句话：client 的活是「取技能集 → 刷本地目录 → 收 prompt → 指挥 DSH → 回控制信息」；编排决策（下一节点、并行、评审、回退）全在调度器。

1. **对外只有两个面**：调度器 HTTP 契约面（client 是消费方，权威在调度器）与 CLI 操作面（`serve` / `run` / `doctor` / `version`）。**不提供本地 HTTP 服务或 IPC**。
2. **内部 9 个组件、三层**：L2 整合 `CMP-cli`；L1 领域 `CMP-executor`、`CMP-result`；L0 基础设施 `CMP-gateway`、`CMP-runtime`、`CMP-workspace`、`CMP-assets`、`CMP-store`、`CMP-observability`。
3. **端口由领域定义、基础设施实现**：`SchedulerPort` / `RuntimePort` / `WorkspacePort` / `AssetPort` / `JournalPort` 全部定义在 `CMP-executor`，L0 组件实现并在组合根注入。
4. **主流程冻结为一条**：领取（租约）→ 校验工作区、启动进程 → 建 session → 上报 id 取技能集 → 原子替换技能 → prompt → 组装结果 → 上报 → 关 session。技能刷新失败不降级执行。
5. **结果三段拆开**：事件提取在 `CMP-runtime`、结果语义与错误分类在 `CMP-result`、传输与幂等在 `CMP-gateway`，各自只有一个变化轴。
6. **client 只回控制信息**：最终消息、状态、停止原因、用量、错误类别、session id；产物、完整会话记录、日志不出本机。

## 1. 业务能力、变化轴与不变量

### 1.1 能力盘点

| 业务能力 | 服务对象 | 触发 | 结果 | 规则/不变量 | 数据 | 失败语义 | 频率 | 深浅 | 变化可能性 |
|---|---|---|---|---|---|---|---|---|---|
| 接入调度器 | 调度器 | 启动/心跳 | 注册、容量与存活上报 | 身份必带；容量是上限不是承诺 | 配置、凭据 | 退避重试；鉴权失败停 | 秒级 | 热 | 低 |
| 领取与租约 | 调度器 | 有空闲容量 | 节点执行请求 + 租约 | 只领绑定实例；租约内才执行 | 尝试记录 | 租约过期丢弃 | 秒级 | 热 | 低 |
| 准备运行环境 | 本机 | 领取到实例首个节点 | 校验通过的工作区 + DSH 进程 | 工作区预置（不 clone）；一实例一进程；工作区单写 | 目录、进程 | 节点失败 | 分钟级 | 冷 | 中 |
| 会话绑定与技能装配 | 调度器 + 本机 | 每个可执行节点 | session id 绑定 + 技能就位 | 先建 session 后取技能；替换不是叠加 | session、技能目录 | 不 prompt，节点失败 | 分钟级 | 冷 | 中 |
| 节点执行 | 模型/本机 | prompt 下发 | 事件流 → 最终消息 | 一节点一 session，不复用 | 会话事件 | 超时/取消/崩溃分路 | 分钟级 | 冷 | 高（DSH/ACP） |
| 结果产出与上报 | 调度器 | prompt 结算 | 少量结果 | 只回控制信息；attempt 幂等 | 结果记录 | 传输重试；迟到入审计 | 每节点 | 冷 | 中（契约） |
| 恢复与清理 | 本机 | 崩溃/重启/实例结束 | 无孤儿、可重跑 | 不依赖 session 恢复；直接重跑 | journal、pid | 尽力清理 | 低频 | 冷 | 低 |
| 自检与观测 | 操作者 | 手动/失败后 | doctor 报告、本地日志 | 不传全文；脱敏 | 日志 | 不影响主流程 | 低频 | 冷 | 低 |

### 1.2 三个最易变的设计决策（模块边界依据）

1. **调度器协议**（端点、幂等、版本协商）→ 封在 `CMP-gateway`。
2. **DSH/ACP 版本与协议行为**（事件、权限、取消）→ 封在 `CMP-runtime`。
3. **本地文件与进程环境**（工作区模式、DSH_HOME、清理策略）→ 封在 `CMP-workspace` 与 `CMP-runtime`。

### 1.3 三个不能破的不变量

1. **一实例一 DSH 进程，一可执行节点一 DSH session，关闭后不复用。**
2. **技能必须先刷新成功再 prompt；刷新是替换，失败不许带半套执行。**
3. **跨边界只传控制信息；产物与完整会话记录不出本机。**

### 1.4 三个最痛失败

1. **重复执行**：上报失败或重复投递导致同一节点跑两遍，产生两份产物。
2. **错技能组合**：刷新竞态或半套技能，模型看到不属于当前节点的能力。
3. **残留进程**：取消/崩溃后 DSH 进程或 session 未回收，占资源、污染下一次尝试。

## 2. 对外服务接口面

### 2.1 面 A：调度器 HTTP 契约面（client 是消费方）

五个交互面。方法名是占位名，权威在调度器侧，字段级契约由 M1 冻结；client 只实现消费端，不自定义字段。

| 交互面 | 占位操作 | 方向 | 目的 | 关键不变量 | 错误类别 |
|---|---|---|---|---|---|
| 注册与心跳 | `register` / `heartbeat`（长轮询） | client → 调度器 | 身份、版本、容量、存活；回带控制指令 | 每次带身份；容量是上限；请求到达即续租；断开/超时是离线信号，租约过期裁决 | `unauthorized`、`version_incompatible`、`unreachable` |
| 领取与租约 | `claim` / `renew` | client → 调度器 | 取绑定本 client 的节点请求；表达「这段时间归你」 | 只领绑定实例；租约内才执行；重复领取需可识别 | `lease_expired`、`conflict`、`rate_limited` |
| 会话绑定与技能集 | `bindSession` | client → 调度器 → client | 上报 session id；取该节点技能集 | session 必须由本 client 为本 attempt 创建；技能集只属于该节点 | `stale_attempt`、`invalid_session` |
| 结果上报 | `reportResult` | client → 调度器 | 少量结果与错误类别 | 同 attempt 幂等；迟到结果只入审计 | `unreachable`、`late_result` |
| 取消/关闭控制 | `control`（随心跳长轮询下发，见 §4.7） | 调度器 → client | 取消当前节点、关闭实例、暂停 | 取消可被 ack；关闭幂等；断连补发 | — |

跨面规则：

- **至少一次投递 + 幂等**：`claim` 与 `reportResult` 都按 `attemptId` 去重；重复领取不得重复执行。
- **版本协商**：client 上报自身与 DSH 版本；不兼容时拒绝领取并给出原因，不带病执行。
- **传输失败 client 重试，业务失败调度器裁决**：重试只改变传输结果，不改变业务语义。
- **迟到结果只入审计**：租约过期后的上报不推进流程，不覆盖新尝试。
- **所有请求带身份凭据**：凭据只在本地安全位置，不进结果、日志、prompt。

### 2.2 面 B：CLI 操作面

| 命令 | 模式 | 输入 | 输出 | 关键语义 |
|---|---|---|---|---|
| `serve` | 常驻 | `--config <path>` 或环境变量、`--log-level`、`--concurrency` | 结构化日志、退出码 | 循环领取 + 心跳 + 执行；SIGINT/SIGTERM 优雅停；重启幂等 |
| `run` | 单次 | `--request <file>`（本地节点请求，S0 假任务） | stdout 输出 `NodeResult`（JSON） | 不接调度器；与 `serve` 共用执行内核 |
| `doctor` | 单次 | `--json` | 检查项表 | DSH 定位与版本、工作区可写、凭据存在、调度器连通、DSH 插件加载结果 |
| `version` | 单次 | — | 版本 | 同时输出协议版本与 DSH 版本基线 |

**配置项（概念级）**：`scheduler.url`、`client.id`、凭据引用、`dsh.bin` / `dsh.version`、`workspace.root`、`concurrency`、`retention`、`log.level`。启动时一次性读取、校验、冻结，运行期不热更新。

**退出码**：`0` 成功；`2` 用法/配置错误；`3` 鉴权或版本不兼容；`4` DSH/运行时失败；`5` 工作区或资产失败；`6` 调度器不可达；`130` 被 SIGINT 中断。

**信号语义**：SIGINT/SIGTERM → 停止领取 → 取消活跃 attempt（`session/cancel` + 进程兜底）→ flush journal → 关 session/进程 → 退出。第二次信号强杀，但记录未收口的 attempt。

### 2.3 明确不提供的面

- **不做本地 HTTP 服务与 IPC socket**。理由：上游契约是 client 出站租约模型；改成本地服务端会引入端口管理、鉴权面、调度器推送与 NAT/防火墙问题，属于两侧边界变更（P1），不在本设计内。若未来要做本地调试面板，另立工序并先改上游边界。

## 3. 内部模块划分

### 3.1 分层与依赖方向

```
L2 整合    CMP-cli ─────────────── 命令、配置、serve 循环、run 单次、装配、信号、退出码
                │ 调用用例（executeNode）
L1 领域    CMP-executor ────────── 节点执行状态机与不变量；定义 5 个端口
           CMP-result ──────────── 结果值类型、错误分类、截断策略（纯策略，无 I/O）
                │ 端口
L0 基础设施 CMP-gateway   调度器 HTTP：注册/心跳/领取/租约/绑定/上报/幂等/版本
           CMP-runtime   DSH 进程 + ACP：session/prompt/事件/权限/取消/关闭
           CMP-workspace 多仓库容器、共享/独立、路径约束、清理
           CMP-assets    技能包获取、校验、原子替换、脚本落地、缓存
           CMP-store     journal、实例锁、孤儿记录、清理
           CMP-observability 日志、doctor、可选进度事件（横切）
```

| 层 | 使命 | 允许 | 禁止 |
|---|---|---|---|
| L2 | 用例编排与装配 | 调用 L1 用例；作为组合根注入 L0 实现 | 承载业务规则；反向被 L0 import |
| L1 | 业务规则与不变量 | 依赖 L1a 值类型、定义端口、调用端口 | import L0 具体类型；直接 I/O；依赖 L2 |
| L0 | 技术细节隔离 | 实现 L1 端口；使用 L1 契约类型；使用横切工具 | import L2；含业务判定；跨组件直连对方存储 |

`CMP-result` 是 L1a（值类型与策略），`CMP-executor` 是 L1b，只允许 `L1b → L1a`。

### 3.2 模块卡

#### CMP-cli（L2，整合，planned）

- **业务价值**：把操作者的运行意图变成一次 `serve` 循环或一次本地执行；没有它，client 无法被启动。
- **负责**：命令解析与配置校验；`serve` 循环（领取、心跳、租约续约、容量、实例生命周期、取消路由）；`run` 单次；组合根装配；信号与退出码。
- **不负责**：节点执行顺序（`CMP-executor`）、HTTP/ACP 细节、业务判定。
- **数据**：配置（启动时加载，只读）；无持久业务数据。
- **变化轴**：命令与部署形态、并发模型。
- **契约**：CLI 操作面（§2.2）；对 executor 只调用 `executeNode` 用例。
- **依赖**：`CMP-executor`（用例）、`CMP-result`（值类型）、L0 实现（**仅组合根**注入）、`CMP-observability`。
- **单独验证**：命令解析与退出码快照；假端口驱动的 serve 循环测试（领取/取消/停机）。
- **删除测试**：删掉后没有启动入口，复杂度集中到宿主脚本——真边界。
- **拆分触发条件**：循环出现独立并发模型、远程管理需求或第二进程形态时，抽出 `CMP-daemon`。

#### CMP-executor（L1b，领域，planned）

- **业务价值**：保证「一个节点怎么执行」的顺序与失败语义；没有它，顺序会散到 CLI 与 runtime 各写一半。
- **负责**：节点尝试状态机（`claimed → bound → ready → running → reported → closed`）；定义 5 个端口；attempt 级幂等去重；取消/超时分岔；触发结果组装与上报；**技能刷新幂等**——同一容器并发节点同集由调度器保证；client 按 digest 幂等安装，集合变化只在无活跃 session 时替换，不同集合并发视为违约并显式失败。
- **不负责**：协议、进程、文件、解压实现；编排决策（下一节点/评审/回退）。
- **数据**：尝试状态（内存，运行期；可从 journal 重建）。
- **变化轴**：执行流程语义（顺序、重试边界、取消语义）。
- **契约**：`executeNode(request, ctx) → NodeResult`；5 个端口（§6）。
- **依赖**：`CMP-result`（值类型与策略）；端口由自己定义、由 L0 实现；`CMP-observability`。
- **单独验证**：§4.2 十条不变量逐条契约测试；失败注入（刷新失败、超时、取消、上报失败、重复投递）。
- **删除测试**：删掉后「先刷技能再 prompt」「一节点一 session」两条不变量无处安放——真边界。

#### CMP-result（L1a，领域策略，planned）

- **业务价值**：结果语义单点：什么算成功、什么可重试、超长怎么截断。
- **负责**：从 `SessionOutcome` 组装 `NodeResult`；错误类别映射（本地失败 → 调度器可判定类别）；结果大小上限与截断；输出契约**透传**，不解释业务字段。
- **不负责**：事件解析（runtime）、传输与重试（gateway）、持久化（store）。
- **数据**：无持久化；仅 `NodeResult` 与错误类别值类型。
- **变化轴**：结果格式与错误分类（随 M1 契约）。
- **契约**：`assemble(outcome) → NodeResult`、`classify(error) → ErrorClass`（纯函数）。
- **依赖**：无（纯值对象，零 I/O）。
- **单独验证**：表驱动错误映射；截断边界（刚好等于/超过上限）。
- **删除测试**：删掉后错误分类会散进 executor 和 gateway，两个变化轴被合并——真边界。

#### CMP-gateway（L0，适配器，planned）

- **业务价值**：把调度器协议、鉴权、版本与传输重试封在边界内，领域层只看到端口。
- **负责**：`SchedulerPort` 实现；HTTP 长轮询（心跳兼作通知）、重连与退避；鉴权头；版本协商；传输层重试；幂等键；租约计时。
- **不负责**：业务判定（何时重试节点由调度器决定）、结果内容、进程/文件。
- **数据**：幂等键短期缓存（内存）；无业务数据。
- **变化轴**：调度器协议。
- **依赖**：`CMP-executor` 的端口与值类型（L0 → L1 端口，允许）、`CMP-observability`。
- **单独验证**：桩调度器契约测试（正常/超时/重复投递/鉴权失败/版本不兼容/迟到结果）。
- **删除测试**：删掉后 HTTP 细节会渗进 executor——真边界（防腐层）。

#### CMP-runtime（L0，适配器，planned）

- **业务价值**：把 DSH 进程与 ACP 协议关在本机；一个失败节点能干净收口。
- **负责**：DSH 定位与版本校验；实例进程（独立 `DSH_HOME`、环境注入、stderr 落日志）；按实例生成 `profiles/acp` 的**技能可见性补丁**（全局根置空、项目根保留，见 §4.5）；session `cwd` 固定为工作区根（不指向子仓库，保证 `.dsh/skills` 被发现）；`session/new | prompt | update | request_permission | cancel | close`；事件累积为 `SessionOutcome`；进程回收与孤儿识别（杀进程组/作业树，S0-11）。
- **不负责**：技能下载/刷新（assets）、结果语义（result）、重试策略。
- **数据**：进程、session、`DSH_HOME`（一实例一 home，待 OQ-009 定稿）。
- **变化轴**：DSH 版本与 ACP 协议。
- **依赖**：`RuntimePort` 类型、`CMP-observability`。
- **单独验证**：ACP 桩进程/回放（沿用预研探针序列）；取消与关闭后的进程/会话清理；崩溃注入。
- **删除测试**：删掉后 ACP 协议细节会渗进 executor——真边界（防腐层）。

#### CMP-workspace（L0，适配器，planned）

- **业务价值**：工作区是节点间与产物的事实源，必须单写且不越界；容器由外部预置，client 只负责校验、复用与清理。
- **负责**：接收给定容器路径（仓库目录已存在）；校验容器布局（`.git` 子目录、根不带 `.git`、位于任何仓库之外）；维护 `.dsh/skills` 安装点；路径约束（允许进入子仓库，禁止逃逸容器、拒绝跟随越界符号链接）；清理与保留策略。
- **不负责**：仓库克隆/检出（准备阶段完成）、技能内容（assets）、仓库内容语义、产物解析。
- **数据**：容器目录（预置仓库 + 运行时产物 + `.dsh/skills`；唯一写入口）。
- **变化轴**：容器布局校验与清理策略。
- **依赖**：`WorkspacePort` 类型、`CMP-observability`。
- **单独验证**：预置容器校验（有/无仓库、根位置）；路径穿越；清理幂等；跨实例容器互不干扰。
- **删除测试**：删掉后路径约束会散进 assets 与 runtime——真边界。

#### CMP-assets（L0，适配器，planned）

- **业务价值**：保证模型只看到当前节点的技能组合，且失败不留半套。
- **负责**：技能包获取（来源 + 校验和）、完整性校验、解压到暂存、原子替换到容器根 `.dsh/skills`（技能切换点）、按 digest 幂等（同一集合重复安装为空操作）、脚本赋权与路径提供、缓存与失效。
- **不负责**：选择技能（调度器）、执行脚本（模型）、判断脚本结果。
- **数据**：技能缓存与落地目录。
- **变化轴**：包格式、来源与校验方式。
- **依赖**：`AssetPort` 类型、`CMP-observability`；**不依赖 gateway**（下载自持，鉴权走注入配置）。
- **单独验证**：损坏包、半套回滚、替换可见性、脚本权限、缓存命中。
- **删除测试**：删掉后「替换不是叠加」会散进 executor——真边界。

#### CMP-store（L0，适配器，planned）

- **业务价值**：崩溃后能说清「上次做到哪」，但不成为第二真相。
- **负责**：journal 追加/读取/压缩；实例锁（单写）；孤儿进程记录（pid/home）；清理。
- **不负责**：恢复决策（executor/cli）、调度器状态。
- **数据**：journal、锁文件、pid 记录（唯一写入口）。
- **变化轴**：本地持久化格式。
- **依赖**：`JournalPort` 类型、`CMP-observability`。
- **单独验证**：崩溃点恢复矩阵、双跑锁竞争、损坏 journal 降级读取。
- **删除测试**：删掉后本地恢复事实无处存放——真边界。

#### CMP-observability（L0，横切工具，planned）

- **业务价值**：一个失败节点能从本地日志定位到阶段与原因。
- **负责**：结构化日志（关联键 instance/node/attempt/session）；`doctor` 检查项；可选进度事件；脱敏。
- **不负责**：跨边界上传全文；业务判定。
- **数据**：日志文件。
- **变化轴**：观测需求。
- **依赖**：无（标准库 + 启动配置注入）。
- **单独验证**：关键路径日志字段完整；密钥/路径脱敏用例。
- **删除测试**：删掉后失败节点无法定位——真边界（可观测性不是装饰）。

### 3.3 依赖矩阵

| 调用方 | 被调方 | 契约 | 方式 | 冷热 | 失败处理 |
|---|---|---|---|---|---|
| `CMP-cli` | `CMP-executor` | `executeNode` | 同步 | 冷 | 节点失败，按错误类别上报 |
| `CMP-cli` | `CMP-gateway` | 租约循环（心跳/领取/续约） | 同步 | **热** | 退避重试；心跳不可停 |
| `CMP-cli` | `CMP-store` | journal 恢复与锁 | 同步 | 冷 | 降级：跳过坏记录并告警 |
| `CMP-executor` | `CMP-result` | `assemble` / `classify` | 同步（纯函数） | 冷 | 不可失败 |
| `CMP-executor` | `SchedulerPort`（gateway） | `bindSession` / `reportResult` | 同步 | 冷 | 传输重试；失败则节点失败 |
| `CMP-executor` | `RuntimePort`（runtime） | `newSession` / `prompt` / `cancel` | 同步（长等） | 冷 | 关坏 session；节点失败 |
| `CMP-executor` | `WorkspacePort`（workspace） | `ensureContainer` / `cleanup` | 同步 | 冷 | 节点失败 |
| `CMP-executor` | `AssetPort`（assets） | `install` | 同步（下载/解压） | 冷 | 回滚；不 prompt；节点失败 |
| `CMP-executor` | `JournalPort`（store） | `append` / `mark` | 同步 | 冷 | 尽力写，失败告警 |
| 全部 | `CMP-observability` | `log` / `progress` | 同步 | 冷 | 吞掉日志失败，不影响主流程 |

**禁止边**：

- L1/L2 不得 import L0 具体类型（`CMP-cli` 作为组合根是唯一例外）。
- L0 不得 import `CMP-cli`；`CMP-runtime` 不得 import workspace/assets/gateway；`CMP-gateway` 不得 import runtime/workspace；`CMP-assets` 不得 import gateway（下载自持）。
- `CMP-result` 不得依赖任何适配器或端口。
- 组件间不共享可变状态，不互相读对方存储；跨组件数据只走端口。

**扇出检查**：`CMP-executor` = 6（result + 5 端口，不含 observability），是冷路径，未超 8；`CMP-cli` 作为组合根不计扇出。热路径（租约循环）同步依赖 = 1（gateway）。

## 4. 主流程与不变量

### 4.1 一次节点执行的时序

```
调度器                          client（cli）                 executor / L0
  │ claim ──────────────────────▶│
  │◀── NodeRequest（租约） ──────│
  │                              │ executeNode(attempt)
  │                              │──▶ workspace.ensureContainer
  │                              │──▶ runtime.ensureInstance（DSH_HOME + env）
  │                              │──▶ runtime.newSession(cwd) → sessionId
  │◀── bindSession(sessionId) ───│
  │── SkillSet ─────────────────▶│──▶ assets.install（原子替换）
  │                              │──▶ runtime.prompt(text)
  │                              │◀── 事件流（chunk / tool / usage / 权限）
  │                              │──▶ result.assemble → NodeResult
  │◀── reportResult ─────────────│
  │                              │──▶ runtime.closeSession；journal.mark
  │ 判定下一节点 / 结束           │
  │ 关闭实例 ───────────────────▶│──▶ runtime.shutdownInstance；workspace.cleanup
```

- 评审节点与 agent 节点走同一流程，client 不解释评审结论。
- session 的 `cwd` 固定为工作区**容器根**，不是某个子仓库：容器根是技能根，子仓库只是代码与文档的产物容器。
- fan-out 的并发分支共用同一容器与同一技能集：不复制容器，也不在分支间切换技能；分支只是同容器内的多个 session。
- 下一节点重新建 session、重新取技能；刷新只在无活跃 session 时执行（同一集合重复安装为空操作），不沿用上一节点状态。
- 实例结束时统一关闭 session、进程与工作区（保留策略可配）。

### 4.2 不变量

1. 一实例一 DSH 进程；一可执行节点一 DSH session；session 关闭后不复用。
2. session 创建后必须先 `bindSession` 取得技能集，再原子替换工作区技能，成功后才 `prompt`。
3. 技能刷新失败（下载/校验/解压/替换任一）→ 不 prompt，节点失败，工作区不留半套。
4. 模型在本次 prompt 只看到当前节点的技能组合；刷新是替换，不是叠加。
5. 跨边界只传控制信息；不上传产物、不传完整会话记录；本地日志不跨边界。
6. 同一 `attemptId` 至多执行一次；重复投递与重复上报都不重复执行、不覆盖。
7. 取消路径：`session/cancel` → 等 prompt 结算 → 超时则杀进程；两条路都必须回收。
8. 上报失败只重试传输，不改变业务语义；迟到结果只入审计。
9. 实例关闭/失败/取消后清理 session、进程与工作区（按策略保留）。
10. 凭据只在进程环境或本地安全存储；不进 prompt、日志、结果。
11. 技能可见性只有项目根：实例 profile 把 `skill-filesystem` 的全局根（user / bundled）置空，项目根保留；`includeDefaultRoots` 保持 `true`。
12. 容器根即技能根：session `cwd` 固定为工作区根；子仓库（各带 `.git`）只承载代码与文档，技能与工具不进子仓库。
13. 同一容器内的并发节点由调度器保证使用同一技能集；client 按 digest 幂等安装（同集为空操作），集合变化只在无活跃 session 时替换；并发下遇到不同集合视为调度器违约，显式失败。

### 4.3 失败映射

| 失败面 | 责任组件 | 行为 | 上报/结果 |
|---|---|---|---|
| 网络 / 租约 / 上报 | `CMP-gateway` | 传输层退避重试；租约过期丢弃该次尝试 | 可重试错误类别 |
| 技能获取 / 校验 / 替换 | `CMP-assets` → `CMP-executor` | 原子回滚，不 prompt | 节点失败（资产类） |
| 工作区校验 / 清理 | `CMP-workspace` | 失败即节点失败；不迁移其他 client | 节点失败（工作区类） |
| 并发下技能集不一致（调度器违约） | `CMP-executor` + `CMP-assets` | 拒绝该尝试；不交错覆盖 | 节点失败（`skill_set_conflict`），调度器可换实例/重排 |
| DSH 启动 / ACP 会话 | `CMP-runtime` | 关闭坏 session；必要时杀进程 | 节点失败（运行时类） |
| 执行超时 / 取消 | `CMP-executor` + `CMP-runtime` | 取消 → 立即关 session、杀进程组；超时 → 杀进程 | `cancelled` / `timeout` |
| client 崩溃 / 重启 | `CMP-cli` + `CMP-store` + `CMP-runtime` | 清理孤儿进程；重新注册领取；重跑当前节点 | 重跑，不依赖 session 恢复 |
| 重复投递 | `CMP-gateway` + `CMP-executor` | `attemptId` 去重，不重复执行 | 返回已有结果/确认 |
| 实例关闭 | `CMP-cli` → runtime / workspace | 取消活跃尝试；关进程；清理 | 记录关闭事实 |

恢复遵循上游 D11：**不依赖 session 恢复或历史回放，直接重跑目标节点**；暂停优先在节点边界生效。

### 4.4 冷热路径与资源隔离

| 路径 | 内容 | 同步依赖 | 失败语义 | 资源隔离 |
|---|---|---|---|---|
| **热**：租约循环 | 注册/心跳（长轮询兼通知）/领取/续约 | 1（gateway） | 退避重试；心跳不可停 | 独立定时器，不占用执行队列 |
| 冷：节点执行 | 准备环境 → prompt 长等 → 结果 | 5（端口） | fail fast + 分类上报；可重跑 | 每实例独立进程/工作区/`DSH_HOME` |
| 冷：技能下载/解压 | 获取、校验、解压、替换 | 0（assets 自持） | 重试或失败；不 prompt | 大包走 worker/流式，设大小上限 |
| 冷：journal/清理/doctor | 本地记录、清理、自检 | 0（store/workspace） | 尽力写、幂等清理 | 实例串行清理，不抢 fan-out 目录 |

- **心跳独立于执行**：`serve` 循环的定时器不能被一次分钟级的 `prompt` 等待阻塞；执行是异步等待，心跳是独立任务。
- **解压不阻塞事件循环**：大包同步解压会推迟心跳，S0 需实测并决定 worker/流式方案。
- **冷热不共享队列/锁**：fan-out 各分支共享容器，容器级技能刷新加锁；实例清理按实例串行。

### 4.5 技能可见性配置（实例 profile）

源码核对（2026-11-03，DSH checkout `packages/skill/skill-filesystem/src/index.ts`）：

- 项目根按 `cwd` 解析：从 `cwd` 向上找最近的 `.git`，找不到则用 `cwd` 本身；项目技能目录是 `<projectRoot>/.dsh/skills`（rank 100）与 `<projectRoot>/.agents/skills`（rank 200），重名时 rank 小者胜。
- 工作区是**多仓库容器**：容器根不建 `.git`，子仓库各带 `.git`；容器根必须位于任何仓库之外，否则 `projectRoot` 会上浮到外层仓库，`.dsh/skills` 不可见。`doctor` 校验 `findProjectRoot(容器根) === 容器根`。
- 全局根是 `<dshHome>/skills` 与 `<agentsHome>/skills`；打包根取 `bundledSkillDir`，未配置时回退环境变量 `DSH_BUNDLED_SKILL_DIR`（`src/index.ts:174-176`）。
- 补丁对该行是**整份替换 config**，不与 bundle 默认配置合并；未写的字段回落 schema 默认值（`packages/boot/app-boot/src/config-schema/document.ts:29`）。base bundle 本来没有 `skill-filesystem` 配置，替换无损失。

因此实例 profile 的 `cordis.patch.yml` 保持默认根开启，只把三个全局根指到空目录：

```yaml
- id: skill-filesystem
  config:
    dshHome: <instance-home>/empty/dsh
    agentsHome: <instance-home>/empty/agents
    bundledSkillDir: <instance-home>/empty/bundled
```

- 三个空目录建议真实创建：根不存在时 watcher 会退化为对祖先路径的轮询（`src/index.ts:643-668`）；创建后锚定在空目录上，开销可忽略。
- **不要**用 `DSH_HOME` 环境变量关技能：它同时被 settings、credentials 等插件用于解析路径；只覆盖 `skill-filesystem` 这一行即可。
- **与 S0-05 的关系**：S0 探针用 `includeDefaultRoots: false + customSkillDirs` 做过严格隔离（只剩指定根）。本方案按「只屏蔽全局、项目 `.dsh`/`.agents` 都可用」的要求保留标准项目根发现；若改用严格隔离，项目根会失去 `cwd → .git` 的自动解析，需要显式列出目录，与本要求不一致。两者都只是配置层改动，不涉及代码。
- **可见范围**：本方案下工作区项目自带的 `.dsh`/`.agents` 技能也会进入 catalog。若某类工作区要求「只看到节点组合」，改用 S0-05 的严格隔离变体（`includeDefaultRoots: false + customSkillDirs`），按工作区类型取舍。
- **S0 断言需放宽**：本方案下项目 `.agents/skills` 也会可见（S0-05 只断言 `proj-dsh`）；重跑 S0 时按「项目根可见、全局根不可见」调整。

### 4.6 工作区布局（多仓库容器）

```
<workspace>/                    ← 容器根：技能根、session cwd；不在任何 git 仓库内
├── .dsh/skills/                ← 当前节点的技能集（替换式刷新；脚本随包）
├── repo-a/    (.git)           ← 代码与文档的产物容器（准备阶段已就位）
└── repo-b/    (.git)
```

- 容器与仓库由**准备阶段预置**：仓库目录已在给定路径下，client 不 clone、不检出、不建仓库；只校验布局、安装技能、清理自己产生的内容。
- 容器根**不建 `.git`**：根靠 `cwd` 回退成为项目根，子仓库各自带 `.git`；给根建 `.git` 会把子仓库变成嵌套仓库。
- 容器根必须位于任何仓库之外，否则 `projectRoot` 上浮、`.dsh/skills` 不可见；`doctor` 校验 `findProjectRoot(容器根) === 容器根`。
- `cwd` 固定为容器根；子仓库只承载代码与文档，不承载技能与工具。
- 项目自带的 `.agents/skills` 仍可见（§4.5）；与节点技能集同名时 `.dsh` 优先（rank 100 < 200）。
- 节点作用域是整个容器：`NodeRequest` 带容器路径（编排层参数），仓库清单由目录本身表达；节点可跨仓库，client 只校验、清理，不做代码语义判断。
- fan-out 的并发分支**共用同一容器与同一技能集**（例如从一个项目的多个调用入口做调用链分析）；不复制工作区，不在分支间切换技能。需要独立工作区时在流程层另行编排，不在 client 侧产生。

### 4.7 控制事件：编排 → client

没有推送通道。编排的「通知」统一搭在 client 的出站长轮询上（上游边界：控制信息随心跳/租约通道下发），client 永不监听端口。

**事件闭集**（M1 字段化）：

| 事件 | 语义 | client 动作 |
|---|---|---|
| `cancel(instanceId, reason)` | 取消实例（含整个 fan-out） | 实例转 `cancelling`；所有活跃 session cancel/close → 杀进程组；各尝试上报 `cancelled`（不等待跑完） |
| `pause(instanceId)` | 暂停实例 | 停止领取；活跃尝试按 `cancel(paused)`；恢复后重跑当前节点 |
| `resume(instanceId)` | 恢复 | 允许领取；从当前节点重跑 |
| `shutdown(instanceId?)` | 关闭实例/client | 停止领取、取消活跃尝试、关 session/进程/工作区、退出循环 |

配置变更、容量调整不进运行期事件，重启生效。其他编排状态（下一节点、评审结论）client 不需要知道，它们通过下一次 `claim` / `bindSession` 的返回值体现。

**流转**：

1. 调度器把事件写入目标 client 的控制队列，按 client 单调 `seq` 持久化（目标由 instance → client 的粘性绑定决定）。
2. client 的心跳是长轮询：`heartbeat(state, ackSeq) → ControlBatch`。队列有事件时立即返回；无事件时挂起到 `heartbeatInterval` 返回空批；请求到达即续租，连接断开/超时即离线信号（最终以租约过期裁决）。执行期间的心跳由独立定时器驱动，不被 prompt 阻塞。
3. `CMP-gateway` 校验 `seq` 与事件类型，交给 `CMP-cli` 分派；`CMP-executor` 按 attempt 执行：
   - `cancel`：实例转 `cancelling` → 对每个活跃 session `runtime.cancel` → 关闭 session、杀进程组（S0-11）→ 各 attempt 上报 `cancelled`；不等 prompt 自然结算（同 attempt 幂等；已上报的只 ack）。
   - `pause` / `shutdown`：先停领取，再取消活跃尝试，最后按关闭语义收口。
4. 下一次心跳带 `ackSeq`（累计确认）；调度器清队列。响应丢失导致重发时，client 按 `seq` 幂等，已结算的事件回 `stale` 并 ack，只入审计。
5. 断连/离线：事件留在队列；client 重连注册后按 `seq` 补发；租约已过期的尝试由调度器裁决，client 不自行恢复 session。

**语义**：

- 至少一次 + 幂等应用；同一 client 内按 `seq` 顺序。
- cancel 立即执行、不等跑完；以实例为单位，带走在跑的整个 fan-out；prompt 若已先结算，按实际结果上报；已上报的只 ack。
- 控制事件只走心跳通道，`claim` 只返回节点请求——避免两个长轮询同时携带事件造成乱序与重复。
- 未知事件类型：ack + 记录，不崩溃；新增类型走版本协商。
- 取消延迟 ≈ 一次网络往返（事件到达即唤醒长轮询）；心跳间隔 30s 只决定离线判定粒度，不是取消延迟。

**不在此列**：DSH 权限请求的人工审批。当前由 client 本地策略裁决；若编排要参与审批，需要新增「client → 调度器等响应」的同步交互面，属于契约新增，不是控制事件。

**通道形态（已定，2026-11-03）**：**心跳长轮询兼作通知**——一条常驻请求，响应既回控制事件也续租；不新增独立通知端点。

- 每次请求到达即续租；连接断开（FIN/RST）或超时未续即离线信号；**最终以租约过期裁决**，不把 TCP 断开当成唯一事实（代理/NAT 空闲断连、半开连接都会误判）。
- 心跳间隔 30s（2026-11-03 定），必须小于中间设备的空闲超时；长轮询挂起上限同 30s；租约 TTL 大于它（具体值 M1 定）；client 断开后按退避重连，重连即重新注册并补发 `ackSeq`。
- 执行期间心跳由独立定时器驱动，prompt 再长也不占用这条通道。
- 被否决：独立 `GET /notifications`（多一条常驻请求与一套游标，控制事件低频时不值得）；WebSocket/SSE（与 client 纯出站边界冲突）。

**待 M1**：租约 TTL（>30s）；事件批大小暂不设限，按实际事件量再定。

## 5. 数据与状态所有权

| 数据/状态 | 唯一写入口 | 读方 | 一致性 / 保留 |
|---|---|---|---|
| 工作区容器与产物（根 + 子仓库工作树 + `.dsh/skills`） | `CMP-workspace` | runtime（cwd）、assets（安装目标）、executor（路径）、observability（日志路径） | 本地强一致；按策略保留/清理 |
| 技能缓存与落地 | `CMP-assets` | executor、runtime | 原子替换；缓存可失效 |
| DSH 进程 / session / `DSH_HOME` | `CMP-runtime` | executor、observability | 进程退出即回收 |
| journal / 实例锁 / 孤儿记录 | `CMP-store` | cli、executor | 追加写；崩溃可重建 |
| 尝试状态（内存） | `CMP-executor` | cli | 仅运行期；可从 journal 重建 |
| 配置 | `CMP-cli`（加载后只读） | 全部（注入） | 启动校验；运行期不变 |
| 日志 | `CMP-observability` | 排障 | 本地；脱敏；轮转 |
| 结果本地副本 | `CMP-store`（journal 记录） | 排障 | 与上报内容一致；不含产物 |

规则：每份数据只有一个写入口；client 本地记录只用于恢复，不是第二真相；session 绑定语义以调度器为准；不读调度器数据库、不共享存储。

## 6. 契约草案（概念级）

> 字段、序列化与错误码目录留 M1；本节只定方法、不变量与错误类别，供 M1 字段化。

### 6.1 `SchedulerPort`（调度器契约的 client 侧）

- **签名**：`register(info)`、`heartbeat(state, ackSeq) → ControlBatch`、`claim(capacity) → NodeRequest | null`、`renew(attemptId) → Lease`、`bindSession(attemptId, sessionId) → SkillSet`、`reportResult(attemptId, result) → Ack`。
- **不变量**：`claim` 只返回绑定本 client 实例的请求；`bindSession` 只接受本 client 为本 attempt 创建且未关闭的 session；`reportResult` 同 attempt 幂等；版本不兼容拒绝领取；`NodeRequest` 带 workspace 路径（编排层参数）与技能集引用；同一容器的并发节点由调度器保证同一技能集；心跳是长轮询——请求到达即续租，断开/超时是离线信号，租约过期裁决。
- **错误模式**：`unreachable/timeout`（重试）、`unauthorized`（停止领取）、`version_incompatible`（停止）、`lease_expired`（丢弃尝试）、`rate_limited`（退避）、`invalid_request`（记录并放弃，不重试）。
- **幂等/顺序**：至少一次；`attemptId` 为幂等键；租约决定执行权，迟到结果不推进流程。

### 6.2 `RuntimePort`

- **签名**：`ensureInstance(instance, env)`、`newSession(instance, cwd) → SessionRef`、`prompt(session, text, onEvent) → SessionOutcome`、`cancel(session)`、`closeSession(session)`、`shutdownInstance(instance, mode)`。
- **不变量**：一实例一进程；一 session 同时最多一个进行中的 prompt；关闭后不复用；事件累积到 `SessionOutcome`（最终消息、停止原因、用量、错误）。
- **错误模式**：`spawn_failed`、`protocol_error`、`prompt_failed`（JSON-RPC）、`cancelled`、`timeout`、`process_exited`。
- **超时/取消**：取消 = 立即终止：`session/cancel` 后随即关 session、杀进程组；不等 prompt 自然结算，结算按 `cancelled`（prompt 已先结算则如实上报）。超时同理。
- **取消粒度**：以实例（含整个 fan-out）为单位——取消即整体收口，不做单分支取消（2026-11-03 定）。

### 6.3 `WorkspacePort`

- **签名**：`ensureContainer(instance, path) → ContainerPaths`、`validate(container) → LayoutReport`、`cleanup(instance, policy)`、`resolve(instance, relPath) → absPath`。
- **不变量**：容器预置、仓库已存在（client 不 clone/检出）；容器根即技能根，session `cwd` 指向容器根；fan-out 分支共享同一容器；所有读写限制在容器内；清理幂等，默认只清 client 生成的技能与临时产物，不删预置仓库。
- **错误模式**：`permission_denied`、`disk_full`、`path_escape`、`not_prepared`、`layout_invalid`。

### 6.4 `AssetPort`

- **签名**：`install(skillSet, workspace) → InstalledSkills`、`verify(package) → ChecksumResult`、`listInstalled(workspace) → InstalledSkills`。
- **不变量**：替换语义、原子生效；失败不留半套；脚本落地即赋可执行位；只暴露当前节点组合。
- **错误模式**：`download_failed`、`checksum_mismatch`、`unpack_failed`、`io_error`。

### 6.5 `JournalPort`

- **签名**：`append(record)`、`pending(instanceId) → AttemptRecord[]`、`mark(attemptId, state)`、`lockInstance(instanceId)` / `unlock(instanceId)`。
- **不变量**：追加不覆盖；同实例单写（锁）；尝试状态可重建；损坏记录可降级跳过并告警。
- **错误模式**：`io_error`、`locked`。

### 6.6 CLI 契约

见 §2.2。补充：`serve` 重启幂等（同一 client 重复注册不产生双份执行）；`run` 与 `serve` 共用同一执行内核，避免调试路径与生产路径分叉。

## 7. 关键决策

| ID | 决策 | 理由 | 被否决的方案 |
|---|---|---|---|
| D1 | 不提供本地 HTTP / IPC 服务 | 沿用上游出站租约模型；服务端化会引入端口、鉴权、推送与 NAT 问题，属两侧边界变更 | 让调度器推送任务到 client 本地服务：与粘性/出站契约冲突，且需要改上游边界 |
| D2 | 9 组件，`CMP-result` 独立 | 结果语义与错误分类是独立变化轴；用户 2026-11-03 确认 | 并入 executor：流程与结果格式两个变化轴混在一起；并入 runtime：适配器会懂业务结果语义 |
| D3 | `serve` 循环暂放 `CMP-cli`，不独立 `CMP-daemon` | 现在只有单进程单循环，拆 daemon 是为不存在的部署形态预付复杂度；拆分触发条件已写明 | 立即拆 daemon：多一个组件与一层装配，收益为零 |
| D4 | 端口定义在 `CMP-executor`（L1b），L0 实现 | 依赖倒置；L0 只依赖 L1 契约，便于替换与测试 | 端口放共享 kernel：多一个组件，且用户已确认 9 组件 |
| D5 | 结果三段：runtime 提取 / result 语义 / gateway 传输 | 每个组件只封一个易变决策，避免「结果」成为万能入口 | 单一 `CMP-result` 包办提取+语义+传输：三处变化挤在一个组件 |
| D6 | 冻结「先建 session、再取技能、再刷新、再 prompt」 | 技能读取时机已验证，备选顺序不再需要 | 先取技能再建 session（原备选路径）：无证据支持，且会让 session 创建与技能集脱钩 |
| D7 | 工作区单写 + 路径约束（拒绝越界/符号链接逃逸） | 远程 prompt 与脚本具有执行影响力，路径是安全基线 | 允许脚本/模型任意路径：放大信任面，违背 CW-08 |
| D8 | 节点作用域是整个容器，可跨仓库 | 实际任务常跨多个仓库，更多时候只有一个；`NodeRequest` 带容器路径（编排层参数），仓库清单由目录本身表达 | 把节点绑死单仓库：跨仓库任务要另造机制 |
| D9 | fan-out 分支共享同一容器与同一技能集，不做工作区复制 | 用户 2026-11-03：并发分支同容器（调用链分析类）；复制无收益且放大技能刷新竞态 | 每分支独立容器/worktree：要复制、要清理，且技能切换更复杂 |
| D10 | 专家由调度器装配，client 只落技能集 | 上游边界已定：persona 进 prompt，工具随技能包；client 不读取专家结构 | 技能包携带专家定义：client 要理解专家结构，越界 |
| D11 | workspace 由准备阶段预置（仓库已在目录中），client 只校验与清理 | 准备动作在 client 之外；client 不承担 clone 的凭据/网络/失败语义 | client 克隆仓库：把准备阶段的问题引进执行面 |
| D12 | 取消以实例（含整个 fan-out）为单位，立即终止 | 用户 2026-11-03：fan-out 要取消就是整体取消；一处收口、无孤儿 | 单分支取消：要会话级进程回收，当前不需要 |

## 8. 验证计划

| 组件 | 契约测试 | 不变量/规则 | 失败注入 | 冷热/隔离 |
|---|---|---|---|---|
| `CMP-cli` | 命令解析、退出码、SIGINT 停稳 | serve 循环不重复执行 | 调度器不可达 | 心跳与执行并行 |
| `CMP-executor` | §4.2 十条逐条 | 顺序固定、attempt 去重 | 刷新失败/超时/取消/上报失败 | 双 attempt 并发 |
| `CMP-result` | 错误映射表、截断 | 只传控制信息 | 超大结果 | — |
| `CMP-gateway` | 桩调度器全错误面 | 幂等、租约 | 超时/重复/迟到 | — |
| `CMP-runtime` | ACP 桩（回放预研序列） | 一节点一 session | 进程崩溃、取消 | 多实例并行 |
| `CMP-workspace` | 预置容器校验/清理 | 路径不越界 | 磁盘满、权限拒绝 | 并发分支共享容器 |
| `CMP-assets` | 包校验、原子替换 | 不留半套 | 损坏包、中断 | 大包解压不阻塞 |
| `CMP-store` | journal 读写、锁 | 回放可重建 | 损坏、双跑 | — |
| `CMP-observability` | 关联键、脱敏 | 不传全文 | 日志写满 | — |

**S0 用例（不接调度器，用 `run` + 假请求）**：

1. prompt 时读到刷新后的技能（已验证，保留为回归）；
2. 顺序两节点，第二个 session 只看到自己的组合；
3. 刷新失败不留半套，且不 prompt；
4. 技能包内脚本按提供路径可被模型调用；
5. 取消/关闭后无残留进程与 session；
6. 并发分支共享容器与技能集，互不覆盖；不同技能集并发 → 显式失败；
7. 崩溃重启后清理孤儿并重跑当前节点（桩调度器）；
8. 多仓库容器：容器根为 cwd 时 `.dsh/skills` 可见、子仓库技能不参与；容器根被外层仓库包裹时技能不可见（负例）；
9. 桩调度器长轮询：挂起期间续租；断开后停止领取、租约过期重领；重连补发控制事件；
10. cancel 立即终止：fan-out 进行中取消 → 整个实例进程组退出、无孤儿；各尝试 `cancelled`。

**CI 门禁**：`bun test`、`bun run typecheck`、import 边界检查（禁止边脚本化）、契约测试；S0 起加进程残留冒烟。

## 9. 开放问题与风险

### 9.1 需 M1 决定（接口设计工序）

| 问题 | 影响 |
|---|---|
| `NodeRequest` / `NodeResult` / `SkillSet` 字段与结果大小上限（OQ-006） | 契约、`CMP-result` 截断 |
| 技能集下发形态：包 URL + 校验和，还是技能清单 + 下载端点 | `CMP-assets` 与 `CMP-gateway` 的边界 |
| 容量单位：实例数还是 session 数 | `CMP-cli` 循环与心跳 |
| 鉴权方式（OQ-004） | `CMP-gateway` 与配置 |
| 版本兼容窗口（OQ-008） | 版本协商 |
| 租约 TTL（> 心跳 30s） | 调度器契约、租约判定 |

### 9.2 S0 覆盖与剩余验证

已由 S0 覆盖（2026-11-03）：技能根与格式（S0-02）、会话后写技能（S0-03）、每节点替换（S0-04）、技能根隔离的严格变体（S0-05）、同进程多会话并发（S0-09）、项目根解析（S0-10）。

仍待验证：

- `DSH_HOME` 隔离粒度（OQ-009）：一实例一 home 还是 client 一 home；崩溃后的 lock 残留与 `session/list` 残留会话会放大隔离成本；
- 大包解压是否阻塞事件循环（决定 worker/流式）；
- 本方案「置空全局根」（§4.5）的变体复验：项目 `.dsh`/`.agents` 可见、全局根不可见（S0-05 用的是严格隔离变体）；
- 崩溃清理：S0-11 失败，杀进程组/作业树的实现方式待 S0/S1 定（见风险表）。

### 9.3 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 心跳被长任务阻塞 | 租约过期、误判离线 | 心跳独立定时器；S0 压测 |
| 长轮询被代理/NAT 空闲断开 | 误判离线、控制事件延迟 | 心跳间隔小于空闲超时；自动重连 + 退避；租约过期兜底 |
| 解压/校验阻塞事件循环 | 心跳延迟 | 大小上限；worker/流式方案 |
| 磁盘增长（工作区/日志/sessions） | 占满磁盘 | 保留策略 + `doctor` 检查 |
| 远程 prompt/脚本信任面 | 调度器可影响本机执行 | 权限默认拒绝、审计、白名单、路径约束 |
| 契约漂移 | 两侧字段/语义不一致 | M1 冻结、共用样例、版本协商 |
| 工作区容器根位于外层 git 仓库下 | `projectRoot` 上浮，`.dsh/skills` 不可见，模型看不到节点技能 | 容器根放 client 自有目录（不在任何仓库内）；`doctor` 校验 `findProjectRoot(容器根) === 容器根`；不推荐给容器根建 `.git`（会把子仓库变成嵌套仓库） |
| 同容器并发技能刷新竞态 | 分支看到错误技能组合 | 调度器保证并发同集；client digest 幂等，违约显式失败 |
| 同容器并发写同一仓库 | 产物覆盖/冲突 | 流程层避免并发写；client 不做仓库锁（分析类读多写少） |
| 崩溃遗留工具子进程 | 孤儿 bash 存活、占资源、可能继续写工作区 | 杀进程组/作业树或 supervisor（S0-11 实测 ACP close 不回收工具子进程） |

## 10. 分级与确认记录

- **级别：P1**。触发项：模块切分/合并、公共端口契约、数据所有权、分层依赖。
- **第一轮人工确认（2026-11-03）**：接口范围 = 调度器契约面 + CLI 操作面；切分 = 9 组件（`CMP-result` 独立）；落点 = works 概念稿，评审后迁入 `design/architecture.md`。
- **第二轮（待）**：本稿整体确认。确认前不写实现代码；确认后 T-03/T-04 动工。
- **第二轮补充确认（2026-11-03）**：节点作用域 = 容器、可跨仓库（D8）；fan-out 分支共享同一容器与技能集（D9）；workspace 预置（D11）；容器路径由 `NodeRequest` 下发（编排层参数）；并发节点同技能集由调度器保证；通知通道 = 心跳长轮询兼作（事件随响应内联，不新增独立端点、不做 WebSocket/SSE）；心跳间隔 30s；取消以实例（整个 fan-out）为单位、立即终止（D12）；事件批大小暂不设限；专家由调度器装配、client 只落技能集（D10）。
- **结论落点**：见 brief 的结论落点与 §11。

## 11. 结论落点

| 结论 | 落点 |
|---|---|
| 接口面、不变量、失败语义 | 本稿；冻结后迁入 `design/architecture.md` |
| 9 组件与依赖矩阵 | 本稿；冻结后迁入 `design/architecture.md` 组件表 |
| 端口契约草案 | 本稿；M1 字段化后写入 `design/components/<id>/spec.md` |
| 决策 D1–D10 | 评审通过后落 `history/decisions/2026-11-03-client-concept.md` |
| fan-out 与 workspace 语义变更 | 回写上游 `boundary-design.md`：fan-out 分支共享容器，取消「独立工作区 + clone/worktree」表述；同步 `client-work.md` CW-03（工作区预置、client 不 clone） |
| S0 用例 | 本稿；S0 工序 brief 引用 |
| OQ-001 关闭 | `docs/plan/open-questions.md`（已更新） |
