---
layer: works
module: global
status: frozen
updated: 2026-11-17
---

# ACP 事件实测：一个多步骤、多次工具调用的 prompt

> 目的：在本地真实调用一次"多步骤 + tools"的 prompt，记录 ACP 能反馈的每一种事件、字段与结果信息，作为进度上报与 UI 展示的依据。
> 环境：DSH dev `apps/cli/lib/bin.js`，profile `acp`，模型 `hs-deepseek-flash-latest`，独立 `DSH_HOME` 与临时工作区；权限 allow。
> 产物：`summary.json`（归一化事件）、`summary.protocol.jsonl`（逐帧协议）、本文件。
> **注意**：本 prompt 末尾额外加了"每完成一步，用一句话说明你做了什么"，会人为增加正文；去掉该句的自然版见 [`../natural-20261117/report.md`](../natural-20261117/report.md)。

## 1. 测试 prompt

```text
请实际执行一个多步骤文件任务，不要只描述计划：
1) 在当前目录创建 out/ 目录，写入 out/a.txt（内容 alpha）和 out/b.txt（内容 beta）；
2) 用 shell 把 a.txt 和 b.txt 按顺序拼接成 out/combined.txt；
3) 读取 out/combined.txt，确认内容；
4) 统计 out/combined.txt 的行数和字节数；
5) 最后用一句话汇报：文件路径、内容、行数、字节数。
每完成一步，用一句话说明你做了什么。
```

- 工作区：`/private/tmp/acp-complex-1794907673/ws`
- session：`0ae3227a-3e5a-46ac-8414-b3a9ba64e41e`
- 总耗时：**27.5s**，`stopReason=end_turn`
- 实际动作：5 个工具调用（4 成功、1 次失败后重试）、6 段思考、6 段正文、3 次权限请求。

## 2. 事件总览

| 事件 | 次数 | 说明 |
|---|---:|---|
| `agent_thought_chunk` | 6 | 每次模型步骤的推理块 |
| `agent_message_chunk` | 6 | 本轮 prompt 强制"每步一句话"，所以每步都有正文 |
| `tool_call` | 5 | bash×4、read×1 |
| `tool_call_update` | 5 | 成功×4、失败×1（本机 sandbox 后端不可用） |
| `usage_update` | 6 | 每步一次，`used/size` |
| `session/request_permission` | 3 | 3 次 `danger-full-access` 重试的授权 |
| `session/prompt` 响应 | 1 | 只有 `stopReason` |

## 3. 逐事件时间线

