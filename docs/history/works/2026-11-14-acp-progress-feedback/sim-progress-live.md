---
layer: works
module: global
status: frozen
updated: 2026-11-14
---

# 进度上报实测模拟：当前运行中的「方案」节点

> 目的：回答"载荷只有工具名/摘要/耗时/上下文，到底能显示什么、够不够"。
> 数据源：本机正在执行的任务 `01a1daa8-add5-72e8-acf5-739f264e3571`（run `01a1daa7-312f-71b1-9393-ba834829d60a`，节点 `n3 方案`），client 会话日志 `session-logs/01a1daa8-…-a1.jsonl` 快照。
> 抓取窗口：2026-11-14 15:24:10.070Z（任务开始）– 15:26:29.002Z（最后一条事件）；窗口内任务仍在运行，n3 最终于 15:30:17Z 完成。本文件只覆盖前 2 分 19 秒。
> 说明：本文件是实测重建的模拟，不是已实现的上报；`executionId`/`seq` 按设计补全。

## 1. 这个任务实际发生了什么

- 任务开始：15:24:10.070Z；节点「方案」，工作区 `/Users/chenlong/hundsun/af-workspace-demo`，task-space `…/task-spaces/20261114-232232`。
- 抓取窗口内共 **191 条 `session/update`**：
  - `tool_call` 59 次、`tool_call_update` 59 次（59 个工具动作，全部在 0.01–0.11s 内完成）；
  - `agent_thought_chunk` 36 次；
  - `usage_update` 37 次；
  - `agent_message_chunk` **0 次**（任务还没结束，没有面向用户的正文）。
- 上下文从约 6k 涨到 135k / 1M。

**第一个关键发现**：59 个工具全部短于 5s，5s 采样永远停在"工具已结束、下一个还没开始"的缝隙里。按现设计（只报"当前工具"），这个任务 **28 个 tick 全部只能显示"模型处理中"**，一次工具都显示不出来。

## 2. 按现设计（v1）会报什么

### 2.1 实际载荷

+30s（工具密集段之后）：

```json
{
  "taskId": "01a1daa8-add5-72e8-acf5-739f264e3571",
  "attempt": 1,
  "executionId": "<uuid>",
  "seq": 6,
  "phase": "prompting",
  "elapsedMs": 30000,
  "lastEventAgeMs": 1335,
  "events": 86,
  "usage": {
    "used": 80780,
    "size": 1000000
  }
}
```

+45s（工具已结束、模型在思考）：

```json
{
  "taskId": "01a1daa8-add5-72e8-acf5-739f264e3571",
  "attempt": 1,
  "executionId": "<uuid>",
  "seq": 9,
  "phase": "prompting",
  "elapsedMs": 45000,
  "lastEventAgeMs": 718,
  "events": 92,
  "usage": {
    "used": 93445,
    "size": 1000000
  }
}
```

+100s（已经 16.7s 没有 ACP 事件，但任务仍在正常跑）：

```json
{
  "taskId": "01a1daa8-add5-72e8-acf5-739f264e3571",
  "attempt": 1,
  "executionId": "<uuid>",
  "seq": 20,
  "phase": "prompting",
  "elapsedMs": 100000,
  "lastEventAgeMs": 16679,
  "events": 151,
  "usage": {
    "used": 117100,
    "size": 1000000
  }
}
```

UI 上对应的全部内容：

```text
方案 · 运行中
模型处理中 · 最近活动 1.3 秒前 · 上下文 80.8k / 1M
```

+45s 时也是同一行，只是数字变化；+100s 时"最近活动 16.7 秒前"，会被误认为卡住（实际是模型在思考/写文档）。

### 2.2 28 个 tick 的分布

