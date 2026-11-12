---
layer: design
module: execution-plane
component: CMP-store
status: active
updated: 2026-11-12
---

# CMP-store 组件规格（v2）

> 状态：`active`。本地恢复事实的唯一边界：任务 journal、孤儿进程记录。v2 删除实例锁与清理回执。

## 1. 职责与边界

- **负责**：`journal.jsonl` 追加/折叠；`settled()` 查询；孤儿进程记录；损坏行降级；v3 起持久化 `P-04` 会话日志原始行（`FileSessionLogStore`）。
- **不负责**：恢复决策、调度器状态、工作区内容、日志轮转。
- **变化轴**：本地持久化格式。

## 2. 目录与记录

```text
<stateRoot>/
├── journal.jsonl       # 一行一条 TaskRecord，v=2
├── session-logs/<taskId>-a<attempt>.jsonl  # P-04 原始 ACP 事件（上传成功后清理）
├── archives/<runId>.tar.gz                 # P-05 打包临时文件（上传后删除）
└── orphans/<pid>.json
```

```ts
type TaskRecord = {
  v: 2;
  ts: string;
  taskId: string;
  attempt: number;
  instanceId: string;
  nodeId: string;
  state: "received" | "running" | "settled" | "reported";
  sessionId?: string;
  result?: TaskResult;
};
```

- `append`：追加；`settled` 时 `fsync`。
- `mark(taskId, state, patch)`：追加新记录，不原地改。
- `settled()`：折叠后返回 `state=settled` 且带结果的记录（进 `finished[]`）。
- 损坏行与 `v=1` 记录跳过。
- 孤儿：`recordOrphan` / `listOrphans` / `clearOrphan`；不含凭据/提示词/输出。

## 3. 契约

实现 `JournalPort`：`append`、`mark`、`settled`、`recordOrphan`、`listOrphans`、`clearOrphan`。

- 不变量：追加不覆盖；状态可重建；结果先落盘；孤儿清理幂等。
- 删除：实例锁（v2 允许同实例多任务）、journal 压缩、多态状态机、清理回执。
- 错误：`io_error`；损坏降级跳过。

## 4. 验证

`tests/components/store/journal.test.ts`、`orphans.test.ts`、`admin.test.ts`。

## 5. 开放问题

- journal 保留窗口（OQ-021）；v2 无压缩，长期运行需运维轮转。
