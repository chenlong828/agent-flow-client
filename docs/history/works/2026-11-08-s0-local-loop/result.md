---
layer: works
module: global
status: frozen
updated: 2026-11-08
---

# 工序结果：S0 本地执行闭环

## 1. 结论摘要

- 路线图批次 1 的 6 个任务全部落地：配置与骨架、运行目录与状态、容器与技能、DSH 执行、执行内核、S0 门禁。
- 不接调度器，用 `run --request` + `LocalSchedulerAdapter` 跑通「容器校验 → 建 session → 装技能 → prompt → 结果」；`doctor` 可判定本机可用性。
- `SCN-0002` 的 3 正 1 反（`TC-CONFIG-001`…`004`）全绿；`SCN-0001` 的 S0 用例 UC-01/05/06/07/08/09/10/11/13/14/16/17/28/29/31 有对应测试；R-03（取消/信号后无残留）、R-04（恢复：有结果重报、无结果 abandoned、不自动重跑）通过。
- 真机验收：用 `hundsun-public` 的 `hs-deepseek-flash-latest` 完成一次真实 prompt，`status=succeeded`、`message=S0-OK`、退出 0；skill 落地、脚本 0755、journal 收到 `closed`、session 落在实例 `DSH_HOME`、`~/.dsh/sessions` 无新增、无残留 DSH 进程。
- 未完成（转入后续）：`TC-EXEC-002`（顺序两节点，S0.1）、`serve` 主循环与 `CMP-gateway`（S1）、多实例 home 派生（OQ-009/S1）、技能包 HTTP 下载与缓存（S1）。

## 2. 任务表

| ID | 任务 | 组件 | 状态 | 提交 |
|---|---|---|---|---|
| `T1` | 配置与骨架 | `CMP-cli`、`CMP-store` | 完成 | `8e4bb41` |
| `T2` | 运行目录与状态 | `CMP-store`、`CMP-observability` | 完成 | `0812671` |
| `T3` | 容器与技能 | `CMP-workspace`、`CMP-assets` | 完成 | `2c3aae5` |
| `T4` | DSH 执行 | `CMP-runtime` | 完成 | `ce5443c` |
| `T5` | 执行内核 | `CMP-executor`、`CMP-result` | 完成 | `f334b3c` |
| `T6` | S0 门禁 | 全部 | 完成（见 §3） | 本次收口提交 |

## 3. 验收结果

### 3.1 `SCN-0002` 配置与自检

| 用例 | 结果 | 证据 |
|---|---|---|
| `TC-CONFIG-001` 默认 home | 通过 | `tests/components/cli/config.test.ts`、`tests/scenarios/s0-config.test.ts`；`doctor` 全绿退 0 |
| `TC-CONFIG-002` 配置绝对/相对路径 | 通过 | 解析为绝对路径；子 DSH 进程实际收到同一 `DSH_HOME`（`FAKE_ACP_HOME_FILE` 断言） |
| `TC-CONFIG-003` env 覆盖配置 | 通过 | `DSH_HOME` 优先；加载后冻结不重读 |
| `TC-CONFIG-004` 非法配置 | 通过 | 非法 TOML/空值/类型/越界/`~/.dsh`/不可写：退出 2 或 4，不回退 |

### 3.2 `SCN-0001` S0 用例

| UC | 结果 | 测试 |
|---|---|---|
| UC-01 单节点执行 | 通过 | `tests/scenarios/s0-exec.test.ts`（`TC-EXEC-001`） |
| UC-05 容器非法 | 通过 | `tests/components/workspace/workspace.test.ts` |
| UC-06 技能包异常 | 通过 | `tests/scenarios/s0-exec.test.ts`（`TC-EXEC-004`） |
| UC-07 运行时不可用 | 通过 | `tests/components/runtime/runtime.test.ts`（spawn/崩溃） |
| UC-08 工作区不可写 | 通过 | `tests/components/workspace/workspace.test.ts` |
| UC-09/10 prompt 超时/权限 | 通过 | `tests/components/runtime/runtime.test.ts` |
| UC-11 DSH 崩溃 | 通过 | 崩溃返回 `process_exited`，重启后可用 |
| UC-13 取消 | 通过 | `tests/scenarios/s0-exec.test.ts`（`TC-EXEC-003`）、runtime cancel |
| UC-14 二次信号 | 通过 | `tests/components/cli/signals.test.ts`（SIGINT → 130、进程组回收） |
| UC-15 崩溃重启（仅清理） | 通过 | `tests/components/store/journal.test.ts`、executor `recover` |
| UC-16 孤儿进程 | 通过 | runtime cancel/超时后 `kill -0` 为假；启动 `reapOrphan` |
| UC-17 崩溃 session/lock | 通过 | `tests/components/store/locks.test.ts`（陈旧锁接管、双跑 locked） |
| UC-28 不可信路径 | 通过 | `tests/components/workspace/workspace.test.ts`（`..`/符号链接逃逸） |
| UC-29 不可信包 | 通过 | `tests/components/assets/assets.test.ts`（符号链接、超限、嵌套） |
| UC-31 会话隔离 | 通过 | home 不指向 `~/.dsh`；真机会话只落实例 home |

### 3.3 可靠性门禁

