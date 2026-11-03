---
layer: works
module: runtime
status: closed
updated: 2026-11-03
---

# 工序 Brief：S0 P0 阻断项验证

> 本文是施工前的测试方案，先给用户确认再执行。表中的 S0-01…S0-12、通过标准、失败动作来自用户提供的 P0 阻断项表；`D2/D9/D11` 的原文未在本仓库或上游 `agent-flow-orchaster` 中找到，结论里标注「D 编号映射待补」。

## 1. 范围与本工序边界

**验证目标**：用 ACP 驱动本机 dsh CLI，逐项判定 S0-01…S0-12 是否成立，给出证据与失败时的设计动作。

- 只做验证与探针，不改产品代码、不改 DSH 源码、不接调度器。
- 结论落到本工序 `result.md`，并把技能可见性相关结论回写 `plan/open-questions.md`（OQ-001/002）。
- 估计 25–35 次真实模型 prompt，约 15–25 分钟；不含调试失败重试。

**已完成的先导工作**（`docs/history/works/2026-11-03-dsh-acp-preflight/`，已归档）：

- 已确认 `dsh --profile acp` 可启动、真实模型可 prompt、permission/cancel/close/list 可用；
- 已确认技能目录消息的落盘格式（`user/message`，`source.kind=skill-catalog`，带 `entries`），可作为可见性判定依据；
- 未系统验证技能根、写入时机、替换、隔离、脚本、并发、崩溃这 12 项。

## 2. 环境与隔离

| 项 | 值 / 做法 |
|---|---|
| dsh 入口 | `/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js`（源码 checkout 的 CLI） |
| 启动方式 | `node <entry> --profile acp`，stdin/stdout 走 ACP，stderr 收日志 |
| Node | `/opt/homebrew/bin/node` v26.8.1 |
| `DSH_HOME` | `/tmp/dsh-s0/home`（隔离；内放临时 `.credentials.yaml`，测试结束删除） |
| `DSH_AGENTS_HOME` | `/tmp/dsh-s0/agents`（空目录，屏蔽 `~/.agents/skills` 的默认污染） |
| 工作区 | `/tmp/dsh-s0/ws/<case>`（每个场景独立；S0-05/10 需要共享或特殊路径时单独说明） |
| 技能根（默认） | `<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`、`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills`；`projectRoot` = 最近含 `.git` 的祖先，否则 cwd |
| 技能格式 | 顶层目录 bundle `<name>/SKILL.md` 或平铺 `<name>.md`；frontmatter 必填 `name`（kebab-case）与 `description`；不支持嵌套 `**/SKILL.md` |

**已知环境限制（必须写进结论）**：

1. checkout 的 `lib/`、`node_modules` 是 2026-10-02 构建，落后 HEAD，启动跳过 7 个插件（含 `working-directory`、`subagent-*`、`tool-executor-native`）。本 12 项只依赖 ACP 核心与 skill 插件，不受阻断，但结论只对这份构建成立；最终 S0 签收前应重建或换固定发行版。
2. 本会话运行在 DSH 沙箱内，子 dsh 的 `bash-sandbox` 可能因 `sandbox-exec` 被外层拒绝而失败。S0-06 的脚本执行若命中，判「环境受限」，并给出在普通终端复跑的命令，不据此改动设计。

## 3. 观测与证据

每个场景产出 `runs/S0-xx.json`，字段固定：

```json
{
  "scenario": "S0-03",
  "verdict": "通过|失败|部分通过|环境受限",
  "steps": [{"name": "...", "ok": true, "detail": "..."}],
  "catalog": {"entries": [{"name": "...", "description": "..."}], "source": "session-log"},
  "transcript": [{"method": "...", "summary": "..."}],
  "process": {"exitCode": 0, "durationMs": 0},
  "notes": "..."
}
```

三类证据：

1. **ACP 侧（主证据）**：`session/update` 的文本块、tool_call/tool_call_update、permission 请求、stopReason、JSON-RPC error；stdout 每行必须能 JSON 解析。
2. **目录侧（技能可见性判定）**：会话关闭后解压 `$DSH_HOME/sessions/<escaped-cwd>/<sessionId>/session.v4.jsonl.zstd`（`zstd -dc`），取 `type=user/message` 且 `source.kind=skill-catalog` 的 `source.entries`。这是 DSH 内部格式，只作为目录真值；同时用「让模型加载某技能」的 tool_call 行为做交叉验证。执行前先 dump 一条原始消息确认格式未变。
3. **进程与文件侧**：dsh 进程退出码、`kill -0` 探活、脚本写出的 PID/token 文件、session 目录与 lock 文件、工作区文件内容。

