---
layer: works
module: global
status: active
updated: 2026-11-08
---

# 工序 Brief：S0 本地执行闭环

> 输入：`docs/plan/roadmap.md` 批次 1；`SCN-0002`/`SCN-0001`；`REQ-0001`/`REQ-0002`；9 份组件规格与冻结契约 `docs/design/contracts/executor-http-v1.md`；配置键以 `CMP-cli` §2.3（2026-11-08 冻结）为准。
>
> 本工序把路线图建议的 6 个工序收在一个工序目录里按任务顺序执行（组件级 WIP=1，一次只动一组组件）；每完成一个任务提交一次，收口时整目录归档。

## 1. 目标与非目标

**目标**：不接调度器，用 `run --request` + `LocalSchedulerAdapter` 跑通「容器校验 → 建 session → 装技能 → prompt → 结果」，并让 `doctor` 可判定本机是否可执行；出口是：

- `SCN-0002` 的 `TC-CONFIG-001`…`004`（3 正 1 反）与 `doctor` 退出码；
- `SCN-0001` 的 S0 用例：UC-01/05/06/07/08/13/14/15（仅清理）/16/17/28/29/31；
- `REQ-0002` R-03（取消后 2s 内无残留）与 R-04（崩溃清理 + 等重派，S0 只做清理）。

**非目标**：

- 不接调度器、不实现 `CMP-gateway` 与 `serve` 主循环（S1）；`serve` 只做配置校验并给出「S1 接入」结论。
- 不做多实例 home 派生与回收（OQ-009，S1/S3）；S0 单实例直接使用配置的 `DSH_HOME`。
- 不做技能包 HTTP 下载与缓存（S1）；S0 只支持本地目录来源。
- 不把场景升 `verified`，除非 `tests/scenarios/` 的 3+1 与 S0 门禁全绿。

## 2. 本工序冻结的决策（2026-11-08）

用户确认：配置键按 `CMP-cli` §2.3 冻结；退出码按架构 §3.2 冻结；真机验收用 `hundsun-public` 的 `hs-deepseek-flash-latest`（端点实际模型 id；用户口述 `deepseek-flash-latest`），凭据复制到隔离 `DSH_HOME`，本机 `.env` 保存 `HUNDSUN_PUBLIC_API_KEY` 供开发复用（`.gitignore` 已忽略）。

### 2.1 配置键（OQ-014 已关闭）

`.config`（TOML，`<runDir>/.config`）：

```toml
[acp]
dsh_home = "AF_DSH_HOME"   # 默认；相对路径按 <runDir> 解析
permission = "deny"        # deny | allow

[state]
root = ".agent-flow-client" # 默认 <runDir>/.agent-flow-client

[logging]
level = "info"             # debug | info | warn | error

[capacity]
max_instances = 4          # 1..64；S0 只读取，serve 在 S1 使用
```

- 优先级（高 → 低）：**CLI flag（`--state-root`/`--log-level`/`--permission`）> 环境变量（仅 `DSH_HOME`）> `.config` > 默认值**；`max_instances` 只来自配置。
- `run/serve` 支持 `--state-root <path>`、`--log-level <level>`、`--permission deny|allow`。
- `[acp].dsh_home` 与 `[state].root` 禁止指向或位于 `~/.dsh` 之下；非法值不回退（退出 2）。
- `[acp].permission` 默认 `deny`；S0 真机验收用 `--permission allow`。
- `stateRoot` 不可写退出 4，提示用 `--state-root` 覆盖（`AH-02` 收口）。
- S1 才增加 `[scheduler].url` 与 `[retention]`。

### 2.2 退出码（OQ-015 已关闭）

`0` 成功 / `1` `run` 得到非成功 `NodeResult` / `2` 用法·配置 / `3` 鉴权·版本 / `4` DSH·运行时 / `5` 工作区·资产 / `6` 调度器不可达（S1） / `7` `run_superseded`（S1） / `130` SIGINT / `143` SIGTERM。

### 2.3 S0 运行机制（实现参数，不进契约）

- DSH 入口：`DSH_BIN` 环境变量（`.js` 用 `node` 启动，可用 `AF_NODE_BIN` 覆盖）；否则 PATH 中的 `dsh`。
- 模型：实例 profile 补丁写入 `llm-pi-ai.providers.hundsun-public`（`apiKeyEnv=HUNDSUN_PUBLIC_API_KEY`，`baseURL` 默认 `http://47.93.127.129:10088/v1`，可用 `AF_LLM_BASE_URL` 覆盖）与 `agent-default-model`（`provider=hundsun-public`、`model=hs-deepseek-flash-latest`，可用 `AF_MODEL` 覆盖）。
- 凭据：组合根把配置 home 下已存在的 `.credentials.yaml` 以 `0600` 复制到实例 `DSH_HOME`；不写日志、不进结果。
- 本地请求形状：`NodeRequest` + `skillSet`（`SkillSet`，`downloadUrl` 用 `file://` 目录）；`LocalSchedulerAdapter` 只做本进程内的 `bindSession`/`reportResult`。
- S0 单实例直接使用配置 `DSH_HOME`，不派生 `instances/<id>`；`shutdownInstance` 默认保留 home（REQ-0001「运行期不删」），多实例派生与删除留 S1。