| tick | 时刻 | 累计事件 | 本周期完成工具 | 本周期思考块 | 上下文 used | 最近事件距今 | 当前活跃工具 |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | 15:24:15 | 32 | 11 | 5 | 38240 | 0.2s | 0 |
| 2 | 15:24:20 | 32 | 0 | 0 | 38240 | 5.2s | 0 |
| 3 | 15:24:25 | 56 | 8 | 4 | 60860 | 0.3s | 0 |
| 4 | 15:24:30 | 68 | 4 | 2 | 64309 | 0.4s | 0 |
| 5 | 15:24:35 | 74 | 2 | 1 | 68368 | 4.0s | 0 |
| 6 | 15:24:40 | 86 | 4 | 2 | 80780 | 1.3s | 0 |
| 7 | 15:24:45 | 86 | 0 | 0 | 80780 | 6.3s | 0 |
| 8 | 15:24:50 | 86 | 0 | 0 | 80780 | 11.3s | 0 |
| 9 | 15:24:55 | 92 | 2 | 1 | 93445 | 0.7s | 0 |
| 10 | 15:25:00 | 98 | 2 | 1 | 97266 | 3.6s | 0 |
| 11 | 15:25:05 | 104 | 2 | 1 | 101045 | 0.8s | 0 |
| 12 | 15:25:10 | 108 | 1 | 1 | 107527 | 1.1s | 0 |
| 13 | 15:25:15 | 124 | 5 | 3 | 110644 | 0.6s | 0 |
| 14 | 15:25:20 | 139 | 4 | 3 | 113547 | 0.4s | 0 |
| 15 | 15:25:25 | 143 | 1 | 1 | 114854 | 3.3s | 0 |
| 16 | 15:25:30 | 147 | 1 | 1 | 116822 | 1.1s | 0 |
| 17 | 15:25:35 | 151 | 1 | 1 | 117100 | 1.7s | 0 |
| 18 | 15:25:40 | 151 | 0 | 0 | 117100 | 6.7s | 0 |
| 19 | 15:25:45 | 151 | 0 | 0 | 117100 | 11.7s | 0 |
| 20 | 15:25:50 | 151 | 0 | 0 | 117100 | 16.7s | 0 |
| 21 | 15:25:55 | 155 | 1 | 1 | 123405 | 3.4s | 0 |
| 22 | 15:26:00 | 161 | 2 | 1 | 124688 | 0.1s | 0 |
| 23 | 15:26:05 | 169 | 2 | 2 | 125901 | 0.5s | 0 |
| 24 | 15:26:10 | 169 | 0 | 0 | 125901 | 5.5s | 0 |
| 25 | 15:26:15 | 173 | 1 | 1 | 132756 | 3.5s | 0 |
| 26 | 15:26:20 | 181 | 2 | 2 | 133798 | 1.1s | 0 |
| 27 | 15:26:25 | 187 | 2 | 1 | 134180 | 2.0s | 0 |
| 28 | 15:26:30 | 191 | 1 | 1 | 135216 | 1.1s | 0 |

**两个关键数字**：

- **28/28 个 tick 的 `phase` 都是 `prompting`**，`active=0`；
- 59 个工具、36 段思考全部发生在 tick 之间，v1 载荷一个都没带出来。

## 3. 实际发生的事情（v1 没上报的部分）

### 3.1 工具动作（节选，按完成时间）

| 时刻 | 工具 | 参数摘要 | 耗时 |
|---|---|---|---:|
| 15:24:10 | bash | `ls -la …/task-spaces/20261114-232232` | 0.06s |
| 15:24:10 | read | `…/task-spaces/20261114-232232/intent.md` | 0.01s |
| 15:24:11 | read | `…/task-spaces/20261114-232232/brief.md` | 0.01s |
| 15:24:12 | skill | `design-before-coding` / `arch-design-spec` / `doc-layout-spec` | 0.01s |
| 15:24:13 | bash | `cd …/uumail && git status --short && … find doc/…` | 0.05s |
| 15:24:20 | read | `…/uumail/doc/requirements/REQ-0013-…md` | 0.02s |
| 15:24:20 | read | `…/uumail/doc/requirements/REQ-0014-…md` | 0.02s |
| 15:24:30 | bash | `sed -n '1,180p' doc/design/components/CMP-…/spec.md` | 0.04s |
| 15:24:40 | bash | `sed -n '170,240p' doc/design/architecture.md` | 0.06s |
| 15:25:22 | edit | `…/doc/design/components/CMP-SYNC/spec.md` | 0.02s |
| 15:26:28 | bash | `sed -n '48p;99p;111p' doc/design/…` | 0.05s |

实际动作的类型很丰富：`read` 读需求卡/场景卡/组件规格，`bash` 查 git 状态和文档行号，`skill` 加载技能，`edit` 修改设计文档。v1 只报"当前工具"，这些全看不到。

### 3.2 思考/叙述（节选）

- +5s 前："Need to read rest of design.md (line 462+). Also read review.md, req cards, scenario cards. Let me continue."
- +30s 前："…Let me check the architecture §2.5/§3/§4/§5 and roadmap. Also risks."
- +100s 前："…Now write design.md. Need read existing? It doesn't exist in this run. `write` can create; no need read (didn't exist). Check."

这些内容能直接回答"现在在干什么"。但它们都是 `agent_thought_chunk`，不是 `agent_message_chunk`；如果载荷只允许"助手消息正文"，这个任务在结束前会一直是空白。