## 4. 夹具（fixtures）

| 夹具 | 内容 |
|---|---|
| `skill-dir` | `<root>/<name>/SKILL.md`，frontmatter `name`/`description`，正文给 token |
| `skill-flat` | `<root>/<name>.md` |
| `skill-nested` | `<root>/group/nested/SKILL.md`（预期不可见） |
| `skill-bad` | 缺 `description` 的 `SKILL.md`（预期不可见，且有警告） |
| `skill-dup` | 同名 `dup` 同时放 `.dsh/skills` 与 `.agents/skills`，正文 token 不同（验证优先级） |
| `script-abs` | bundle 内 `scripts/mark.sh`（`#!/bin/sh`，echo token 并写 token 文件），技能正文给绝对路径 |
| `script-rel` | 同上但技能正文给相对路径 `scripts/mark-rel.sh` |
| `git-root` | 根目录 `git init`，技能在根 `.dsh/skills`，session cwd 指到子目录 |
| `git-worktree` | 用 `git worktree add` 生成 `.git` 为文件的目录 |
| `路径特殊` | 含空格与 Unicode 的工作区目录，如 `/tmp/dsh-s0/ws/s0 ws ü` |

所有测试技能的正文只做一件事：让模型输出一个唯一 token（如 `S0-ALPHA`），便于判定「是否真的加载了当前版本」。

## 5. 逐项方案

### S0-01 ACP 基线

**步骤**：空 workspace；启动 dsh；`initialize`；`session/new`（绝对 cwd）；`session/prompt` = `Reply with exactly: OK`；`session/close`；stdin EOF。

**断言**：initialize `protocolVersion=1`；sessionId 非空；`stopReason=end_turn` 且文本含 `OK`；stdout 全部为 JSON 行；进程退出码 0（≤10s）；stderr 无 fatal。

**证据**：`runs/S0-01.json` + 原始 stdout/stderr。

**失败动作**：先修启动/环境，S0 整体阻塞。

### S0-02 技能根与格式

**夹具**：同一 workspace 放 `alpha`（`.dsh/skills`）、`beta`（`.agents/skills`）、`flat-skill`（`.dsh/skills/*.md`）、`nested-skill`（嵌套）、`bad-skill`（缺 description）、`dup`（两个根同名）。

**步骤**：prompt `Reply with exactly: OK` 触发目录发布；读 catalog；再 prompt `Load skill dup and follow it`，看实际 token。

**断言**：
- 目录恰含 `alpha`、`beta`、`flat-skill`、`dup`；
- 不含 `nested-skill`、`bad-skill`；
- `dup` 解析为 `.dsh/skills` 版本（rank 100 优先），加载后 token 为 dsh 版本；
- 加载 `alpha`/`beta`/`flat-skill` 均成功并返回各自 token。

**失败动作**：调整 client 的技能落地路径与格式（只允许顶层 bundle 或 flat、保证 description、禁止嵌套）。

### S0-03 会话后写技能是否可见（核心）

四个子实验，均为独立 workspace + 独立 session：

1. **立即**：`session/new`（空 workspace）→ 写 `.dsh/skills/s0-alpha/SKILL.md`（token `S0-ALPHA-A`）→ 立即 prompt `Load skill s0-alpha and output its token`。重复 3 次记录命中率。
2. **延迟**：同样流程，写后分别等 50/200/500ms 再 prompt。
3. **对照组**：先写好技能再 `session/new`，立即 prompt。
4. **同 session 替换**：session 内先 prompt 加载 `s0-alpha`（token A）→ 改写为 token B（同时改 description）→ 再 prompt 加载 `s0-alpha`。

**断言**：
- 立即或有限延迟（≤500ms）内可见，且对照组一致；
- 若首次 prompt 不可见、第二次 prompt 可见，记录「需要屏障」；
- 同 session 替换后应看到 B；若只看到 A，则「节点内不能换技能」。

**失败动作**：
- 只有「先写后建」可见 → 改为先取技能再建 session；
- 需要延迟 → 加「技能已生效」屏障（客户端等待 watcher 稳定或轮询目录后重建 session）；
- 同 session 替换不可见 → 每节点新 session，节点内不换技能。

