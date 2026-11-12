---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 契约 v3 交接评审（client 侧）

> 评审对象：`docs/works/2026-11-12-contract-v3-handoff/`（`brief.md`、`contract-diff.md`、`executor-http-v3.md`）。
> 评审方法：交接副本与调度器侧权威做逐字比对；v2/v3 正文与 §11 变更表逐条对照；对照 client 现有实现（`src/`、`tests/support/`）判断可落地性；`tar.gz` 幂等性做本机实测。
> 结论：**有条件通过**。条件分两类：契约侧阻塞项（`B-*`）须由调度器侧修订契约；client 设计侧阻塞项（`B-05` 任务拆分）与 `D-*` 须在 client 影响规格中定。文档同步（`T-CV3-01`）可立即开工，行为实现（`T-CV3-02`–`T-CV3-05`）等阻塞项关闭后开工。
> 定级：**P1**（协议版本、公共契约、新增端点和持久化产物，跨 5 个组件），按 P1 走人工确认门。
> 2026-11-12 澄清：`D-01`–`D-10` 与 `B-01`–`B-04` 已闭环（§8）。
> 2026-11-12 第二轮：调度器侧已按评审修订契约（`response.md`），修订版**接受**（§10）；待补 `N-01`（副本 1 行漂移）与 `N-02`（brief 验收口径）；`B-05`/`B-06` 转 client 影响规格。

## 1 总览

| 档位 | 数量 | 处置 |
|---|---:|---|
| Blocker（`B-01`–`B-06`） | 6 | 清零前不冻结、不实现 |
| Decision now（`D-01`–`D-09`） | 9 | 定下并落契约或 client 规格 |
| Hold（`H-01`–`H-06`） | 6 | 记录，不阻塞文档同步 |
| Verified sound（`V-01`–`V-06`） | 6 | 不改 |

## 2 已核实无问题（Verified sound）

| ID | 结论 | 证据 |
|---|---|---|
| `V-01` | 交接副本与调度器侧权威**逐字一致** | `cmp -s` 两份 `executor-http-v3.md` 无差异；`docs/works/.../executor-http-v3.md` 与 `agent-flow-orchaster/docs/design/contracts/executor-http-v3.md` |
| `V-02` | `P-04`/`P-05` 与既有三端点无重叠，结果体仍只带控制信息 | `executor-http-v3.md:264`、`C-08`（`:472`）；与 `src/components/result/result.ts:23` 的分类/截断不冲突 |
| `V-03` | 协议 3 的失败语义与 client 现有 terminal 处理一致 | `unsupported_protocol`/`unauthorized` 已是 `terminal`（`src/components/gateway/errors.ts:29`）；只需改常量（`transport.ts:17` 现为 `"2"`）并补 409/413 映射 |
| `V-04` | 归档电平复用了 `stop`/`cancelInstances` 的既有模式 | `S-07`（`:456`）、`P-01` 请求/响应字段（`:146`/`:177`）；client 的 poll 循环已有 `nextPollAfterMs` 与 10ms 下限（`serve-context.ts:4`） |
| `V-05` | 版本演进与编号自洽 | `S-05` 加 `taskSpacePath`（`:454`）、`C-10`–`C-12`（`:474`–`:476`）与 §11.1 一致；§13 的"加法不升版、删改必升版"与本次升 3 相符 |
| `V-06` | 归档/日志打包可用系统工具，取向与 `P-03` 一致 | 本机 `/usr/bin/tar`、`/usr/bin/gzip` 可用；与 `P-03` 依赖系统 `unzip` 的既有选择一致（Windows 仍是 S3 已知限制） |

## 3 Blocker

### B-01 「日志先于结果」与「日志超限 413」互斥，失败任务永远结算不了

