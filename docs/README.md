# 文档导航

本目录按「五态分离」组织：**位置即状态**。分层规则见 `.agents/skills/doc-layout-spec`（技能不在文档树内）。

## 当前实际存在的结构

```
docs/
├── README.md
├── requirements/                           ← 需求：为什么做
│   ├── REQ-0001-acp-dsh-home-config.md
│   └── REQ-0002-execution-reliability.md
├── plan/                                   ← 调度：接下来做什么
│   ├── roadmap.md
│   ├── risks.md
│   └── open-questions.md
├── design/                                 ← 真相：系统现在是什么
│   ├── architecture.md                     ← 系统层：组件、依赖、契约、主流程
│   ├── contracts/
│   │   ├── executor-http-v3.md             ← 调度器执行面契约 v3（五端点、task-space、日志、归档）
│   │   └── client-observability-v1.md      ← client 只读观测面 v1（O-01–O-11）
│   ├── test-matrix.md                      ← SCN UC → 测试文件映射
│   ├── components/                         ← 组件规格（9 份，planned）
│   │   ├── CMP-cli/spec.md
│   │   ├── CMP-executor/spec.md
│   │   ├── CMP-result/spec.md
│   │   ├── CMP-gateway/spec.md
│   │   ├── CMP-runtime/spec.md
│   │   ├── CMP-workspace/spec.md
│   │   ├── CMP-assets/spec.md
│   │   ├── CMP-store/spec.md
│   │   ├── CMP-signal/spec.md
│   │   ├── CMP-observability/spec.md
│   │   └── CMP-observer/spec.md
│   └── scenarios/                          ← 业务场景
│       ├── _index.md                       ← 生成物：场景索引
│       └── execution-plane/
│           ├── run-preparation/
│           │   └── configure-and-self-check/
│           │       └── scenario.md         ← SCN-0002 配置 client 并完成自检
│           └── node-execution/
│               └── execute-node-and-report/
│                   └── scenario.md         ← SCN-0001 执行节点并回传结果
├── works/                                  ← 执行：正在做什么
│   ├── 2026-11-03-s0-acp-verification/     ← S0 P0 阻断项验证（已收口）
│   │   ├── brief.md
│   │   ├── result.md
│   │   ├── harness/                        ← 一键验证套件
│   │   └── runs/                           ← 逐项证据与日志
│   ├── 2026-11-03-acp-session-records/      ← 会话记录与跨 profile 可见性调研（已收口）
│   │   ├── brief.md
│   │   ├── result.md
│   │   └── probe/                          ← 空会话探针
│   ├── 2026-11-10-execution-semantics-proposal/ ← 执行容错语义提议（待调度层评审）
│   │   ├── brief.md
│   │   └── proposal.md
│   ├── 2026-11-06-observability-http/      ← 只读观测面 v1（已实现 O-01–O-11，待归档）
│   │   ├── brief.md
│   │   ├── proposal.md                     ← /api/v1/observability：日志、SSE、DSH session 归档
│   │   ├── review.md                       ← 调度器附评 OB-01～OB-09 处置
│   │   └── result.md
│   ├── 2026-11-12-contract-v3-handoff/     ← 执行面契约 v3 交接与实现（进行中）
│   │   ├── brief.md
│   │   ├── executor-http-v3.md             ← 2026-11-12 交接快照（§4.1 #3 已由 W-01 修订）
│   │   ├── contract-diff.md
│   │   ├── response.md                     ← 调度器侧对 client 评审的回复
│   │   └── review.md                       ← client 评审与两轮确认
│   ├── 2026-11-12-client-self-enroll/      ← 开发期 X-Client-Id 自报身份（P2，收口）
│   │   ├── brief.md
│   │   ├── review.md
│   │   └── result.md
│   ├── 2026-11-12-skill-multi-package/     ← 多技能包安装布局 OQ-33（P2，收口）
│   │   ├── brief.md
│   │   ├── review.md
│   │   └── result.md
│   ├── 2026-11-12-skill-name-proposal/     ← 技能展示名/系统名分离提案（交调度层）
│   │   ├── brief.md
│   │   └── proposal.md
│   ├── 2026-11-14-superproject-workspace/  ← 工作区根支持 git 超项目（P2，收口）
│   │   ├── brief.md
│   │   ├── review.md
│   │   └── result.md
│   ├── 2026-11-18-session-text/            ← 会话思考与消息全文读取契约（设计，待确认）
│   │   ├── brief.md
│   │   └── proposal.md
│   ├── 2026-11-18-mcp-signal-feedback/     ← review verdict 走 MCP 的澄清与反馈（P1，提案已定稿）
│   │   ├── brief.md
│   │   ├── review.md
│   │   └── probe/                          ← DSH MCP 最小实测脚本与证据
│   ├── 2026-11-18-mcp-signal-impl/         ← MCP 结果信号实现（P1，已落地）
│   │   ├── brief.md
│   │   ├── result.md
│   │   └── contract-diff.md                ← 给调度面的增量契约与验证清单
│   └── 2026-11-19-confirm-channel-client/  ← review 应急确认 client 侧（P2，联调通过，收口）
│       ├── brief.md
│       ├── review.md
│       ├── result.md
│       └── probe/                          ← 真实 DSH 双工具端到端脚本
└── history/                                ← 记忆：怎么走到这里的
    ├── works/                              ← 已归档工序（frozen）
    │   ├── 2026-11-10-execution-semantics-proposal/ ← 执行容错语义提议（已被 v2 取代）
    │   ├── 2026-11-10-contract-v2-migration/ ← 执行面契约 v2 迁移（已收口）
    │   │   ├── brief.md
    │   │   ├── result.md
    │   │   └── executor-http-v1.md         ← v1 归档
    │   ├── 2026-11-12-contract-v3-handoff/ ← 执行面契约 v3 交接（v2 已先归档于此）
    │   │   └── executor-http-v2.md         ← v2 归档
    │   ├── 2026-11-09-s2-linear-and-recovery/ ← S2 线性多节点与恢复（已收口）
    │   │   ├── brief.md
    │   │   └── result.md
    │   ├── 2026-11-08-s1-contract-skeleton/ ← S1 契约骨架（已收口）
    │   │   ├── brief.md
    │   │   └── result.md
    │   ├── 2026-11-08-s0-local-loop/       ← S0 本地执行闭环（已收口）
    │   │   ├── brief.md
    │   │   └── result.md
    │   ├── 2026-11-03-dsh-acp-preflight/   ← DSH ACP 对接预研
    │   │   ├── brief.md
    │   │   ├── result.md
    │   │   └── probe/                      ← 可复现探针与用法
    │   ├── 2026-11-03-client-concept-design/ ← 客户端概念设计（已冻结）
    │   │   ├── brief.md
    │   │   ├── design.md
    │   │   └── result.md
    │   ├── 2026-11-04-scheduler-contract-proposal/ ← 调度器契约提案（审核通过，v0.4 已归档）
    │   │   ├── brief.md
    │   │   ├── proposal.md                   ← 7 契约面、SCH/CLT、ND/OB 处置
    │   │   ├── review.md                     ← 两轮评审收口为「通过」
    │   │   └── result.md
    │   ├── 2026-11-07-m1-contract-freeze/    ← M1 契约冻结（冻结落盘 + 设计评审收口，已归档）
    │   │   ├── brief.md
    │   │   ├── freeze-checklist.md           ← 提案 §13 逐行落点 + AB/AD/AH 清单
    │   │   ├── review.md                     ← AB/AD/AH/NB/ND2 处置
    │   │   └── result.md
    │   ├── 2026-11-14-acp-progress-feedback/ ← 任务执行过程信息反馈调研（ACP 侧，已归档；2026-11-17 收口：5s 暂停，改拉取）
    │   │   ├── brief.md
    │   │   ├── result.md
    │   │   ├── report.md
    │   │   ├── design-progress-5s.md
    │   │   ├── sim-progress-live.md
    │   │   └── probe/
    │   ├── 2026-11-17-progress-feedback-closeout/ ← 执行过程可见性收口（已归档）
    │   │   ├── brief.md
    │   │   ├── review.md
    │   │   └── result.md
    │   └── 2026-11-17-observability-hardening/ ← 观测面发布门禁加固（已归档）
    │       ├── brief.md
    │       └── result.md
    └── decisions/
        ├── 2026-11-03-bootstrap.md
        ├── 2026-11-03-system-bun.md
        ├── 2026-11-03-client-concept.md
        └── 2026-11-17-execution-visibility-pull.md ← 5s 模式 C 暂停，改消费方拉取
```

组件规格随 S0 任务落地从 `planned` 转 `active`；`design/scenarios/_index.md` 由 `bun run docs:index` 生成，`bun run docs:check` 校验，不手改。

## 阅读顺序

1. `requirements/`：为什么做；
2. `plan/roadmap.md`：接下来做什么；
3. `design/architecture.md`：系统层组件、依赖、契约与主流程；
4. `design/contracts/`：字段级契约（当前为 `executor-http-v3.md`）；
5. `design/components/`：逐组件规格（职责、内部功能、契约、数据、验证）；
6. `design/scenarios/`：业务场景与验收；
7. `works/` 最近的工序：正在做什么、验证过什么；
8. `plan/open-questions.md`、`plan/risks.md`：未决与风险；
9. `history/decisions/`：为什么这样开始。

## 上游依据

调度器侧的边界与职责设计：`../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/`。