## 3. 任务表

| ID | 类型 | 组件 | 任务 | 状态 | 装载清单 |
|---|---|---|---|---|---|
| `T1` | feature | `CMP-cli`、`CMP-store` | 配置与骨架：`version`/`doctor`/`run` 可跑，配置矩阵、退出码、journal 骨架 | 进行中 | `CMP-cli` §2.1–2.3/2.8、`CMP-store` §2.1–2.2、`SCN-0002`、`REQ-0001`、契约 §6.1/§6.2 |
| `T2` | feature | `CMP-store`、`CMP-observability` | 运行目录与状态：journal 折叠/恢复/锁/孤儿、日志/脱敏、`doctor` 渲染 | 待开始 | `CMP-store` §2.2–2.5、`CMP-observability` §2.1–2.3、`REQ-0002` R-09 |
| `T3` | feature | `CMP-workspace`、`CMP-assets` | 容器校验/路径约束/清理；技能原子替换/格式校验/脚本权限 | 待开始 | `CMP-workspace` §2.2–2.5、`CMP-assets` §2.1–2.5、`SCN-0001` UC-05/06/28/29 |
| `T4` | feature | `CMP-runtime` | DSH 进程/ACP session/prompt/取消/进程组回收/补丁 | 待开始 | `CMP-runtime` §2–§3、ACP 预研结论、S0-11 失败项 |
| `T5` | feature | `CMP-executor`、`CMP-result` | 状态机/去重/取消/恢复；结果组装/分类/截断；`LocalSchedulerAdapter` | 待开始 | `CMP-executor` §2–§3、`CMP-result` §2、契约 §6.2/§6.5 |
| `T6` | gate | 全部 | S0 门禁：`SCN-0002` 3+1、`SCN-0001` S0 用例、R-03/R-04、真机 prompt、文档收口 | 待开始 | 本 brief §4、两份场景卡、`REQ-0002` §4 |

## 4. 测试映射

完整映射以 [`docs/design/test-matrix.md`](../../design/test-matrix.md) 为单一来源（OQ-024 已关闭）；S0 相关行在测试落地后把状态从 `planned` 改为 `existing`，并把测试 ID 回填到场景卡。本工序额外约定：

- 跨组件端到端测试放 `tests/scenarios/`，组件内测试放 `tests/components/<组件>/`。
- 真机 ACP 验收不放进 `bun test` 默认集（需要凭据/网络），用 `tests/gate/` 下显式运行的脚本或在 `result.md` 记录命令与结论；默认集用 ACP 桩。
- `TC-EXEC-001`…`004` 与 `TC-CONFIG-001`…`004` 是首批锚点，测试文件命名以 `test-matrix.md` 为准。

## 5. 验收与收口

- 每个任务：`bun test`、`bun run typecheck` 全绿；组件规格状态 `planned → active`（只改已落地组件）；一个任务一个 commit。
- T6：`bun run check` 全绿；`SCN-0002`/`SCN-0001` 的 S0 用例有真实测试对应；真机 `run` 成功一次（记录命令与结果摘要，不记凭据/全文）。
- 收口：写 `result.md`（任务状态、验收结论、决策落点、遗留问题），更新 `plan/roadmap.md`、`plan/open-questions.md`、`design/architecture.md` 的 S0 状态与组件状态，然后归档到 `docs/history/works/`。

## 6. 风险

| 风险 | 处理 |
|---|---|
| 真机 DSH 版本/模型差异 | 以 `hs-deepseek-flash-latest` 实测；`doctor` 检查 DSH 版本；失败记入 result，不静默回退 |
| ACP 协议细节与预研版本不一致 | 以真实 `dsh --profile acp` 回放为准；runtime 用本地 ACP 桩做回归 |
| 嵌套沙箱下工具调用失败 | S0 门禁用不发工具的 prompt；需要脚本时在普通终端复跑并标注 |
| 进程组回收跨平台 | 只做 macOS/Linux（OQ-007）；`detached` + `kill(-pgid)`，2s 残留窗口 |
| `state.root` 在安装目录不可写 | `doctor` 报 4 并给出 `--state-root` 建议；S3 再评估平台目录（AH-02） |
| 并发会话同时改仓库 | 本工序只由单一执行者写；发现外部改动先 `git status` 核对来源再继续 |