## 4. 按修订载荷（v2）会报什么

在 v1 基础上增加两个字段：

- `activity`：最近 8 个工具动作（名称、参数摘要、状态、耗时、结束距今），按结束时间倒序；
- `text`：最近一段思考或助手正文的尾部（≤200 字节），带 `kind` 与 `ageMs`。

+30s：

```json
{
  "taskId": "01a1daa8-add5-72e8-acf5-739f264e3571",
  "attempt": 1,
  "executionId": "<uuid>",
  "seq": 6,
  "phase": "prompting",
  "elapsedMs": 30000,
  "lastEventAgeMs": 1335,
  "events": 86,
  "usage": {
    "used": 80780,
    "size": 1000000
  },
  "activity": [
    {
      "id": "eL0515",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && sed -n '80,120p' doc/plan…",
      "status": "completed",
      "durationMs": 31,
      "endedAgeMs": 1335
    },
    {
      "id": "oF0493",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && sed -n '170,240p' doc/des…",
      "status": "completed",
      "durationMs": 55,
      "endedAgeMs": 1366
    },
    {
      "id": "uE8163",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && sed -n '1,190p' doc/desig…",
      "status": "completed",
      "durationMs": 23,
      "endedAgeMs": 3273
    },
    {
      "id": "wP8775",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && sed -n '1,180p' doc/desig…",
      "status": "completed",
      "durationMs": 36,
      "endedAgeMs": 3297
    },
    {
      "id": "Er9971",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && sed -n '1,140p' doc/desig…",
      "status": "completed",
      "durationMs": 21,
      "endedAgeMs": 8981
    },
    {
      "id": "lT9154",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && grep -rn \"GatewayEndpoint…",
      "status": "completed",
      "durationMs": 79,
      "endedAgeMs": 9003
    },
    {
      "id": "zj5437",
      "name": "read",
      "summary": "/Users/chenlong/hundsun/af-workspace-demo/uumail/Sources/Scenes/ReadScene.swift",
      "status": "completed",
      "durationMs": 26,
      "endedAgeMs": 10404
    },
    {
      "id": "mS6215",
      "name": "read",
      "summary": "/Users/chenlong/hundsun/af-workspace-demo/uumail/Sources/SyncEngine/SyncEngine.s…",
      "status": "completed",
      "durationMs": 19,
      "endedAgeMs": 10411
    }
  ],
  "text": {
    "kind": "thought",
    "ageMs": 1422,
    "tail": "…der? Let's check code. Also, `visibleMessages` computed. Not critical.  Let me check the architecture §2.5/§3/§4/§5 and roadmap. Also risks.",
    "truncated": true
  }
}
```

+100s：

```json
{
  "taskId": "01a1daa8-add5-72e8-acf5-739f264e3571",
  "attempt": 1,
  "executionId": "<uuid>",
  "seq": 20,
  "phase": "prompting",
  "elapsedMs": 100000,
  "lastEventAgeMs": 16679,
  "events": 151,
  "usage": {
    "used": 117100,
    "size": 1000000
  },
  "activity": [
    {
      "id": "bV6819",
      "name": "bash",
      "summary": "ls -la /Users/chenlong/hundsun/af-workspace-demo/task-spaces/20261114-232232",
      "status": "completed",
      "durationMs": 49,
      "endedAgeMs": 16679
    },
    {
      "id": "WT2245",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && echo \"modified:\" && git s…",
      "status": "completed",
      "durationMs": 113,
      "endedAgeMs": 21138
    },
    {
      "id": "j56508",
      "name": "edit",
      "summary": "/Users/chenlong/hundsun/af-workspace-demo/uumail/doc/design/components/CMP-SYNC/…",
      "status": "completed",
      "durationMs": 19,
      "endedAgeMs": 28302
    },
    {
      "id": "Sl7890",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && grep -n \"resetCollection.…",
      "status": "completed",
      "durationMs": 53,
      "endedAgeMs": 30361
    },
    {
      "id": "Vo2237",
      "name": "bash",
      "summary": "cd /Users/chenlong/hundsun/af-workspace-demo/uumail && sed -n '95p' doc/plan/roa…",
      "status": "completed",
      "durationMs": 56,
      "endedAgeMs": 31835
    },
    {
      "id": "5i5132",
      "name": "edit",
      "summary": "/Users/chenlong/hundsun/af-workspace-demo/uumail/doc/plan/roadmap.md",
      "status": "completed",
      "durationMs": 19,
      "endedAgeMs": 33082
    },
    {
      "id": "yr4080",
      "name": "read",
      "summary": "/Users/chenlong/hundsun/af-workspace-demo/uumail/doc/plan/roadmap.md",
      "status": "completed",
      "durationMs": 9,
      "endedAgeMs": 34455
    },
    {
      "id": "Rj1465",
      "name": "edit",
      "summary": "/Users/chenlong/hundsun/af-workspace-demo/uumail/doc/plan/roadmap.md",
      "status": "completed",
      "durationMs": 9,
      "endedAgeMs": 35596
    }
  ],
  "text": {
    "kind": "thought",
    "ageMs": 16728,
    "tail": "…ion symbols.  Now write design.md. Need read existing? It doesn't exist in this run. `write` can create; no need read (didn't exist). Check.",
    "truncated": true
  }
}
```

