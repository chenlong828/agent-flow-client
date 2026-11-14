---
layer: works
module: global
status: active
updated: 2026-11-14
---

# 工序：任务执行过程的信息反馈调研（ACP 侧）

> 来源：2026-11-14 用户反馈——任务执行过程中展示信息严重滞后，"不知道当前在干什么，跑完了才知道"。
> 定级：**P2**（只调研、不改代码；结论若落地会触及调度器契约 `executor-http-v3` 与跨边界观测面，需另行定级）。
> 本轮产出：调研报告（`report.md`）+ 可复现探针（`probe/`），不改 `src/`、不改契约、不改 UI。

## 1 问题

调度器 UI 的节点详情在任务执行期间只有"已下发"与"完成"两个可见状态：没有当前阶段、当前工具、最近活动时间，也没有任何模型输出。用户无法区分"在正常长工具调用"、"在思考"与"卡死"，只能等结果回来。

## 2 调研问题

1. ACP/DSH 侧实际会推送哪些过程信息？字段、粒度、时机分别是什么？
2. client 当前收到后做了什么？哪些信息被丢弃、延迟或私有化？
3. 跨边界（client → 调度器 → UI）为什么只剩开始/结束？是契约限制、设计取舍还是实现缺口？
4. 在不破坏现有契约与安全边界的前提下，可以多展示什么？代价与风险如何？

## 3 非目标

- 不改 `src/`、不改 `docs/design/`、不改调度器契约与 UI。
- 不实现观测 HTTP（该方向已有 P1 设计稿 `docs/works/2026-11-06-observability-http/`）。
- 不评价模型输出质量，只讨论过程信息的可见性。

## 4 方法

| 证据源 | 用途 |
|---|---|
| client 代码走查（`src/components/runtime`、`executor`、`cli`、`gateway`、`store`） | 确认收到什么、丢弃什么、上报什么 |
| DSH 源码 `packages/acp/acp` 与 ACP SDK schema | 确认 agent 侧实际发送的 update 类型、字段与粒度 |
| 真机探针（2026-11-14，`hs-deepseek-flash-latest`） | 量化事件到达时刻，验证"工具级实时、文本级滞后" |
| `executor-http-v3` 契约 + 调度器 `executor-request.ts` + UI `instance-detail.js` | 确认跨边界与展示面的硬限制 |

## 5 任务表

| ID | 类型 | 组件 | 内容 | 状态 |
|---|---|---|---|---|
| T-01 | 调研 | CMP-runtime / 上游 DSH | ACP 过程信息清单与粒度 | 完成 |
| T-02 | 调研 | CMP-executor / CMP-cli / CMP-store | client 内部消费、落盘与上报断点 | 完成 |
| T-03 | 调研 | CMP-gateway / 调度器契约 | poll/result/session-log 能承载的字段边界 | 完成 |
| T-04 | 实验 | probe | 真机捕获事件时序与字段 | 完成 |
| T-05 | 文档 | works | 方案对比、建议路线与未决问题 | 完成 |
| T-06 | 设计 | 跨 client/调度器 | 用户确认 5s + 模式 C 后的设计分析（P1） | 完成（待确认 C1–C6） |

## 6 验收标准

1. 能逐跳说明一条 ACP 过程信息在 client 内被如何处理、在哪个文件哪一行被丢弃或延迟。
2. 给出 ACP 能提供/不能提供的完整信息清单，并有真机时间线支撑。
3. 至少给出 3 条可选方案，标明契约改动、实现面、实时性与风险。
4. 明确"不改契约即可做"与"必须改契约"的分界，以及需要用户/调度层拍板的开放问题。

## 7 结论落点

调研结论在 [`report.md`](report.md)，探针与原始捕获在 [`probe/`](probe/)。方案确认后另立实现工序，回填 `docs/design/architecture.md`、`CMP-runtime`、`CMP-observability` 与调度器契约。
