---
layer: works
module: runtime
status: closed
updated: 2026-11-03
---

# 工序结果：S0 P0 阻断项验证

## 结论摘要

- **12 项中 11 项通过，1 项失败**：S0-11（崩溃时遗留孤儿 bash 进程）不满足「无孤儿」标准，其余全部满足。
- 验证环境已按用户要求**重建 checkout**：`pnpm install --frozen-lockfile` + `pnpm run build:lib`，HEAD `ce7073d512`，启动时不再出现「7 entries did not activate」。
- 关键发现：
  1. **技能写入时机**：`session/new` 之后立即写技能，3/3 次首次 prompt 就可见；50/200/500ms 延迟均可见；同一 session 内替换技能后，catalog 描述与加载内容都变成新版本。本构建不强制需要「技能生效屏障」。
  2. **技能根隔离**：默认 profile 会同时看到项目 `.dsh`、项目 `.agents`、`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 四个根；用 `--patch` 设 `includeDefaultRoots: false + customSkillDirs` 后只剩指定根。
  3. **崩溃遗留**：SIGKILL dsh 后，正在 `sleep` 的 bash 子进程仍存活；session lock 文件保留；重启后 `session/list` 会把崩溃会话列出来，新 session 仍可用。
  4. **权限请求字段**：`session/request_permission` 的 `toolCall.title/kind` 为 `null`，客户端只能按 `options`（`allow_once` / `reject_once`）决策，不能按工具名做策略。
  5. **usage**：`session/prompt` 返回的 `usage` 为 `null`；`session/update` 流里有 `usage_update`，用量统计需从通知里取。
- `D2/D9/D11` 原文未在本仓库/上游找到，结论按表中通过标准推导，D 编号映射待补。

## 验收结果

| 项 | 结论 | 关键证据 | 设计动作 |
|---|---|---|---|
| S0-01 ACP 基线 | 通过 | `initialize` 返回 `protocolVersion=1`；prompt `stopReason=end_turn`、文本 `OK`；stdout 0 条非协议行；stdin EOF 后退出码 0 | 无需动作 |
| S0-02 技能根与格式 | 通过 | catalog entries 恰为 `alpha`/`beta`/`flat-skill`/`dup`；嵌套 `nested-skill` 与缺 description 的 `bad-skill` 不可见；同名 dup 加载出 `DSH-DUP-TOKEN`（`.dsh` 优先） | 技能落地必须顶层 bundle 或 flat，frontmatter 带 `name`/`description`；client 侧预校验，禁止嵌套 |
| S0-03 会话后写技能 | 通过 | 对照组可见；立即写 3/3 可见；50/200/500ms 均可见；同 session 替换后 catalog 描述与加载 token 均为 B 版本 | 不强制屏障；仍建议先写技能再 `session/new` 降低对 watcher 的依赖 |
| S0-04 每节点替换 | 通过 | 同进程 A→B→A 三个 session 分别得到 `A-TOKEN`/`B-TOKEN`/`A-TOKEN`；B 会话无 A 残留；进程 pid 不变 | 每节点复用同一进程、换 session + 换技能目录即可；不必重启 |
| S0-05 技能根隔离 | 通过 | 默认目录含 `proj-dsh`/`proj-agent`/`user-dsh`/`user-agents`；patch 后仅 `proj-dsh` | 默认根会串味，client 必须用 `--patch` 固定 `customSkillDirs` 并关默认根 |
| S0-06 脚本执行与权限 | 通过 | 脚本输出 `S0-SCRIPT-TOKEN` 并写 token 文件；permission 请求选项 `[allow_once, reject_once]`（title/kind 为 null）；相对路径也执行 | 权限策略按 `options` 选 `allow_once`；无法按工具名做黑白名单，需要按会话/节点放权 |
| S0-07 会话复用与关闭 | 通过 | 3 个 session 正常；close-before-prompt 成功；第二次 close 返回 `-32602 unknown session`；cancel 后 close 正常；退出码 0 | close 封装为幂等（忽略 `-32602`） |
| S0-08 取消 | 通过 | `stopReason=cancelled`；取消后同 session 可继续 prompt；无活跃 prompt 时 cancel 不崩溃 | 客户端保留「cancel 超时 → kill」兜底 |
| S0-09 并发会话 | 通过 | 同进程两个 session、不同 cwd 并发 prompt，分别得到 A/B token；目录描述各自正确；关闭 A 不影响 B | 可按节点并发；事件按 `sessionId` 路由 |
| S0-10 工作区/项目根 | 通过 | 有 `.git` 时子目录 cwd 可见根技能；无 `.git` 时根技能不可见、cwd 技能可见；worktree（`.git` 为文件）可见；空格/Unicode 路径可见 | 需要根技能时把 cwd 设为 project root；否则按子目录隔离 |
| S0-11 崩溃与重启 | **失败** | SIGKILL dsh 后脚本 `sleep` 子进程仍存活（`kill -0` 为真）；`session.lock` 保留；重启后 `session/list` 列出崩溃会话；新 session 可用 | 崩溃清理需杀进程组/作业树或 supervisor；明确崩溃会话的回收/关闭策略 |
| S0-12 结果提取 | 通过 | 精确 token 可提取；60 行长输出完整（含 `LINE-60`）；未知 config option 返回 `-32602`；无凭据返回 `-32603 ... no API key` 可读错误；`usage=null`，update 流有 `usage_update` | 结果取最终 assistant 文本 + `stopReason`；用量从 `usage_update` 取；错误按 JSON-RPC code/message 映射 |

## 关键证据细节

### S0-03（写入时机）

- 对照组（写后建 session）：`visible=true`。
- 立即（建 session 后写，立即 prompt）：3/3 `visible=true`。
- 延迟 50/200/500ms：全部 `visible=true`。
- 同 session 替换：第一次 `S0-ALPHA-A`，替换后第二次 `S0-ALPHA-B`；catalog 描述同步为 `Outputs S0-ALPHA-B.`。
- 说明：本构建在 prompt 时重新读取技能（与 OQ-001 的旧结论一致），watcher 也及时更新；但依赖文件系统事件，跨网络盘/高负载时仍建议「先写后建」。

### S0-05（默认污染）

- 默认 profile：`proj-agent, proj-dsh, user-agents, user-dsh` 四个根全部出现。
- 受控 profile（`--patch`）：

```yaml
- id: skill-filesystem
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - <workspace>/.dsh/skills
```

- 结果只剩 `proj-dsh`。patch 生效前已用 `--dump-config` 预演确认。

### S0-11（失败）

- 用技能 `crash-skill` 让模型前台执行 `scripts/crash.sh`（`echo $$ > orphan.pid; sleep 60`），拿到脚本 PID 后 SIGKILL dsh。
- 断言结果：`bash 已启动` 通过；`dsh 已被 kill` 通过；`无孤儿 bash` **失败**（pid 仍存活，随后由套件 SIGKILL 清理）。
- 重启后 `session/list` 包含崩溃会话；`session.lock` 存在；新 session 可正常 prompt。
- 结论：ACP 层没有「崩溃时清理工具子进程」的保证；client 侧需要进程组/作业树清理或 supervisor。

### S0-06（权限字段）

- 收到的请求：`options=[allow_once, reject_once]`，`title=null`、`kind=null`。
- 影响：客户端不能按 `toolCall.title`（如 bash）做策略，只能按会话/节点整体放权，或后续从 `tool_call` update 关联。

### S0-12（usage 与错误）

- `session/prompt` 响应 `usage: null`；update 流含 `usage_update`。
- 未知 config option：`-32602: Invalid params: unknown session config option: nonexistent-option`。
- 无凭据：`-32603: Internal error: turn failed: llm-deepseek: no API key ...`，可直接展示/映射。

## 环境与限制

- 入口：`/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js`，`node` v26.8.1，dsh `0.2.2-alpha.2`。
- 已重建：`pnpm install --frozen-lockfile`（8m17s）+ `pnpm run build:lib`；启动 stderr 为空，不再有插件激活失败。
- 隔离：`DSH_HOME=/tmp/dsh-s0/home-final2`、`DSH_AGENTS_HOME=/tmp/dsh-s0/agents-final2`、每场景独立 workspace；凭据临时复制到隔离 home，跑完删除。
- 嵌套沙箱限制：dsh 的 bash 工具在执行「工作区外写入」或「后台任务」时会走 `sandbox-exec`，被外层沙箱拒绝（`SANDBOX_UNAVAILABLE`）。S0-06 因脚本与输出都在工作区内而成功；S0-11 改用技能脚本（前台、写工作区内）绕过该限制。该限制属于验证环境，不是 ACP 行为。
- 未覆盖：permission 拒绝路径（干净环境）、`session/resume`、subagent/native 插件路径、Windows/Linux。

## 对 S0 设计决策的输入（D 编号待补）

1. **工作区/技能落地**：每节点独立 workspace，技能放顶层 `.dsh/skills/<name>/SKILL.md` 或 `<name>.md`；client 侧校验 `name`/`description`，拒绝嵌套。
2. **进程与会话**：一个 client 进程可承载多节点 session（并发已验证），但崩溃清理必须杀进程组；不能依赖 ACP close。
3. **技能根隔离**：必须用 profile patch 关默认根 + 指定 `customSkillDirs`，否则用户级/项目级技能会串味。
4. **权限**：按 `options` 选 `allow_once`，策略粒度到节点/会话；不要依赖 `toolCall.title`。
5. **结果**：取最终 assistant 文本 + `stopReason`；usage 从 `usage_update` 取；错误按 code/message 映射。
6. **写入时机**：先写技能再建 session；S0-03 表明立即写也可用，但保留屏障更稳。

## 证据索引

- 套件：`harness/s0-suite.mjs`（`--only`、`--home`、`--agents-home`、`--work-root`）。
- 逐项证据：`runs/S0-01.json` … `runs/S0-12.json`；汇总 `runs/summary.json`；完整日志 `runs/suite.log`。
- 复跑：

```bash
node docs/works/2026-11-03-s0-acp-verification/harness/s0-suite.mjs \
  --home /tmp/dsh-s0/home-final2 \
  --agents-home /tmp/dsh-s0/agents-final2 \
  --work-root /tmp/dsh-s0/ws-final2
```

（home 需放 `.credentials.yaml`，或导出 `DEEPSEEK_API_KEY`。）