- 契约要求 `P-02` 到达时该 `taskId` 当前 `attempt` 必须有已上传日志（`executor-http-v3.md:50`、`:205`）。
- 同时规定日志压缩后超 `maxSessionLogBytes` 时服务端 `413` 不落盘，并要求 client「按 `failed` 上报并附明确错误码」（`:316`、失败矩阵 `:491`）。
- 两条叠加：日志被 413 拒绝 → 没有日志 → `failed` 结果被 `409 session_log_missing` 拒绝 → 任务既不结算也不重派，client 只能无限重试。
- 建议：契约二选一并写死——(a) 允许「日志上传被 413 且结果 `error.code=session_log_too_large`」的结果免日志接受；或 (b) 明确 client 必须把日志截断到 `maxSessionLogBytes` 以内（契约给出截断标记与保底内容），413 只作为客户端缺陷的兜底。

### B-02 无 ACP 事件的失败（workspace/asset/spawn/prompt 超限/取消未建 session）没有日志可传

- 契约要求 `prompt` 超限时 client「以 `failed(scheduler)` 上报」（`:193`），`C-07` 要求取消任务上报 `cancelled`（`:471`），但 `P-02` 前置仍要求日志（`:205`）。
- 这些路径在 client 里发生在建 session 之前，**不会产生任何 ACP 事件**：`prompt` 超限在 `serve-loops.ts:77` 直接组装结果；workspace 校验、技能安装、`spawn_failed` 都在 `executor.ts:126`–`:151` 的 session 建立之前失败。
- 结果：这类最常见的早失败全部撞 `409`，与 `B-01` 是同一处缺口的两个入口。
- 建议：契约明确「每个 `attempt` 都必须有一份日志，允许 0 行（空 gzip ndjson）」，并规定早失败在上报前补传空日志；或给出免日志的 `error.class` 白名单。

### B-03 日志/归档的幂等键依赖字节稳定，但契约未要求客户端持久化上传产物

- 契约以 sha256 判幂等：`P-04` 同键异 sha `409 content_conflict`（`:315`），`P-05` 同 run 异 sha `409`（`:345`）；`§10.2` 又要求「日志与结果之间 kill -9，重启后补传日志再补报」（`:527`）。
- 重启后要拿到同一个 sha，客户端必须**保留首次上传的压缩字节**；重新压缩（gzip 带 mtime）或重新打包必然换 sha。本机实测：同一目录两次 `tar czf` 的 sha256 不同（`ddf20fa6…` vs `57b110e6…`），`tar cf - | gzip -n` 才稳定复现。
- 交接件没有把"上传产物留盘"列为任务（`contract-diff.md:128` 把 `CMP-store` 标为「可选」），实现方很容易做成"每次重打包/重压缩" → 重启后永久 409。
- 建议：契约补一条客户端义务——日志/归档的**压缩产物**在得到确认前必须持久化并原样重传；或规定确定性打包（固定 gzip 头、固定条目顺序、`gzip -n`）。二选一即可，但不能两边都不写。

### B-04 归档指令的「立即返回」与 poll 判活互锁

- 契约说「有归档指令时服务端立即返回（`nextPollAfterMs=0`），client 处理完归档后再拉任务」（`:188`），`S-07` 又规定 `archiveRequests` 是持续下发的电平信号（`:456`）。
- 若 client 按字面"处理完再拉"：512 MiB 归档打包可能超过 `clientSilentMs=120000`（`:101`），调度器按 `S-02` 判静默并重派在跑任务（`:451`），产生重复执行。
- 若 client 保持 poll：服务端每个 poll 都因归档指令立即返回，client 以 10ms 下限空转（`serve-context.ts:4`），在归档未确认的几分钟里形成高频请求。
- 建议：契约明确两点——(a) 归档是冷路径，client 必须在后台打包上传，poll 不阻塞；(b) 服务端在 `archivedRuns` 未确认期间仍按 `pollHoldMs` 正常挂起，只在状态变化（新归档指令/确认）时立即返回。

### B-05 任务表缺三个必要落点，且两个任务跨组件

