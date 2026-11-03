# 文档导航

本目录按「五态分离」组织：**位置即状态**。分层规则见 `.agents/skills/doc-layout-spec`（技能不在文档树内）。

## 当前实际存在的结构

```
docs/
├── README.md
├── plan/                                   ← 调度：接下来做什么
│   ├── roadmap.md
│   ├── risks.md
│   └── open-questions.md
├── design/                                 ← 真相：系统现在是什么
│   └── architecture.md
├── works/                                  ← 执行：正在做什么
│   ├── 2026-11-03-s0-acp-verification/     ← S0 P0 阻断项验证（已收口）
│   │   ├── brief.md
│   │   ├── result.md
│   │   ├── harness/                        ← 一键验证套件
│   │   └── runs/                           ← 逐项证据与日志
│   └── 2026-11-03-acp-session-records/      ← 会话记录与跨 profile 可见性调研（已收口）
│       ├── brief.md
│       ├── result.md
│       └── probe/                          ← 空会话探针
└── history/                                ← 记忆：怎么走到这里的
    ├── works/                              ← 已归档工序（frozen）
    │   ├── 2026-11-03-dsh-acp-preflight/   ← DSH ACP 对接预研
    │   │   ├── brief.md
    │   │   ├── result.md
    │   │   └── probe/                      ← 可复现探针与用法
    │   └── 2026-11-03-client-concept-design/ ← 客户端概念设计（已冻结）
    │       ├── brief.md
    │       ├── design.md
    │       └── result.md
    └── decisions/
        ├── 2026-11-03-bootstrap.md
        ├── 2026-11-03-system-bun.md
        └── 2026-11-03-client-concept.md
```

`requirements/`、`design/components/`、`design/scenarios/` 在出现第一份内容时创建，不预建空目录。

## 阅读顺序

1. `plan/roadmap.md`：接下来做什么；
2. `design/architecture.md`：现在是什么；
3. `works/` 最近的工序：正在做什么、验证过什么；
4. `plan/open-questions.md`、`plan/risks.md`：未决与风险；
5. `history/decisions/`：为什么这样开始。

## 上游依据

调度器侧的边界与职责设计：`../../agent-flow-orchaster/docs/works/2026-11-03-client-boundary/`。
