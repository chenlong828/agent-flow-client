---
name: doc-layout-spec
description: 要新建或改动文档树内的任何文件（需求卡、组件规格、场景、工序 brief/result、归档件）之前，用它定位归属与状态；也为新项目建目录、核对既有文档树、决定归档去向时用。需求怎么拆归 req-scenario-spec，文档内容怎么写不归它管。
---

# 文档布局：五态分离与对象生命周期

文档腐化的根源通常不是写得差，而是没有结构：需求、意图、真相、过程、历史堆在同一层，靠记忆和索引表维持秩序——索引先分叉，然后一切跟着腐化。本规范**既是放置规则**（一份新文档该去哪），**也是识别规则**（一棵既有文档树如何归类）：符合规范的文档树，凭路径与 frontmatter 即可推导每份文档的状态与对象，不依赖登记表。

产物怎么产出遵循各自的 skill：需求、场景与任务拆分归 req-scenario-spec，架构规格归 arch-design-spec，组件设计归 design-before-coding，执行与验收归 dev-execution-spec；本规范只决定这些产物的存放位置与生命周期。

## 文档根：五态分离

| 目录 | 状态 | 只回答的问题 | 纪律 |
|---|---|---|---|
| `requirements/` | 需求 | 为什么做 | 一卡一文件，编号稳定 |
| `plan/` | 调度 | 接下来做什么 | 只放全局意图，三份固定文档 |
| `design/` | 现行真相 | 系统现在是什么 | 唯一权威，只写现行内容 |
| `works/` | 执行 | 正在做什么 | 一级只有工序目录 |
| `history/` | 记忆 | 怎么走到这里的 | 冻结只读 |

- **位置即状态**：处于哪一态由路径表达，不靠登记表。
- **反占位**：目录与文件在内容诞生时创建，不预留空文件、不预留索引行。
- 导航页 `README.md` 只写阅读顺序与入口，不维护逐文件状态表。
- 本规范以 skill 形式存在，不在文档树内。

## requirements/：需求卡

- 一个需求一个文件：`REQ-0001-<slug>.md`；编号稳定不复用。
- 只放卡，不放方案；怎么拆需求、怎么找场景归 req-scenario-spec。
- 状态：`draft / accepted / delivered / superseded / dropped`。
- `delivered` 留在原地（回答“为什么有它”）；`dropped`、`superseded` 移入 `history/requirements/`。
- 需求卡不写优先级与排期；排期唯一在 `plan/roadmap.md`。

## design/：真相

一级固定三类：

1. `architecture.md`：系统层（进程/服务拓扑、技术基线、跨模块机制）。
2. `components/<id>/spec.md`：一个组件一个目录。组件 = 有行为、有契约、有独立验证入口的最小单元。
3. `scenarios/<domain>/<flow>/<scenario>/scenario.md`：业务功能树，深度固定三层；加层走 req-scenario-spec 的门。

- 场景目录只写运行序、引用与测试；契约细节在组件规格，不复制。
- `design/scenarios/_index.md` 是生成物：标 `generated: true`，不手改，CI 校验“重新生成无 diff”。
- 场景 `deprecated` → `history/scenarios/`；组件 `retired` → `history/components/`。
- 现行文档不得把归档件当设计依据。

## plan/：三份固定文档

一级只放三个固定主题，不建子目录、不按模块分：

- `roadmap.md`：里程碑、工序与依赖；
- `risks.md`：风险与缓解；
- `open-questions.md`：跨工序开放问题。

## works/：工序工作区

一级只有工序目录，目录名即工序 ID：`YYYY-MM-DD-<短名>`，归档不改名。

- `brief.md`（必须）：需求、背景、验收标准、任务表（ID/类型/组件/状态/装载清单）、领取的开放问题。
- 过程文件自由命名，只准放本目录；代码产物归代码目录。
- `result.md`（必须）：验收结果 + 结论落点表。
- `review.md`（P1/P2 工序）：评审与四档裁决记录，格式与档位定义见 `arch-design-spec` 第 8 步；收口随目录归档。它是工作记忆不是现行真相，结论分别落 `history/decisions/` 与 `design/components/*/spec.md`。
- 生命周期：立项 → 执行 → 收口 → 归档（整目录移入 `history/works/`，frontmatter 改 frozen）。收口是归档前置条件。

## history/：记忆

一级固定去处：

- `decisions/`：整篇决策；轻量决策放 `decisions/adr/`。
- `works/`：已归档工序。
- `requirements/`：被取代或放弃的需求卡。
- `scenarios/`、`components/`：废弃场景与退役组件。
- `pitfalls.md`：坑档案（现象、存续条件、对策落点）。

`history/` 冻结只读；唯一例外是坑档案允许更新存续状态。

## 状态表达：frontmatter

每份文档带 frontmatter：

```yaml
---
layer: design
module: drawer        # 所属领域/模块；global 表示跨模块
status: current
updated: 2026-10-23
---
```

状态值按对象固定：

| 对象 | 合法值 |
|---|---|
| requirements 卡 | draft / accepted / delivered / superseded / dropped |
| plan 文档 | draft / current |
| 组件规格 | planned / active / retired |
| 场景 | draft / designed / verified / deprecated |
| works | active / closed |
| history | frozen |

- layer 与目录位置必须一致；module 与所属领域一致。
- 组件规格另带 `component: CMP-xxx`；场景另带 `flow:` 与 `scenario: SCN-xxxx`。
- 必写不省略，保证可直接检索盘点。

## 违规信号

- 需求卡里写了拆分方案或验收测试。
- 场景文档复制了组件契约内容。
- 手改 `_index.md` 或其他生成物。
- 同一事实需要同步改多份文档。
- 现行文档引用归档件作为依据。
- 路径与 frontmatter 的 layer/status 矛盾。
- 组件规格缺数据所有权、预算或单独运行命令。

## 与 req-scenario-spec 的边界

本 skill 不定义需求、场景、任务怎么拆；只定义它们的位置、frontmatter 与归档方式。发现“怎么拆”的规则进了本规范，移到 req-scenario-spec。