- **`CMP-runtime` 缺位**：`P-04` 要「ACP 事件流」，但 runtime 目前只产出派生事件（`kind: text/tool/usage`，`runtime-state.ts:79`–`:96`），原始 `method+params` 在 `applyNotification` 里被丢弃；`onEvent` 也未接进 executor 的 prompt（`executor.ts:172`–`:179`）。这是新的组件能力（事件出口），任务表里没有。
- **`CMP-result` 缺位**：日志/归档失败的分类要落 `result.ts:23` 的码表，任务表未列。
- **测试桩缺位**：`tests/support/stub-scheduler.ts` 只有 poll/result/skill-packages（`:92`），v3 门禁（409/413/归档）无法自测；`T-CV3-05` 未包含升级桩。
- **跨组件**：`T-CV3-03` 同时动 `CMP-executor` + `CMP-workspace`，`T-CV3-04` 同时动 `CMP-cli` + `CMP-store`，违反「一次任务只动一个组件」。
- 建议见 §6；在任务表修订前，`T-CV3-02`–`T-CV3-05` 不算可开工。

### B-06 task-space 打破 `CMP-workspace` 的「工作区单写」不变量，数据所有权未更新

- 现状不变量：client 只写 `.dsh` 下自己生成的内容（`docs/design/components/CMP-workspace/spec.md:120`，数据所有权表 `:158`）。
- v3 `C-10` 要求 client 在 `<workspacePath>/.agent-flow/task/<runId>` 建目录、写 `intent.md`（`:474`），这是 `.dsh` 之外的新写入面；`contract-diff.md:129` 却把 workspace 标为「可选：提供创建/打包工具」。
- 同时 `C-12` 要求本地 task 目录保留（`:476`），而既有清理策略只覆盖 `.dsh`（`workspace.ts:30`），`clean-client` 的语义没覆盖 `.agent-flow/task`。
- 建议：把 workspace 的写面、数据所有权、清理策略变更列为独立任务与 P1 决策；契约侧确认 task-space 只由 client 创建（DSH/模型写入属于内容而非结构）。

## 4 Decision now

| ID | 待定行为 | 证据 | 建议 |
|---|---|---|---|
| `D-01` | `409 content_conflict` 的客户端终结动作 | `:315`、`:345`、`:498` | 日志冲突＝已有日志，直接重报结果；归档冲突＝已归档，记入 `archivedRuns` 并停止重试。两种都必须有终止条件，否则死循环 |
| `D-02` | `archivedRuns` 的上界与淘汰规则 | `:155`、`:186` | 定"确认后保留 N 个 poll 或 T 秒"；重启后按 `archiveRequests` 重来，配合 `D-01` 的"冲突即已归档"兜底 |
| `D-03` | `ArchiveRequest` 不含 `workspacePath`，client 无法做 brief 要求的"位于 workspacePath 之下"校验 | 类型 `:384`–`:388` vs `brief.md:103` | 补字段，或明确 tar 目标只信任 `taskSpacePath` 并做根内归一化校验；同时定"重启后实例→工作区映射"来源（store） |
| `D-04` | task-space 路径的客户端校验义务 | `:51`（"client 不参与解释"）vs `:195`（client 创建）vs `brief.md:103` | 契约把"绝对路径、位于 `workspacePath` 下、拒绝越界符号链接"写成 `C-10` 义务；"不参与解释"改成"不拼接、不推断" |
| `D-05` | 日志事件形状、最小集合与脱敏 | `:294`、`:472`；`contract-diff.md:58`（"client 自己决定事件范围"） | 定最小事件信封（时间、方法、参数）与允许裁剪的范围；原始 ACP 事件可能含凭据/工具输出，外发前必须有脱敏规则（常驻安全边界） |
| `D-06` | 日志/归档失败的结果错误码未定义 | `:316`、`:346` | 调度器给出码表（如 `session_log_too_large`、`archive_failed`），否则 client 只能自创，分类与重试策略无法对齐 |
| `D-07` | v2 遗留的本地 `settled` 结果升级后无日志，首次补报必 409 | `:205`；client 启动会把 `settled` 放回待报（`serve.ts:39`–`:42`） | 定迁移规则：升级时丢弃未确认的 v2 结果，或允许一次"无日志豁免"补报 |
| `D-08` | §11 与正文不一致：§11.3 称 `S-01`–`S-08`、`C-01`–`C-09` 未变，实际 `S-02`（重派策略）、`S-07`（加归档）、`C-06`（删"调度器按任务类型约定"）、`C-08` 均变 | `:561` vs `:451`、`:456`、`:470`、`:472` | 修 §11.2/§11.3；`S-02` 的"失败/超时不自动重派"是行为变化，必须显式记录 |
| `D-09` | task-space 的清理与保留策略未与现有 `clean-*` 语义对齐 | `:476`、`C-12`；`workspace.ts:30` | 明确 `keep`/`clean-skills`/`clean-client` 对 `.agent-flow/task` 的处置；归档依赖该目录，默认不得删除 |