### S0-04 每节点替换

**步骤**（同一 dsh 进程，一个 workspace）：
1. 技能集 A（token `A-TOKEN`）→ session A → prompt 加载 → 关闭；
2. 改写为技能集 B（token `B-TOKEN`）→ session B → prompt 加载 B，并问「A 的 token 是什么」；
3. 改回 A → session C → prompt 加载 → 关闭。

**断言**：每次只看到当前组合；B 会话中 A 不可用/不出现；无残留；全程不重启进程。

**失败动作**：改为每 session 独立 workspace/进程或重启进程；修订 D2/工作区策略。

### S0-05 技能根隔离（关键）

两组，均在同一 workspace（含 `.dsh/skills/proj-dsh`、`.agents/skills/proj-agent`），并在 `$DSH_HOME/skills/user-dsh`、`$DSH_AGENTS_HOME/skills/user-agents` 放用户级技能：

1. **默认 profile**：不 patch，读目录 → 预期 4 个都在（记录默认污染事实）。
2. **受控 profile**：`--patch` 覆盖 `id: skill-filesystem`：

```yaml
- id: skill-filesystem
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - <workspace>/.dsh/skills
```

先用 `--dump-config` 确认 patch 生效（已预演可行），再启动。预期目录只剩 `proj-dsh`（自定义根），不含 `.agents`、用户根、bundled。

**断言**：默认 4 个全出现；受控只剩指定根；两者差异有记录。

**失败动作**：无法隔离 → 「模型只看到当前组合」不成立；需要 client 管理 DSH profile/技能根，或改需求。

### S0-06 脚本执行与权限

**夹具**：`script-abs` 技能正文「用 bash 执行 `<workspace>/.dsh/skills/script-abs/scripts/mark.sh`，回复它的输出」；脚本 echo `S0-SCRIPT-TOKEN` 并写 token 文件。另备 `script-rel` 用相对路径。

**步骤**：以 `--permission allow` 跑 prompt；记录 permission 请求（toolCall、options）、tool_call 结果、token；再跑相对路径版本。

**断言**：脚本被执行、token 出现在结果、token 文件存在；权限请求与自动应答路径明确；绝对/相对路径行为记录。

**降级**：若 bash 因外层沙箱报 `sandbox backend`，判「环境受限」，给出普通终端复跑命令；不据此判脚本能力失败。

**失败动作**：定义权限策略/白名单；否则脚本不能进 MVP。

### S0-07 会话复用与关闭

同一进程、同一 workspace，依次：

1. 3 个 session：prompt OK → close，重复 3 次；
2. `session/new` 后立即 `close`（未 prompt）；
3. 同一 session `close` 两次；
4. prompt 长任务 → `cancel` → `close`。

**断言**：每个 session 正常；close-before-prompt 有明确结果（成功或定义好的错误）；close 幂等或错误可读；无泄漏（新 session 仍可建）、进程稳定；结束 stdin EOF 退出 0。

**失败动作**：调整一进程多 session 的生命周期。

### S0-08 取消

**步骤**：prompt「用 bash 执行 `sleep 30 && echo DONE`」；2s 后 `session/cancel`；记录 stopReason；再在同一 session prompt `Reply OK`；close。另测「无活跃 prompt 时 cancel」。

**断言**：cancel 返回 `cancelled`；无挂起；session 仍可用；进程干净退出；空 cancel 不崩溃。

**失败动作**：客户端 kill 兜底；记录限制。

### S0-09 并发 session / 不同 cwd

**步骤**：同一进程；workspace A/B 各放不同技能（token A/B）；两个 session 分别 cwd=A/B；并发发 prompt（各自加载技能）；各自 close。

**断言**：各看各的目录与 token；互不污染；独立 close；进程稳定。

**失败动作**：fan-out 用独立进程或串行；修订 D2/D9。

### S0-10 工作区与 project root

**步骤**：
1. 根有 `.git`（目录）+ 根 `.dsh/skills/root-skill`，session cwd=根下子目录 → 应可见；
2. 无 `.git`，同样布局 → 应不可见（project root=cwd）；把技能放子目录 `.dsh/skills` → 应可见（证明 cwd 回退）；
3. `git worktree`（`.git` 是文件）→ 记录是否按根解析；
4. 路径含空格/Unicode → 技能可见、脚本绝对路径可执行。