| 需求 | 结果 | 证据 |
|---|---|---|
| R-03 中断收敛 | 通过 | cancel 后 2s 内 DSH 进程组与 `sleep` 子进程 `kill -0` 为假；SIGINT 用例 |
| R-04 崩溃可恢复 | 通过 | `recover`：`settled/reported` 重报并 closed；`claimed…running` 标 `abandoned`；不自动重跑 |
| R-02 结果不丢（S0 部分） | 通过 | 先 `settled` 落 journal 再上报；上报失败保留 settled |
| R-05 技能不串/不半套 | 通过 | 原子替换、失败回滚、digest 幂等 |
| R-08 失败可分类 | 通过 | `CMP-result` 映射表 + 测试 |

## 4. 真机验收

环境：`DSH_BIN=/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js`，node v26.8.1，DSH `0.2.2-alpha.2`；模型 `hundsun-public/hs-deepseek-flash-latest`（`AF_MODEL`，端点为用户提供的 OpenAI 兼容端点）。

命令（凭据经 `.env` 的 `HUNDSUN_PUBLIC_API_KEY` 注入，不落盘到仓库）：

```bash
env -u DSH_HOME bun run src/cli.ts run \
  --request /tmp/afc-s0-gate/request.json \
  --permission allow --state-root /tmp/afc-s0-gate/state
```

结果摘要：

```json
{"status":"succeeded","sessionId":"406e327d-…","message":"S0-OK","stopReason":"end_turn","usage":null,"error":null}
```

退出 0。附加检查：

- `/tmp/afc-s0-gate/workspace/.dsh/skills/alpha/SKILL.md` 存在，`scripts/mark.sh` 为 `0755`；
- journal 7 条状态 `claimed→bound→ready→running→settled→reported→closed`；
- `state/orphans` 为空，无残留 `--profile acp` 进程；
- session 目录在实例 `AF_DSH_HOME/sessions/`，`~/.dsh/sessions` 下无该 session。

失败重试记录：第一次真机运行仍路由到 `deepseek-official`（`acp` 入口自带 `provider/model`，覆盖了 `agent-default-model`）；在 profile 补丁中补 `acp` 入口后通过。该修正已写入 `CMP-runtime.profile`。

## 5. 偏差与决定

| 项 | 决定 | 理由 |
|---|---|---|
| 模型路由 | S0 在实例 profile 补丁写 `llm-pi-ai` + `agent-default-model` + `acp` 三条；`AF_MODEL`/`AF_LLM_BASE_URL` 可覆盖 | 模型选择尚未进调度器契约；S0 用环境变量固定，S1 再决定由谁下发（新增 OQ-026） |
| DSH 入口 | `DSH_BIN` 环境变量；`.js` 用 `AF_NODE_BIN` 启动 | 本机无 PATH `dsh`；生产发行版与 pin 策略仍待 OQ-003 |
| 实例 home | S0 单实例直接使用配置 `DSH_HOME`，不派生 `instances/<id>` | REQ-0001 要求原样传给 DSH；多实例派生留 S1（OQ-009） |
| 凭据 | 运行时支持 `DSH_CREDENTIALS_SOURCE` 复制到实例 home；开发用 `.env` 注入 | 凭据只在本机；不进日志/结果/仓库 |
| `serve` | 只做配置校验后退出 2，提示 S1 接入 | S0 不接调度器；`CMP-gateway` 在 S1 |
| 技能包来源 | S0 只支持 `file://`/本地目录；`digestDirectory` 作为包摘要 | 无网络依赖；HTTP 下载/缓存留 S1 |
| 顺序两节点 | 未实现（`TC-EXEC-002` 保持待实现） | 属于 S0.1/S1；S0 单节点出口不依赖 |

## 6. 决策落点

| 结论 | 落点 |
|---|---|
| 配置键/退出码冻结 | `CMP-cli` §2.3、`architecture.md` §13、`plan/open-questions.md` OQ-014/015 |
| 组件落地与入口 | 9 份组件规格的状态/实现入口；`docs/design/test-matrix.md` 的 `existing` 行 |
| 测试锚点 | `TC-CONFIG-001`…`004`、`TC-EXEC-001/003/004`；`TC-EXEC-002` 待 S0.1 |
| 模型路由与 S0 机制 | 本结果 §5；新增 `OQ-026` |
| 场景状态 | `SCN-0001`/`SCN-0002` 保持 `designed`（`TC-EXEC-002` 未实现，不升 `verified`） |

## 7. 遗留与下一步

- `TC-EXEC-002` 顺序两节点（S0.1）/`serve` 主循环与 `CMP-gateway`（S1）。
- `CMP-gateway` 实现、桩调度器、契约测试（S1 批次 2）。
- 多实例 home 派生与回收（OQ-009）；技能包 HTTP 下载/缓存（S1）；`stateRoot` 安装目录不可写时的部署默认（AH-02 已收口为退出 4 + `--state-root`）。
- 观测 HTTP P1 独立轨道，未进入本工序。

## 8. 裁决摘要

P3（按冻结设计实现，无契约/切分变更）。blocker 0 / decision 3（模型路由、单实例 home、S0 本地技能来源，均已落文档）/ hold 2（`TC-EXEC-002`、`CMP-gateway`，转 S1）。
