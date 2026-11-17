---
layer: works
module: global
status: frozen
updated: 2026-11-17
---

# ACP 事件实测（自然版）：没有"每步一句话"的多步骤 prompt

> 纠正：上一份 [`../complex-20261117/report.md`](../complex-20261117/report.md) 的 prompt 末尾带了"每完成一步，用一句话说明你做了什么"，会人为增加正文。本文件用**去掉该句**的自然 prompt 重跑。
> 环境与产物同前：DSH dev `apps/cli/lib/bin.js`、`hs-deepseek-flash-latest`、独立 `DSH_HOME`；`summary.json` + `summary.protocol.jsonl` 在本目录。

## 1. Prompt（自然版）

```text
请实际执行一个多步骤文件任务，不要只描述计划：
1) 在当前目录创建 out/ 目录，写入 out/a.txt（内容 alpha）和 out/b.txt（内容 beta）；
2) 用 shell 把 a.txt 和 b.txt 按顺序拼接成 out/combined.txt；
3) 读取 out/combined.txt，确认内容；
4) 统计 out/combined.txt 的行数和字节数；
5) 最后用一句话汇报：文件路径、内容、行数、字节数。
```

- 总耗时 **14.8s**，`stopReason=end_turn`
- **24 条 `session/update`**：正文 4、思考 3、`tool_call` 6、`tool_call_update` 6、`usage_update` 5
- 2 次权限请求（`danger-full-access` 重试）
- 6 个工具：bash 失败、write a、write b、bash cat、read、bash wc

## 2. 逐事件时间线