对应 UI：

```text
方案 · 运行中
模型处理中 · 最近活动 1.3 秒前 · 上下文 80.8k / 1M

最新思考（截断）
「…Let me check the architecture §2.5/§3/§4/§5 and roadmap. Also risks.」

最近动作
15:24:39  bash  sed -n '80,120p' doc/plan/roadmap.md          0.03s
15:24:39  bash  sed -n '170,240p' doc/design/architecture.md   0.06s
15:24:38  bash  sed -n '1,190p' doc/design/components/…/spec.md 0.02s
15:24:29  read  …/doc/requirements/REQ-0013-dwell-…md          0.02s
```

+100s 时：

```text
方案 · 运行中
模型处理中 · 最近活动 16.7 秒前 · 上下文 117k / 1M

最新思考（截断）
「…Now write design.md. Need read existing? It doesn't exist in this run.」

最近动作
15:25:22  edit  …/doc/design/components/CMP-SYNC/spec.md  0.02s
15:25:20  bash  grep -n "EASAdapter.*测试依赖" …            0.05s
15:25:18  bash  head -5; echo "(exit $?)" …                 0.11s
```

这才回答"具体做了什么"：在改哪个文件、刚查了什么命令、模型下一步准备做什么。

## 5. 结论与载荷修订

1. **只报"当前工具"不够**：59 个工具全部 <5s，5s 快照抓不到；必须报"最近动作列表"（`activity`），而不是单一 `tool`。
2. **只报"助手正文"也不够**：这个任务 0 条 `agent_message_chunk`，叙事全在 `thought`；要支持 `text.kind=thought`（可配置关闭）。
3. **"最近活动"与"上报停更"要分开**：+100s 时 ACP 事件停了 16.7s，但 client 仍在每 5s 心跳；UI 应显示"最近活动 16.7s 前"，而"停更"只看服务端 `receivedAt`，不能用 `lastEventAgeMs` 判停。
4. **prompt 不必进载荷**：UI 已知节点名（本案"方案"）与 run 上下文；要补任务说明，应由调度器在 run detail 里暴露 `promptHead`（一次），不需要每 5s 回传 prompt。真正缺的是"最近动作 + 最新叙述"。

修订后的载荷（v2）：

```json
{
  "taskId": "…", "attempt": 1, "executionId": "…", "seq": 6,
  "phase": "prompting",
  "elapsedMs": 30000, "lastEventAgeMs": 1335, "events": 86,
  "activity": [
    { "id": "…", "name": "bash", "summary": "sed -n '80,120p' doc/plan/roadmap.md",
      "status": "completed", "durationMs": 31, "endedAgeMs": 1335 }
  ],
  "text": { "kind": "thought", "ageMs": 1422, "tail": "…Let me check ...", "truncated": true },
  "usage": { "used": 80780, "size": 1000000 }
}
```

- `activity` 必选、最多 8 条；`text` 可选、≤200 字节、默认开（可配置关）。
- 仍然**不含**：完整 prompt、最终消息全文、工具输出、完整思考；只有摘要/尾部。
- 载荷估算：8×~120B + 200B + 基础字段 ≈ 1.4KB，仍低于 8 KiB 上限。
- 需要重新确认原设计 C4：是否接受"思考尾部"进载荷（默认开/关）；其余 C1–C3、C5–C6 不变。

## 6. 复现

```bash
# 抓取当前在跑任务的会话日志（client 运行中）
cp .agent-flow-client/orchaster-stub/state/session-logs/<taskId>-a1.jsonl /tmp/task.jsonl
# 按 5s tick 聚合 tool_call/tool_call_update/usage_update/thought，重建 v1/v2 载荷
```

本文件的数据来自 2026-11-14 15:24:10–15:26:29Z 的快照；n3 随后继续运行到 15:30:17Z，结论只针对该窗口。