| 相对 prompt | 事件 | 关键信息 |
|---:|---|---|
| 3.515s | `agent_thought_chunk` | 思考 327 字：We need execute steps, report each step one senten… |
| 3.515s | `agent_message_chunk` | 正文：第 1 步：先创建 `out/` 目录，再写入两个文件。 |
| 3.515s | `usage_update` | used=5736 / size=1000000 |
| 3.515s | `tool_call` | bash · in_progress · mkdir -p out && printf '%s' alpha > out/a.txt && printf… |
| 3.549s | `tool_call_update` | failed · Error: sandbox mode "workspace-write" is requested but … |
| 5.471s | `agent_thought_chunk` | 思考 251 字：Sandbox backend failure. Need perhaps retry with d… |
| 5.472s | `agent_message_chunk` | 正文：第 1 步：在受限沙箱无法启动的情况下，我改用无沙箱模式执行同一命令，仅用于在当前工作区创建指定目录和文件。 |
| 5.472s | `usage_update` | used=6097 / size=1000000 |
| 5.472s | `tool_call` | bash · in_progress · mkdir -p out && printf '%s' alpha > out/a.txt && printf… |
| 5.479s | `session/request_permission` | toolCallId=TPrg3480 · options=['allow_once', 'reject_once'] |
| 5.498s | `tool_call_update` | completed · total 16 -rw-r--r--@ 1 chenlong wheel 5 Nov 17 17:27 a.… |
| 12.494s | `agent_thought_chunk` | 思考 610 字：Step 1 done. Step 2 shell concatenate in order. Co… |
| 12.494s | `agent_message_chunk` | 正文：第 1 步已完成：`out/a.txt` 和 `out/b.txt` 已分别写入 `alpha` 与 `bet… |
| 12.494s | `usage_update` | used=6533 / size=1000000 |
| 12.494s | `tool_call` | bash · in_progress · cat out/a.txt out/b.txt > out/combined.txt |
| 12.503s | `session/request_permission` | toolCallId=jvPd2704 · options=['allow_once', 'reject_once'] |
| 12.518s | `tool_call_update` | completed · (no output) |
| 13.471s | `agent_thought_chunk` | 思考 53 字：Now say step2 complete, step3 reading. Use read to… |
| 13.471s | `agent_message_chunk` | 正文：第 2 步已完成：`out/combined.txt` 已生成。 第 3 步：读取 `out/combined… |
| 13.471s | `usage_update` | used=6654 / size=1000000 |
| 13.471s | `tool_call` | read · in_progress · /private/tmp/acp-complex-1794907673/ws/out/combined.txt |
| 13.483s | `tool_call_update` | completed · <path>/private/tmp/acp-complex-1794907673/ws/out/combin… |
| 25.005s | `agent_thought_chunk` | 思考 3474 字：Read tool says 1 line. But does it count no traili… |
| 25.005s | `agent_message_chunk` | 正文：第 3 步已完成：读取确认了 `out/combined.txt` 的内容为 `alphabeta`。 第 4… |
| 25.005s | `usage_update` | used=7841 / size=1000000 |
| 25.005s | `tool_call` | bash · in_progress · printf 'lines='; awk 'END {print NR}' out/combined.txt;… |
| 25.013s | `session/request_permission` | toolCallId=4TXv2118 · options=['allow_once', 'reject_once'] |
| 25.028s | `tool_call_update` | completed · lines=1 bytes= 9 |
| 27.527s | `agent_thought_chunk` | 思考 1105 字：Now final one sentence with path, content, lines b… |
| 27.528s | `agent_message_chunk` | 正文：第 4 步已完成：`out/combined.txt` 的内容为 `alphabeta`，按逻辑行计算为 1 … |
| 27.528s | `usage_update` | used=8226 / size=1000000 |

## 4. 各类事件实际长什么样

### 4.1 `agent_thought_chunk`（推理块）

```json
{ "sessionUpdate": "agent_thought_chunk",
  "messageId": "972e2b56-…",
  "content": { "type": "text", "text": "We need execute steps, report each step one sentence. Need create dir, files, shell concat, read, wc. Use tools. First maybe pwd/list. Let's do mkdir and write files. …" } }
```

- 能拿到：整段推理文本、`messageId`、到达时刻。
- 本例长度：327 / 251 / 610 / 53 / 3474 / 1105 字。
- 用途：解释"为什么这么做"；但属于模型内部推理，默认不应全量外传。

### 4.2 `agent_message_chunk`（面向用户的正文）

```json
{ "sessionUpdate": "agent_message_chunk",
  "messageId": "0322963f-…",
  "content": { "type": "text", "text": "第 1 步已完成：`out/a.txt` 和 `out/b.txt` 已分别写入 `alpha` 与 `beta`。  \n第 2 步：现在用 shell 按 `a.txt`、`b.txt` 的顺序拼接成 `out/combined.txt`。" } }
```

- 能拿到：完整正文、`messageId`；同一 message 可能多个 chunk。
- 本例 6 段正文分别在 3.5s / 5.5s / 12.5s / 13.5s / 25.0s / 27.5s 到达，和工具调用同批。
- 这正是"任务在干什么"最直接的内容；如果不传，UI 只能靠工具名猜。

### 4.3 `tool_call`（工具开始）

