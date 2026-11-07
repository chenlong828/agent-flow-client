---
layer: design
module: execution-plane
component: CMP-observability
status: active
updated: 2026-11-04
---

# CMP-observability 组件规格

> 状态：`active`（2026-11-08，T2 落地）。结构化日志、脱敏、文件 sink/轮转与 `doctor` 聚合渲染已实现；进度事件未实现。
>
> 上游：`docs/design/architecture.md` §3.2、§7、§10；`SCN-0002`；`REQ-0002` R-09/R-10；日志字段与脱敏要求。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L0 横切工具。
- **业务价值**：一个失败节点能从本地日志定位到阶段与原因；`doctor` 给出可判定结论。没有它，失败只剩一句 `exit 1`。
- **负责 X**：
  - 结构化日志（关联键 instance/node/attempt/session）；
  - 日志级别、sink、轮转；
  - 脱敏（凭据、prompt/结果内容）；
  - `doctor` 报告渲染与退出码聚合；
  - 可选进度事件（本地，不跨边界）。
- **不负责 Y**：
  - 跨边界上传日志/全文；
  - 业务判定；
  - 各组件检查逻辑（由组件 `diagnose()` 提供，CLI 收集）；
  - 进程/文件/网络。
- **变化轴**：观测需求（字段、sink、轮转、脱敏规则）。
- **删除测试**：删掉后失败节点无法定位——真边界（可观测性不是装饰）。

## 2. 内部功能

### 2.1 日志

```ts
type LogLevel = "debug" | "info" | "warn" | "error";

type LogRecord = {
  ts: string;
  level: LogLevel;
  event: string;
  msg?: string;
  pid?: number;
  instanceId?: string;
  nodeId?: string;
  attemptId?: string;
  sessionId?: string;
  phase?: string;
  errorClass?: string;
  code?: string;
  retryable?: boolean;
  durationMs?: number;
};
```

- sink：
  - `stderr`：始终开启；`run` 的 stdout 只放 `NodeResult`，日志不得混入；
  - 文件：`<stateRoot>/logs/client.jsonl`，可配置开启；按大小轮转（默认 10MB，保留 5 份）。
- 关联键：`instanceId` / `nodeId` / `attemptId` / `sessionId` 能带则带；阶段用 `phase`（`claimed`/`bound`/`ready`/`running`/`settled`/`reported`/`closed`/`abandoned`）。
- 关键事件：配置生效、注册/心跳状态、领取、session 建立/关闭、技能安装、prompt 开始/结算、取消/超时、上报、恢复清理、doctor 结论。
- 失败日志必须有 `code` / `errorClass` / `retryable`（能判定时）；无阈值不写性能断言。

### 2.2 脱敏

- 键名匹配（大小写不敏感）：`authorization`、`cookie`、`set-cookie`、`token`、`secret`、`password`、`passwd`、`api[-_]?key`、`credential`、`private[-_]?key` → 值替换为 `[redacted]`。
- `prompt` / `finalText` / `message`：只记录字节长度、是否截断、摘要 hash；不记录原文。
- 错误消息：保留可读部分；命中凭据模式的值替换。
- 路径：允许记录（排障需要）；不记录文件内容。
- 生效配置输出：只显示 home 路径与来源；凭据只显示“已配置/未配置”。

### 2.3 `doctor` 渲染

```ts
type CheckStatus = "pass" | "warn" | "fail" | "none";

type CheckResult = {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  remediation?: string;
};

type DoctorReport = {
  checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number; none: number };
  exitCode: number;
};
```

- 检查项由组件提供：`config.*`（CLI）、`dsh.*` / `session.*`（runtime）、`workspace.*`（workspace）、`state.*`（store）、`scheduler.*`（gateway，S1）。
- 渲染：
  - human：表格 `[PASS] id title detail`；失败项附 remediation；
  - `--json`：稳定 JSON（不混日志）。
- 退出码聚合：配置 2 > 版本/鉴权 3 > 运行时 4 > 工作区/资产 5；全部 pass/warn → 0。`none` 不阻塞，但必须写原因（例如 S0 无调度器）。
- `doctor` 不启动执行、不注册调度器、不改配置。

### 2.4 进度事件（可选）