## 5 Hold

| ID | 项 | 处置 |
|---|---|---|
| `H-01` | `P-04` 响应 `bytes` 是压缩后还是原始字节，未写明（`:308`） | 契约补一句；建议压缩后，与上限口径一致 |
| `H-02` | `P-04` 返回 `404 task_not_found` 时 client 该丢弃还是重试，未写 | 建议丢弃结果、停止上传（与 `P-02` 404 一致） |
| `H-03` | 副本"逐字一致"与"修正仓库路径说明"冲突；正文仍写"client 副本尚未建立"（`:13`）和调度器侧 history 路径（`:15`） | 建议逐字复制，来源与同步日期记在 `docs/README.md`；不改正文 |
| `H-04` | 交接件在 `docs/works/` 但 frontmatter 是 `layer: design`（`:1`–`:9`），违反位置即状态 | 同步到 `design/contracts/` 时一并改；交接期间保留现状但在 `result.md` 说明 |
| `H-05` | `brief.md:46` "启动期校验失败退出码明确"不可实现：协议不匹配只能在首个 poll 发现 | 改成"首个 poll 收到 `400 unsupported_protocol` 即退出（非 0）" |
| `H-06` | `brief.md:54` 要求上传前预检 5 个常量，其中 `maxArchiveEntries`/`maxArchiveUncompressedBytes` 是服务端解包校验（`:96`–`:97`） | client 只需预检 `maxArchiveBytes`（可选再加 `maxIntentBytes`） |

## 6 任务表修订建议

| 调整 | 内容 |
|---|---|
| 拆 `T-CV3-03` | `CMP-workspace`：task-space 创建/校验、`intent.md` 写入；`CMP-executor`：执行时序（task-space → session → skills → prompt）与日志上传挂接 |
| 拆 `T-CV3-04` | `CMP-store`：日志/归档产物持久化、`archivedRuns` 待确认电平、重启恢复；`CMP-cli`：归档后台任务与 poll 解耦 |
| 新增 `T-CV3-07` | `CMP-runtime`：原始 ACP 事件出口（新端口能力）与单测 |
| 新增 `T-CV3-08` | `CMP-result`/`Ports`：新错误码映射与结果分类 |
| 新增 `T-CV3-09` | 测试桩升级：`stub-scheduler`/`mock-scheduler` 支持协议 3、`P-04`/`P-05`、`archiveRequests`、409/413 注入；作为 `T-CV3-02`–`T-CV3-05` 的前置 |
| 补 `T-CV3-05` 门禁 | 空日志结算、413 后结算、压缩产物字节稳定重传、归档不阻塞 poll（心跳不中断） |

