---
layer: design
module: execution-plane
component: CMP-workspace
status: planned
updated: 2026-11-04
---

# CMP-workspace 组件规格

> 状态：`planned`。工作区是节点间与产物的事实源；client 只校验、安装技能、清理，不 clone、不检出、不建仓库。
>
> 上游：`docs/design/architecture.md` §2、§7、§8；`SCN-0001` UC-05/08/28/29；`REQ-0002` R-07/R-10；决策 D7/D8/D11。

## 1. 职责与边界

- **单元 / 层 / 类型**：组件；L0 基础设施；技术边界（文件系统与路径约束）。
- **业务价值**：保证工作区单写、路径不越界、容器根即技能根；没有它，路径约束会散进 assets 与 runtime。
- **负责 X**：
  - 接收预置容器路径，校验布局；
  - 维护 `.dsh` 安装点与暂存目录；
  - 路径解析与容器内约束（拒绝越界、拒绝跟随越界符号链接）；
  - 清理与保留策略；
  - 工作区诊断（`doctor`）。
- **不负责 Y**：
  - 仓库 clone/检出/初始化（准备阶段完成）；
  - 技能包内容与安装（`CMP-assets`）；
  - 仓库内容语义、产物解析；
  - session/进程管理。
- **变化轴**：容器布局校验、清理策略、路径约束。
- **删除测试**：删掉后路径约束会散进 assets 与 runtime——真边界。

## 2. 内部功能

### 2.1 容器模型

```text
<containerRoot>/                 ← 容器根：技能根、session cwd；不在任何 git 仓库内
├── .dsh/
│   ├── skills/                  ← 当前节点技能集（由 assets 原子替换）
│   └── .staging/                ← 技能暂存（client 生成，可清理）
├── repo-a/ (.git)               ← 预置仓库（client 不 clone/检出）
└── repo-b/ (.git)
```

- 容器由准备阶段预置；`NodeRequest.workspacePath` 指向容器根。
- 容器根**不建** `.git`，且必须位于任何 git 仓库之外；否则 DSH 的 `projectRoot` 上浮，`.dsh/skills` 不可见。
- 子仓库可有 0..N 个，`.git` 可以是目录或文件（worktree）。
- `.dsh/skills` 由 `CMP-assets` 替换；workspace 只保证安装点存在且受路径约束。

### 2.2 `ensureContainer`

1. 路径必须是绝对路径、存在、是目录；否则 `not_prepared`。
2. `realpath` 解析；记录 root。
3. 检查可写（创建 `.dsh`/`.staging` 或 access W_OK）；失败 `permission_denied` / `disk_full`。
4. 先做只读布局校验（根无 `.git`、`findProjectRoot(root) === root`）；非法则**不创建任何目录**，返回 `layout_invalid`。
5. 创建 `<root>/.dsh` 与 `<root>/.dsh/.staging`（`0700`，幂等）。
6. 不创建 `.dsh/skills`、不创建仓库、不写仓库内容。
7. 返回 `ContainerPaths { root, skillRoot, stagingRoot }`。

### 2.3 `validate`

| 检查 | 失败码 |
|---|---|
| root 存在、目录、绝对路径 | `not_prepared` |
| root 不是文件、可读 | `layout_invalid` / `permission_denied` |
| root 没有 `.git` | `layout_invalid` |
| `findProjectRoot(root) === root`（向上无 `.git`） | `layout_invalid` |
| `.dsh` 不是符号链接；`.dsh` 在 root 内 | `layout_invalid` / `path_escape` |
| 子仓库不越界；不跟随越界符号链接 | `path_escape` |
| 磁盘可写 | `disk_full` |

`LayoutReport` 返回 `ok`、`root`、`repos`（含 `.git` 的子目录）、`issues`。`repos` 只用于诊断，不作为节点参数。

### 2.4 `resolve`

- `resolve(container, relPath, opts)`：`path.resolve(root, relPath)` → `realpath`（或对不存在的写目标解析父目录）→ 必须仍以 `root` 为前缀（按路径段比较，不做字符串前缀）。
- 拒绝 `..` 逃逸；拒绝符号链接指向容器外；允许进入子仓库。
- 越界返回 `path_escape`；不返回未经校验的路径。

### 2.5 `cleanup`

| 策略 | 行为 |
|---|---|
| `keep`（默认） | 不动容器；只清 client 临时文件（如有） |
| `clean-skills` | 删除 `.dsh/skills`、`.staging`、`.skills-digest`；保留 `.dsh` 目录 |
| `clean-client` | 在 `clean-skills` 基础上清 client 生成的临时目录；不删预置仓库与产物 |

- 幂等；不跟随符号链接删除；不删除子仓库内容。
- 清理失败记录并继续；不因清理失败覆盖节点结果。
- 实例结束/取消时由 CLI/executor 按配置策略调用。

### 2.6 诊断

`WorkspaceAdmin.diagnose(container?)`：