```json
{ "sessionUpdate": "tool_call",
  "toolCallId": "call_00_0CqJ23tvIVZNfeop7kaG9106",
  "title": "bash",
  "kind": "other",
  "status": "in_progress",
  "rawInput": { "command": "mkdir -p out && printf '%s' alpha > out/a.txt && printf '%s' beta > out/b.txt && ls -l out",
                "description": "Create out directory and two files" } }
```

- 能拿到：工具名（`title`）、`kind`（DSH 固定 `other`）、状态、解析后的参数 `rawInput`、`toolCallId`。
- 本例参数形态：bash 是 `command`/`description`/`justification`/`sandbox_permissions`；read 是 `file_path`。
- 不能拿到：该工具在 ACP 层的细分类型（read/edit/execute），DSH 都标 `other`。

### 4.4 `tool_call_update`（工具结束，带结果）

失败（第一次 bash，sandbox 后端不可用）：

```json
{ "sessionUpdate": "tool_call_update",
  "toolCallId": "call_00_0CqJ23tvIVZNfeop7kaG9106",
  "status": "failed",
  "content": [ { "type": "content", "content": { "type": "text",
    "text": "Error: sandbox mode \"workspace-write\" is requested but no sandbox backend is usable on this host; …" } } ] }
```

成功（read）：

```json
{ "sessionUpdate": "tool_call_update",
  "toolCallId": "call_00_YXNkB9TGdlMcEWSRzO8O4382",
  "status": "completed",
  "content": [ { "type": "content", "content": { "type": "text",
    "text": "<path>/private/tmp/…/out/combined.txt</path>\n<type>file</type>\n<content>\n1: alphabeta\n\n(End of file - total 1 lines)\n</content>" } } ] }
```

- 能拿到：成功/失败、工具输出/读取内容、`toolCallId`（与 `tool_call` 关联）。
- 用途：结果摘要、失败原因、步骤完成判定；内容可能很大（read 整个文件、bash 大段输出），不适合整体进进度载荷。

### 4.5 `usage_update`（上下文水位）

```json
{ "sessionUpdate": "usage_update", "used": 8226, "size": 1000000 }
```

- 能拿到：上下文已用 token / 窗口大小；本例 5736 → 8226。
- 注意：这是 `used/size`，不是 `inputTokens/outputTokens`；`session/prompt` 响应不带 usage。

### 4.6 `session/request_permission`（授权请求）

```json
{ "jsonrpc": "2.0", "id": 1, "method": "session/request_permission",
  "params": {
    "sessionId": "0ae3227a-…",
    "toolCall": { "toolCallId": "call_00_gdOLLAMjGGIgvqSwTPrg3480" },
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
    ] } }
```

- 能拿到：`toolCallId`、两个选项；**没有工具名/参数**，要显示"正在申请什么权限"必须用 `toolCallId` 关联前面的 `tool_call`。
- 本例 3 次（5.479s / 12.503s / 25.013s），都是 `danger-full-access` 重试；client 静态策略立即选 `allow_once`，所以"等待授权"窗口接近 0。
- 响应：`{"outcome":{"outcome":"selected","optionId":"allow-once"}}`。

### 4.7 `session/new` 与 `session/prompt` 响应

```json
{ "sessionId": "0ae3227a-…",
  "configOptions": [ { "id": "model", "currentValue": "[\"hundsun-public\",\"hs-deepseek-flash-latest\"]", … } ] }
```

```json
{ "stopReason": "end_turn" }
```

- `session/new` 能拿到 sessionId 与模型配置；`session/prompt` 只返回 `stopReason`，没有 usage、没有中间状态。

## 5. 如果按 5s 进度快照，会看到什么