依赖顺序：`T-CV3-01` 可立即开工；`T-CV3-09` 先于契约测试；`T-CV3-02`–`T-CV3-05` 等 `B-01`–`B-04` 与 `D-01`–`D-07` 关闭；`B-05`/`B-06` 的任务拆分在 client 影响规格里定。

## 7 需调度器侧回答的问题

1. `B-01`：日志 413 后任务如何结算？选"豁免"还是"客户端截断"？
2. `B-02`：早失败（workspace/asset/spawn/prompt 超限/取消未建 session）是否必须传空日志？客户端可接受"必须传空日志"。
3. `B-03`：日志/归档重传是否要求客户端持久化压缩产物？若不要求，是否改为"同键不论 sha 取第一份并回 200"？
4. `B-04`：`archiveRequests` 未确认期间，poll 是否正常挂起？客户端计划后台归档、poll 不阻塞，请确认服务端不会因此判静默。
5. `D-01`：`409 content_conflict` 的客户端终结动作（冲突即已有）是否成立？
6. `D-03`：归档是否补 `workspacePath`，或明确只信任 `taskSpacePath`？
7. `D-05`：日志事件形状、可裁剪范围与脱敏要求。
8. `D-06`：日志/归档失败的稳定错误码表。
9. `D-07`：v2 遗留 `settled` 结果的迁移豁免是否允许？
10. `D-08`：§11 的"未改变"清单需要按正文修正。

## 8 决策记录（2026-11-12 澄清）

| 编号 | 决策 | 落点 |
|---|---|---|
| `D-01` | 冲突不再"只保留第一份"：服务端接受带时间戳的较新一份；旧 `attempt` 不得覆盖更新的 `attempt` | 契约 §4.4.3/§4.5.4 重写；客户端上传带时间戳；错误码 `content_conflict` 语义重定义或删除 |
| `D-02` | `archivedRuns` 保留到服务端下一次 poll 不再下发该 `runId` | 客户端收到"不再下发"后移除；不设固定上限 |
| `D-03` | `archiveRequests` 增加 `workspacePath` | 契约 §5 `ArchiveRequest` 类型 |
| `D-04` | 工作区一定存在；task-space 目录由客户端创建；目录内容（`intent.md` 等）由 start 专家（模型）写 | `C-10` 改写；客户端不再写 `intent.md` |
| `D-05` | 日志**完整透传、不脱敏**；服务端只存不解析，排障时离线解析 | 契约保持"不解析"；记录为已接受风险（日志可能含密钥/工具输出） |
| `D-06` | 日志/归档失败码由调度器在契约定义 | 错误码表新增 |
| `D-07` | 升级时丢弃 v2 遗留的 `settled` 结果 | client 启动迁移逻辑 |
| `D-08` | 调度侧修正 §11 的"未改变"清单 | 契约 §11 |
| `D-09` | 清理策略（`keep`/`clean-skills`/`clean-client`）不覆盖 task-space | `CMP-workspace` 规格与清理清单 |
| `D-10` | 归档确认后仍保留本地 task-space | `C-12` 保持；磁盘由运维处理 |

### 8.1 由决策引出的契约修订（需调度器侧执行）

| 编号 | 修订 | 关联 |
|---|---|---|
| `R-01` | `C-10` 改为"客户端建 task-space 目录；`intent.md` 由 start 专家写"；`intentMarkdown` 字段的去留与传递路径（是否仍下发、是否并入 prompt）需明确 | `D-04` |
| `R-02` | `P-04`/`P-05` 幂等改为"较新时间戳覆盖、旧 `attempt` 不覆盖新 `attempt`"；上传需带时间戳头 | `D-01` |
| `R-03` | `ArchiveRequest` 增 `workspacePath` | `D-03` |
| `R-04` | §11.2/§11.3 按正文修正（`S-02`/`S-07`/`C-06`/`C-08`） | `D-08` |
| `R-05` | 明确定义日志/归档失败码（如 `session_log_too_large`、`archive_too_large`），与 `B-01` 的结算规则配套 | `D-06`、`B-01` |
| `R-06` | 在契约中记录"日志完整透传、服务端仅存储不解析"的取舍与风险 | `D-05` |
| `R-07` | `C-11` 补"早失败也必须传 0 行空日志"；`B-01` 的超限只记风险、本期不豁免 | `B-02`、`B-01` |
| `R-08` | §4.1 删"client 处理完归档再拉任务"，改为"归档后台执行，poll 正常挂起" | `B-04` |