| 相对 prompt | 事件 | 关键信息 |
|---:|---|---|
| 3.509s | `agent_message_chunk` | 正文：我会直接按照这个多步骤任务执行。 |
| 3.509s | `usage_update` | used=5634 / size=1000000 |
| 3.510s | `tool_call` | bash · in_progress · mkdir -p out && printf 'alpha' > out/a.txt && prin… |
| 3.535s | `tool_call_update` | failed · Error: sandbox mode "workspace-write" is requested b… |
| 5.362s | `agent_thought_chunk` | 思考 227 字：The sandbox backend is not usable. Approval p… |
| 5.362s | `agent_message_chunk` | 正文：本机的 shell 沙箱后端当前无法使用。我先改用文件工具写入，之后再尝试用 shell。 |
| 5.362s | `usage_update` | used=5913 / size=1000000 |
| 5.362s | `tool_call` | write · in_progress · out/a.txt |
| 5.382s | `tool_call_update` | completed · <path>/private/tmp/acp-natural-1794908142/ws/out/a.t… |
| 5.382s | `tool_call` | write · in_progress · out/b.txt |
| 5.396s | `tool_call_update` | completed · <path>/private/tmp/acp-natural-1794908142/ws/out/b.t… |
| 8.507s | `agent_thought_chunk` | 思考 98 字：Files written. Now shell concat — needs sandb… |
| 8.507s | `agent_message_chunk` | 正文：文件已创建。现在用 shell 拼接；由于本机沙箱后端故障，我将以更宽权限重试这一条命令。 |
| 8.507s | `usage_update` | used=6205 / size=1000000 |
| 8.507s | `tool_call` | bash · in_progress · cat out/a.txt out/b.txt > out/combined.txt && ls -… |
| 8.516s | `session/request_permission` | toolCallId=uu0947 · options=['allow_once', 'reject_once'] |
| 8.537s | `tool_call_update` | completed · total 24 drwxr-xr-x@ 5 chenlong wheel 160 Nov 17 17:… |
| 10.557s | `usage_update` | used=6514 / size=1000000 |
| 10.558s | `tool_call` | read · in_progress · out/combined.txt |
| 10.572s | `tool_call_update` | completed · <path>/private/tmp/acp-natural-1794908142/ws/out/com… |
| 10.572s | `tool_call` | bash · in_progress · wc -l -c out/combined.txt && echo '---' && od -c o… |
| 10.578s | `session/request_permission` | toolCallId=6F3647 · options=['allow_once', 'reject_once'] |
| 10.589s | `tool_call_update` | completed · 0 9 out/combined.txt --- 0000000 a l p h a b e t a 0… |
| 14.793s | `agent_thought_chunk` | 思考 611 字：Content is "alphabeta" (9 bytes, no trailing … |
| 14.793s | `agent_message_chunk` | 正文：已执行完毕，所有步骤均实际完成： 1. 已创建 `out/` 目录，并写入 `out/a.txt`（alpha… |
| 14.793s | `usage_update` | used=6979 / size=1000000 |

## 3. 自然情况下正文长什么样

4 段正文（不是每步都有）：

| 时刻 | 长度 | 内容 |
|---:|---:|---|
| 3.509s | 16 字 | "我会直接按照这个多步骤任务执行。" |
| 5.362s | 45 字 | "本机的 shell 沙箱后端当前无法使用。我先改用文件工具写入，之后再尝试用 shell。" |
| 8.507s | 45 字 | "文件已创建。现在用 shell 拼接；由于本机沙箱后端故障，我将以更宽权限重试这一条命令。" |
| 14.793s | 287 字 | 最终汇报：创建、拼接、内容 `alphabeta`、行数/字节数 |

**关键**：8.5s 之后到 14.8s 之间，模型实际执行了 `read` 和 `wc`，但**没有新的正文**；如果只看 `text`，这 6.3 秒会一直停在"现在用 shell 拼接"。这就是为什么 `activity` 必须存在。

## 4. 工具事件的真实形态

- `write` 的 `rawInput` 含**文件内容**：

```json
{"sessionUpdate":"tool_call","toolCallId":"call_00_fEF6…","title":"write","kind":"other","status":"in_progress",
 "rawInput":{"file_path":"out/a.txt","content":"alpha"}}
```

  `write` 的 `tool_call_update.content` 是 `<path>…</path><content>Created file</content>`。
- `read` 的 `tool_call_update.content` 是文件全文（`1: alphabeta`）。
- `bash` 的 `tool_call_update.content` 是 stdout/stderr（`wc` 输出 `0 9 out/combined.txt`）。
- 第一次 bash 仍因本机 sandbox 后端不可用而 `failed`，随后模型改用 `write`；这是环境问题，不是任务逻辑。

**隐私提醒**：`write`/`edit` 的 `rawInput.content` 可能包含完整文件内容。进度摘要必须优先取 `file_path`/`command` 等短键，**不能**把 `rawInput` 整体 stringify。

## 5. 5s 快照（自然版）

| tick | phase | 累计事件 | used | 最近事件距今 | 最近动作数 | 最新正文（截断） |
|---:|---|---:|---:|---:|---:|---|
| 5s | prompting | 4 | 5634 | 1.5s | 1 | 我会直接按照这个多步骤任务执行。 |
| 10s | prompting | 16 | 6205 | 1.5s | 4 | 文件已创建。现在用 shell 拼接；由于本机沙箱后端故障，我将以更宽权限重试这一条命令。 |
| 15s | prompting | 24 | 6979 | 0.2s | 6 | 已执行完毕，所有步骤均实际完成： 1. 已创建 `out/` 目录，并写入 `out/a.txt… |

10s 的 v2 UI：

```text
方案 · 运行中
模型处理中 · 最近活动 1.5 秒前 · 上下文 6.2k / 1M

最新输出
「文件已创建。现在用 shell 拼接；由于本机沙箱后端故障，我将以更宽权限重试这一条命令。」

最近动作
1.5s 前   bash  cat out/a.txt out/b.txt > out/combined.txt（0.03s，已完成）
4.6s 前   write  out/b.txt（0.01s，已完成）
4.6s 前   write  out/a.txt（0.02s，已完成）
6.5s 前   bash  mkdir -p out && printf …（0.03s，失败：sandbox backend）
```

15s 时最终正文和 `read`/`wc` 动作一起出现：

```text
方案 · 运行中
模型处理中 · 最近活动 0.2 秒前 · 上下文 7.0k / 1M

最新输出
「已执行完毕……out/combined.txt 的内容为 alphabeta……1 行、9 字节。」

最近动作
4.4s 前   bash  wc -l -c out/combined.txt（0.02s，已完成）
4.4s 前   read  out/combined.txt（0.01s，已完成）
6.5s 前   bash  cat out/a.txt out/b.txt > out/combined.txt（0.03s，已完成）
```

## 6. 与"强制每步一句话"的对比

| 项 | 自然版 | 强制每步一句话 |
|---|---:|---:|
| 总耗时 | 14.8s | 27.5s |
| 事件数 | 24 | 28 |
| 正文 | **4 段** | 6 段 |
| 思考 | 3 段 | 6 段 |
| 工具 | 6 个 | 5 个 |
| 正文覆盖 | 开头、失败说明、文件创建、最终汇报 | 几乎每步都有 |
| 8.5s 后到结束 | 正文停在"现在用 shell 拼接"，实际已 read/wc | 每步都有正文 |

结论：

1. **不能假设每步都有正文**。自然任务里正文是稀疏的，最后一个正文可能覆盖多个步骤。
2. **`activity` 是必需的**：工具动作比正文更密、更及时；本例 6 个工具里有 2 个发生在最后一段正文之前。
3. **`text` 仍然有价值**：它给意图和结果；只是必须标 `ageMs`，并接受它可能落后于 `activity`。
4. **`write` 摘要必须取路径**，不能把 `rawInput` 整体序列化，否则文件内容会进载荷。
5. 5s 快照会跳过 10.5s 的 read/wc（落在 10s 与 15s 之间），所以 `activity` 必须保留最近 N 条，而不是"本周期新增"。

## 7. 复现

同 [`../complex-20261117/report.md`](../complex-20261117/report.md) §7，只把 `--prompt` 换成上面的自然版；产物在本目录 `summary.json` / `summary.protocol.jsonl`。