**断言**：规则与 DSH 文档一致（最近 `.git` 祖先，否则 cwd）；技能可见性符合预期；脚本路径正确。

**失败动作**：client 统一用 project root 作为 cwd/技能落地根。

### S0-11 崩溃与重启

**步骤**：session prompt「用 bash 把 `$$` 写到 `/tmp/dsh-s0/orphan.pid` 后 `sleep 30`」；2–3s 后对 dsh 进程 `SIGKILL`；检查进程消失、pid 文件中的 bash 是否仍存活（孤儿判定）、lock 文件；用同一 `DSH_HOME` 重启 dsh；`session/list`；新建 session prompt OK；检查工作区文件。

**断言**：无孤儿进程（或记录存在并清理）；无锁阻塞新 session；重启后新 session 可用；持久化行为（崩溃 session 是否可列/恢复）记录；工作区不丢。

**失败动作**：加 supervisor/清理；按 D11 重跑当前节点。

### S0-12 结果提取

**步骤**：
1. prompt `Reply with exactly: RESULT-TOKEN-123` → 断言文本、stopReason、usage、update 序列；
2. 长输出：prompt「用 bash 打印 1..500」→ 断言最终文本完整（含 500、长度合理），无需 transcript；
3. 错误：用无凭据 home 跑一次 → 断言 JSON-RPC error（`-32603`，可读 message）；另用未知 config option 制造协议错误。

**断言**：最终消息稳定可提取；stopReason 可用；usage 记录（当前版本可能为 null，如实记录）；错误可映射。

**失败动作**：调整结果提取与错误映射。

## 6. 执行顺序与矩阵

| 阶段 | 场景 | 目的 |
|---|---|---|
| A | S0-01、S0-02、S0-05 | 先验证目录 oracle 与技能根，确认观测可信 |
| B | S0-03、S0-04 | 核心：写入时机与每节点替换 |
| C | S0-06、S0-07、S0-08、S0-09 | 工具/权限、生命周期、并发 |
| D | S0-10、S0-11、S0-12 | 路径、崩溃、结果提取 |

每阶段结束落 `runs/` 证据；若 A 阶段 oracle 不成立（拿不到 `skill-catalog` entries），暂停并回报，不硬跑后续。

## 7. 风险与降级

| 风险 | 处理 |
|---|---|
| 模型不按指令加载技能 | 目录断言不依赖模型；加载类断言用明确指令 + 重试 1 次；仍不配合则判「目录可见、加载未验证」 |
| checkout 缺 7 个插件 | 只影响 subagent/native/cwd 上下文；结论标注限定；建议 S0 签收前重建 |
| 嵌套沙箱导致 bash 失败 | S0-06/08/11 判「环境受限」，提供普通终端复跑命令 |
| 会话日志内部格式变化 | 先 dump 原始消息确认 `source.kind=skill-catalog`；失败则回退为「加载行为」证据并标注 |
| 真实模型延迟/抖动 | 单 prompt 超时 120–300s；S0-03 延迟档位只测一次，异常时补测 |
| 凭据落盘 | 只在 `/tmp/dsh-s0/home` 临时放 `.credentials.yaml`，测试结束删除；不进仓库、不进日志 |

## 8. 交付物

- `harness/s0-suite.mjs`：一键跑 12 项，产出 `runs/S0-*.json`；
- `runs/`：每项证据（含 catalog entries、tool calls、进程退出）；
- `result.md`：S0-01…S0-12 结论表（通过/失败/部分/环境受限 + 证据 + 设计动作 + 备注）、oracle 说明、对 D2/D9/D11 的修订建议；
- 更新 `plan/open-questions.md`（OQ-001/002 结论）、`plan/risks.md`（若出现新风险）、`plan/roadmap.md`。

## 9. 确认结果（2026-11-03）

1. 已按用户选择**重建 checkout**（`pnpm install --frozen-lockfile` + `pnpm run build:lib`），验证在 HEAD 构建上完成。
2. 已允许并执行真实模型调用；凭据只在隔离 home 临时存放，跑完删除。
3. S0 表原文（含 D2/D9/D11）未提供；按表执行，结论中标注「D 编号映射待补」。

执行结果见 [`result.md`](result.md)：12 项 11 通过，S0-11（崩溃孤儿进程）失败。