| tick | phase | 累计事件 | used | 最近事件距今 | 最近动作数 | 最新正文（截断） |
|---:|---|---:|---:|---:|---:|---|
| 5s | prompting | 5 | 5736 | 1.5s | 1 | 第 1 步：先创建 `out/` 目录，再写入两个文件。 |
| 10s | prompting | 10 | 6097 | 4.5s | 2 | 第 1 步：在受限沙箱无法启动的情况下，我改用无沙箱模式执行同一命令，仅用于在当前工作区创建指定目录和文… |
| 15s | prompting | 20 | 6654 | 1.5s | 4 | 第 2 步已完成：`out/combined.txt` 已生成。 第 3 步：读取 `out/combi… |
| 20s | prompting | 20 | 6654 | 6.5s | 4 | 第 2 步已完成：`out/combined.txt` 已生成。 第 3 步：读取 `out/combi… |
| 25s | prompting | 20 | 6654 | 11.5s | 4 | 第 2 步已完成：`out/combined.txt` 已生成。 第 3 步：读取 `out/combi… |
| 28s | prompting | 28 | 8226 | 0.5s | 5 | 第 4 步已完成：`out/combined.txt` 的内容为 `alphabeta`，按逻辑行计算为… |

- **v1（只报当前工具）**：6 个 tick 全部 `prompting`，因为工具都在 12–34ms 内结束；UI 只会显示"模型处理中"。
- **v2（activity + text）**：能看到"第 1 步… / bash 失败后重试 / read combined.txt / 第 4 步统计"这条线；13.5–25s 的 11.5s 空窗会显示"最近活动 11.5 秒前"，但心跳还在（不是停更）。

对应 10s 的 v2 UI：

```text
方案 · 运行中
模型处理中 · 最近活动 4.5 秒前 · 上下文 6.1k / 1M

最新输出
「第 1 步：在受限沙箱无法启动的情况下，我改用无沙箱模式执行同一命令……」

最近动作
5.498s  bash  mkdir -p out && printf …（0.03s，已完成）
3.549s  bash  mkdir -p out && printf …（0.03s，失败：sandbox backend）
```

## 6. 结论：ACP 能提供什么、不能提供什么

| 维度 | 能拿到 | 拿不到 |
|---|---|---|
| 动作 | 工具名、参数、开始/结束、成功/失败、输出内容 | ACP 细分工具类型（DSH 全 `other`）；工具中途输出/百分比 |
| 叙述 | 每步思考块、每步正文（按消息提交） | token 级流式；最终回答之外的"完整计划" |
| 用量 | `used/size`（每步） | `inputTokens/outputTokens`（prompt 响应不带）；cost |
| 审批 | `toolCallId` + allow/reject 选项 | 工具名/参数（需关联）；等待时长（本例 0） |
| 生命周期 | prompt 响应 `stopReason` | turn/step 开始/结束事件、plan 事件 |

对进度上报的直接结论：

1. **`activity` 必须有**：5 个工具全部 <35ms，5s 快照抓不到"进行中"，只能靠最近动作列表。
2. **`text` 必须有**：本例正文 6 段，是"具体做了什么"的主要来源；只有工具名不够。
3. **工具输出不必进载荷**：`tool_call_update.content` 可能很大（read 整个文件），适合放 `P-04`/观测面；进度只放摘要。
4. **权限请求要关联 `tool_call`** 才能显示"申请执行什么"；当前 client 自动应答，窗口极短。
5. **事件是"步骤批次"到达**：thought/message/usage/tool_call 往往同一毫秒；不是 token 流，5s 周期足够。

## 7. 复现

```bash
# 1) 起一个隔离 DSH_HOME，写入 provider patch（见 summary.json 的 commandArgs）
# 2) 注入 HUNDSUN_PUBLIC_API_KEY 后运行：
node docs/history/works/2026-11-14-acp-progress-feedback/probe/acp-progress-probe.mjs \
  --dsh /Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js \
  --home /tmp/acp-complex/home --cwd /tmp/acp-complex/ws \
  --patch /tmp/acp-complex/home/af/profile.skill-patch.yml \
  --prompt '请实际执行一个多步骤文件任务…' \
  --out docs/history/works/2026-11-14-acp-progress-feedback/probe/complex-20261117/summary.json
```

- `summary.json`：归一化后的 28 条事件与 3 次权限。
- `summary.protocol.jsonl`：逐帧请求/响应/通知，可复查任意字段。