- 容器布局、`findProjectRoot`、`.dsh` 安装点、可写性；
- 路径穿越负例；
- 磁盘可用空间（报告，不设硬阈值）；
- 清理残留（`.staging`、旧 `.skills.previous`）。

## 3. 契约

### 3.1 实现 `WorkspacePort`

签名见 `CMP-executor` §3.4；本组件补充：

| 方法 | 语义 | 错误 |
|---|---|---|
| `ensureContainer` | 幂等；只建 `.dsh`/`.staging` | `not_prepared`、`permission_denied`、`disk_full` |
| `validate` | 纯检查；不修改文件系统 | `layout_invalid`、`path_escape` |
| `resolve` | 容器内路径解析 | `path_escape` |
| `cleanup` | 按策略清理；幂等 | 记录并返回 |

### 3.2 前置/后置/不变量

- 前置：`path` 是编排层下发的容器路径；`ContainerPaths` 来自 `ensureContainer`。
- 后置：`cleanup` 后不残留 client 生成的技能/暂存；预置仓库保持。
- 不变量：
  1. 工作区单写：client 只写 `.dsh` 下自己生成的内容，不改预置仓库。
  2. 容器根即技能根；session cwd 固定为 root。
  3. 所有路径限制在容器内；符号链接不得逃逸。
  4. `cleanup` 幂等；不删预置仓库。
  5. 不 clone、不检出、不建仓库。

### 3.3 错误模式

| 错误 | 触发 | 可重试 | 调用方应对 |
|---|---|---|---|
| `not_prepared` | 路径不存在/不是目录 | 否 | 节点失败（workspace） |
| `layout_invalid` | 根有 `.git`、projectRoot 上浮、`.dsh` 非法 | 否 | 节点失败（workspace） |
| `path_escape` | `..`/符号链接逃逸 | 否 | 拒绝访问；节点失败 |
| `permission_denied` | 不可写/不可读 | 否 | 节点失败（workspace） |
| `disk_full` | 写盘失败 | 否（同机） | 节点失败；调度器换实例 |

### 3.4 `WorkspaceAdmin`（L0 管理面）

```ts
interface WorkspaceAdmin {
  diagnose(target?: string | ContainerPaths): Promise<CheckResult[]>;
}
```

- 由 `CMP-cli` 在 `doctor` 时调用；`CMP-executor` 不依赖。
- `diagnose` 只读：不创建 `.dsh`，不修改容器；传字符串时按裸路径做布局检查。

## 4. 依赖与分层

- 依赖：`WorkspacePort` 类型、`CMP-observability`、标准库 `fs` / `path`。
- 禁止边：不得 import `CMP-cli`、`CMP-executor` 具体实现、`CMP-runtime`、`CMP-assets`、`CMP-gateway`；不得读写 journal/store。
- 组合根注入：容器路径、清理策略、日志器。

## 5. 数据所有权

| 数据 | 写入口 | 读方 | 一致性/保留 |
|---|---|---|---|
| 容器根 + 子仓库工作树 + 产物 | 预置阶段 + 模型/工具（经 DSH） | runtime、assets、executor、observability | 本地强一致；按策略保留，默认不删 |
| `.dsh` 安装点 / `.staging` | `CMP-workspace` | assets、executor | 幂等创建；清理可回收 |
| `.dsh/skills` | `CMP-assets`（唯一写入口） | runtime/DSH | 原子替换；workspace 只提供路径 |

## 6. 冷热与资源

- 冷路径：容器校验、清理、诊断；分钟级，不参与心跳热路径。
- 文件系统操作可能阻塞事件循环；大目录扫描/清理分片/异步，避免阻塞心跳（S0 实测）。
- 每容器独立；fan-out 分支共享同一容器，不做复制。

## 7. 验证计划

| 类型 | 用例 | 证明 |
|---|---|---|
| 布局 | 有/无仓库、根有 `.git`、根在外层仓库下、路径含空格/Unicode | `validate` 报告与错误码 |
| 路径 | `..`、绝对路径、符号链接逃逸、子仓库内合法路径 | `path_escape` 与放行 |
| 清理 | `keep`/`clean-skills`/`clean-client`；重复调用 | 预置仓库保留；幂等 |
| 并发 | 同容器多 session；跨实例容器 | 互不干扰；共享容器只读/技能单写 |
| 磁盘 | 只读目录、磁盘满（注入） | 明确错误，不破坏已有产物 |
| 诊断 | 非法容器、残留 staging | `doctor` 检查项 |

## 8. 预算与单独运行

- 预算：目标 ≤20k token，上限 120k。
- 单独运行：`bun test tests/components/workspace/`（落地后创建）；用临时目录夹具，不启动 DSH。
- 状态：`planned`；无入口符号。

## 9. 开放问题

- 清理策略默认值与保留时长（OQ-005）。
- 容器根位于外层仓库下的处理：拒绝还是告警？当前拒绝（`layout_invalid`）。
- 大目录清理是否分片/后台化，需 S0 实测。
- 磁盘空间阈值与低空间行为（M1）。