### 8.2 阻塞项处置（2026-11-12）

| 编号 | 决策 | 影响 |
|---|---|---|
| `B-01` | **本期不处理**：日志按原样打包上传，超限 `413` 的问题等实际遇到再解决 | 已接受风险：一旦单节点日志超过 `maxSessionLogBytes`，该任务会卡在 `409 session_log_missing`，需人工或后续版本处理。记入 `plan/risks.md` 与契约待定 |
| `B-02` | 每个 `attempt` 都必须有日志，包括**0 行的空 gzip**；早失败先传空日志再报结果 | 契约补一条；client 增加"空日志"路径；规则统一，服务端不用特判 |
| `B-04` | 归档**后台执行**，poll 正常挂起；不再要求"处理完归档再拉任务" | 契约 §4.1 改措辞；client 归档与 poll 解耦，避免静默重派与 10ms 空转 |

### 8.3 仍未决

- `B-05`：client 任务拆分（`CMP-runtime` 事件出口、`CMP-result` 错误码、v3 测试桩、拆跨组件任务）。
- `B-06`：runtime "不落完整会话"、workspace "只写 `.dsh`" 两个不变量的修订与数据所有权更新。

## 10 第二轮复核：`response.md` 与修订版契约（2026-11-12）

> 对象：`response.md`、修订后的 `executor-http-v3.md`/`contract-diff.md`/`brief.md`。
> 结论：**修订版接受**。`B-01`–`B-04`、`D-01`–`D-10`、`H-01`/`H-02` 在契约层面闭环；`N-01`/`N-02` 属交接件一致性，`N-03`–`N-06` 是口径补充，均不影响契约方向。

### 10.1 闭环确认

| 项 | 修订落点 | 结论 |
|---|---|---|
| `B-01` 日志 413 死锁 | §1 不变式 5、§4.4 #5、§8 矩阵、§12 #6 | 关闭：先传 0 行空日志再报 `failed(session_log_too_large)`，任务正常结算 |
| `B-02` 早失败无日志 | §1 #5、§4.4 #2、`C-11` | 关闭：每个 `attempt` 必须有日志，允许 0 行 |
| `B-03` 字节稳定 | §4.4 #4、§4.5 #4、§2 端点表 | 关闭：改为「后到覆盖」，不再要求持久化首次字节 |
| `B-04` 归档与判活互锁 | §4.1「归档不改变挂起行为」、`S-07`、`C-12` | 关闭：后台归档、poll 正常挂起，首次下发那跳可立即返回一次 |
| `D-01` 冲突终结动作 | §3.1 注、§4.4 #4、`stored` 字段 | 关闭：`content_conflict` 删除，同键重传覆盖 |
| `D-02` 已归档名单 | §4.1 `archivedRuns` 条 | 关闭：服务端不再下发后移除，不设固定上限 |
| `D-03` 归档缺工作区路径 | §4.1 响应示例、§5 `ArchiveRequest` | 关闭：已增 `workspacePath` |
| `D-04` 建目录/写 intent 归属 | §4.1 #4/#5、`C-10`、§11.4 | 关闭：client 只建目录；`intent.md` 由 start 节点模型写；`intentMarkdown`/`maxIntentBytes` 删除 |
| `D-05` 日志脱敏 | §4.4 #1、§12 #7 | 关闭：完整透传、不脱敏；风险已登记 |
| `D-06` 失败码 | §4.2 #4、§4.5 #5 | 关闭：`session_log_too_large`（结果）、`archive_too_large`（`archive_state`） |
| `D-07`–`D-10` | §11.4 D-07/D-09、§9 清理说明、`C-12` | 关闭 |
| `H-01` `bytes` 口径 | §3 通用约定、§5 `SessionLogAck` | 关闭：一律压缩后 |
| `H-02` `P-04` 404 | §4.4 #3 | 关闭：丢弃上传与结果、停止重试 |
| `H-06` 预检常量 | `contract-diff.md` 常量节 | 关闭：client 只需预检 `maxArchiveBytes` |