- `progress(event)`：本地回调/日志，不跨边界、不影响主流程。
- 关闭时为空操作；不得因进度失败影响执行。

## 3. 契约

### 3.1 `Logger`

```ts
interface Logger {
  log(record: Omit<LogRecord, "ts" | "pid">): void;
  child(bindings: Partial<Pick<LogRecord, "instanceId" | "nodeId" | "attemptId" | "sessionId" | "phase">>): Logger;
}
```

- **前置**：无。
- **后置**：日志写入 sink（或按级别丢弃）；不抛异常。
- **不变量**：
  1. 日志失败不影响主流程（吞掉并计数）。
  2. 日志不含凭据、prompt/结果原文。
  3. 关联键一旦绑定，子 logger 自动带出。
  4. `run` 的 stdout 不含日志。
- **错误模式**：无；sink 失败降级到 stderr 或丢弃，并计数告警。

### 3.2 `Doctor`

```ts
interface Doctor {
  collect(checks: CheckResult[]): DoctorReport;
  render(report: DoctorReport, format: "human" | "json"): string;
  exitCode(report: DoctorReport): number;
}
```

- `collect` 只聚合，不执行检查；检查由 CLI 调用各组件 `diagnose()`。
- `render` 纯函数；`json` 输出可被机器解析。
- `exitCode` 按 2 > 3 > 4 > 5 优先级；无 fail → 0。

### 3.3 前置/后置/不变量

- 前置：日志级别/sink/轮转配置已注入；`stateRoot` 可写（文件 sink 时）。
- 后置：`render` 返回完整报告；`exitCode` 与 fail 项一致。
- 不变量：脱敏规则先于写入；检查项幂等（同一状态重复 `doctor` 结果一致）；`none` 必须带原因。

## 4. 依赖与分层

- 依赖：标准库 `fs` / `path` / `crypto`（hash）；启动配置注入。
- 禁止边：不得 import `CMP-cli`、`CMP-executor`、任何 L0 具体实现；不得读 journal/工作区/调度器状态（检查由组件提供）。
- 被依赖：所有组件（日志）；`CMP-cli`（doctor 渲染）。扇入大，契约需稳定。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性/保留 |
|---|---|---|---|
| 日志文件 | `CMP-observability`（唯一写入口） | 排障/`doctor` | 本地；脱敏；轮转 |
| 日志 sink 配置 | `CMP-cli`（注入） | observability | 启动时冻结 |
| `doctor` 报告 | `CMP-cli` 持有；observability 渲染 | 操作者 | 不持久化 |

## 6. 冷热与资源

- 日志在热路径（心跳）与冷路径（执行）都会写：必须非阻塞/有界；sink 写失败不反压主流程。
- 文件 sink 独立于心跳定时器；轮转按大小，避免磁盘无界。
- `doctor` 是冷路径，不依赖网络（S0）。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| 字段 | 关键事件带 instance/node/attempt/session/phase | 字段完整性 |
| 脱敏 | 凭据键、token、prompt/结果原文 | 不出现原文；`[redacted]` |
| 级别 | debug/info/warn/error 过滤 | 输出符合级别 |
| 轮转 | 超过大小阈值 | 轮转、保留份数、不丢当前日志 |
| `doctor` | pass/warn/fail/none；human/json；退出码优先级 | 输出与退出码 |
| 隔离 | `run` stdout 只有 NodeResult | stdout 断言 |
| 失败 | sink 不可写 | 主流程不受影响；计数告警 |

## 8. 预算与单独运行

- 预算：目标 ≤15k token，上限 120k。
- 单独运行：`bun test tests/components/observability/`；临时日志目录。
- 实现入口（T2）：`src/components/observability/logger.ts#JsonLogger`/`redactRecord`、`doctor.ts#collect`/`render`/`exitCode`；测试 `tests/components/observability/`。
- 状态：`active`（进度事件未实现）。

## 9. 开放问题

- 日志保留/轮转默认值（OQ-005，M1）。
- 文件 sink 是否默认开启（当前提案：`serve` 开启，`run` 仅 stderr）。
- 脱敏是否覆盖模型输出中的疑似凭据（当前只覆盖日志字段与键名；结果透传）。
- `doctor` 检查项 ID 与退出码优先级需在 S0 固化。