### 10.2 交接件一致性（需调度器侧或同步时修正）

| 编号 | 问题 | 证据 | 处置 |
|---|---|---|---|
| `N-01` | **副本与权威不一致（1 行）**：client 副本 §11.1 把 `archive_too_large` 列为结果码，权威文件已注明它只进 `archive_state` | `diff` 两文件仅此一处差异（`executor-http-v3.md:574`） | 以权威文件重新同步；否则 `T-CV3-01` 验收第 1 条不成立 |
| `N-02` | **`brief.md` 仍有多处按旧版写** | `:24`/`:33`（`intent.md` 写入）、`:47`（启动期校验）、`:54`（`maxIntentBytes`）、`:55`/`:72`（`content_conflict`）、`:84`（同 sha 200/异 sha 409） | 其中 `:84` 与新语义直接冲突，`T-CV3-05` 会写错断言；开工前必须改 |
| `N-03` | `archive_too_large` 被列在「结果 `error.code` 约定值」（§4.2 #4、§11.1），同句又说「不进结果体」 | §4.2 #4、§11.1 | 建议移到 §4.5，或在 §4.2 标注「归档侧状态码」 |
| `N-04` | `session_log_too_large` 的 `error.class` 未指定 | §4.2 #4 只给了 `code` | client 需从闭集选一个（建议 `runtime`）；契约补一句更稳 |
| `N-05` | `D-01` 的机制由「客户端带时间戳」改为「按到达顺序覆盖」 | §4.4 #4、§12 #8 | 幂等键含 `attempt`，旧副本不会跨 attempt 覆盖，可接受；请调度器侧确认这是最终语义 |
| `N-06` | `C-07` 有修改（补「未建 session 时传空日志」），但 §11.3 仍把它列在「未改变」 | §7 `C-07` vs §11.3 | 小口径；§11.2 补一行或 §11.3 移除 `C-07` |

### 10.3 client 侧处理（不阻塞调度器）

- `H-03`（副本逐字一致 vs 仓库路径说明）与 `H-04`（交接件 `layer: design` 在 `works`）：在 `T-CV3-01` 落 `design/contracts/` 时一并处理。
- `H-05`（"启动期校验"）：client 按「首个 poll 收到 `400 unsupported_protocol` 即退出」实现；`brief.md` 的措辞若由调度器侧维护，请同步改。
- `B-05`/`B-06`：在 client 影响规格中拆任务、改不变量。

### 10.4 开工门

1. `N-01` 重新同步副本；`N-02` 修正 `brief.md` 的验收口径——这两项完成前 `T-CV3-02`–`T-CV3-05` 不开工。
2. `N-03`–`N-06` 可由调度器侧一并修订，不单独阻塞；client 按 §10.2 的处置实现。
3. `T-CV3-01`（文档同步）可立即开工，以调度器侧权威文件为源。

## 11 确认记录

- 本评审为 P1 第一次人工门（契约与范围确认）。待确认项：结论"有条件通过"、`B-*` 反馈调度器侧、`D-*` 进 client 影响规格。
- 确认后：调度器侧发布修订版契约 → 本工序更新 `executor-http-v3.md` 副本 → client 出影响规格（P1 第二次确认）→ 拆任务开工。
- 未确认前，除 `T-CV3-01`（文档同步）外不写实现代码。
