---
layer: works
module: global
status: active
updated: 2026-11-12
---

# 提案：技能增加系统标识，分离「展示名」与「DSH 技能名」

> 交付对象：`agent-flow-orchaster`（调度层）。
> 触发：2026-11-12 20:35 的实测，`OQ-17`（304）修复后，带技能包的 run 卡在 `invalid_skill_format`。
> 本提案只描述要做成什么样，具体字段命名、回填策略与级别由调度层按 `arch-design-spec` 定级后确认。

## 0 结论

`skill.name` 目前同时承担「中文展示名」和「DSH 技能标识」两种职责，二者要求冲突：前者要给人读，后者必须是 kebab-case。建议新增一个字段承载系统标识（下文暂称 `slug`，也可沿用你的 `skill_name`），原 `name` 继续做展示名；生成 `SKILL.md` 时把 `slug` 写进 frontmatter 的 `name`。

这样做之后：中文展示名保留在调度层/UI，DSH 与客户端拿到的始终是合法标识，**客户端和 DSH 都不需要改**。

## 1 问题链（实测）

1. 建技能时 `name` 填 `工作流初始化`；服务端只校验非空，允许保存并生成包（[`package.ts`](../../../../agent-flow-orchaster/src/components/skill/package.ts) 的 `buildSkillMarkdown`：`if (input.name.trim() === "") throw`）。
2. 任务下发 `skillSet.packages[].name = "工作流初始化"`，包内 `SKILL.md` frontmatter 为：

   ```yaml
   name: "工作流初始化"
   description: "作为一个工作流初始化Skill，…"
   version: "v1.0"
   ```

3. 客户端下载成功（304 已修）、解包成功，安装前格式校验按 DSH 规则拒绝：

   ```
   invalid_skill_format: 技能 name 必须是 kebab-case：…/.dsh/.staging/…/SKILL.md
   ```

4. 即使绕过客户端，DSH 也不会加载它：`isSkillName` 不匹配的名字会被直接忽略（`deepseek-harness/packages/skill/skill/src/index.ts:29,35`，`skill-filesystem` 在发现阶段 `warn` 后跳过）。

结论：不是客户端严格，也不是 DSH 苛刻；是调度层的技能名模型缺一层——**给人看的名**与**给系统用的名**没有分开。

## 2 硬约束（决定了方案边界）

| 约束 | 来源 | 对方案的影响 |
|---|---|---|
| 技能名必须 `^[a-z0-9]+(-[a-z0-9]+)*$` | DSH `isSkillName`；client `format.ts` 同规则 | 系统标识只能是 ASCII kebab-case |
| `SKILL.md` 的 `name` 是唯一被 DSH 读取的技能标识 | DSH `skill-filesystem` 解析 frontmatter | 中文名不能靠「加一个字段给 DSH 看」解决；进包的必须是英文标识 |
| 展示名要给人读 | 产品形态 | 中文展示名只能留在调度层/UI，或放进 `description` |
| 包内容按 frontmatter 生成 | 调度层 `buildSkillMarkdown` | 标识变化会改变包字节 → digest / revision 变化 |

由此得到：**不能把中文名放进 SKILL.md 的 `name`**；能动的只有调度层的技能实体、生成规则与 UI。

## 3 方案对比

| 方案 | 做法 | 展示名 | 改动面 | 结论 |
|---|---|---|---|---|
| **A（推荐）** | 新增系统标识字段 `slug`（kebab），`name` 保留中文展示 | 保留 | DB 加列 + API/UI 加字段 + 建包改用 `slug` | 改动集中、语义清楚、客户端零改动 |
| B | 不新增字段，`name` 强制英文 kebab，中文放 `description`/标签 | 丢失 | 最小 | 不满足「一个中文名字方便给人读」 |
| C | 用技能 id 或包 id 当系统名（如 `skill-01a1cefc`） | 保留 | 无 schema 改动 | 模型 catalog 里全是 UUID 前缀，可读性差 |
| D | 把现有 `name` 改造成 kebab 标识，另加 `display_name` | 保留 | DB 列改名 + API 语义翻转 + UI 全量适配 | 语义更正统，但对现有数据/接口是破坏性变更 |

选择 A 的理由：现有 `name` 的**数据与语义都是展示名**，保留它不动；系统标识是新概念，用新列承载，向后兼容、可回滚。

### 关于命名（`slug` vs `skill_name`）

你的提议是 `skill_name`。两者语义相同，建议只看一条：**同一概念全链路同名**。

- 推荐 `slug`：DB 列 `skill.slug`、API 字段 `slug`、文档一致，`skill_name` 在 `skill` 表里读起来是 `skill.skill_name`，略重复。
- 若沿用 `skill_name`：DB 列 `skill_name`、API 字段 `skillName`，不要一处 `skill_name`、一处 `slug`、一处 `name`。

无论选哪个，**SKILL.md frontmatter 的键仍然是 `name`**（DSH 规定），这层映射要写进组件规格，避免后来者误以为有一个 `slug:` 键。

## 4 推荐方案 A 的设计

### 4.1 数据模型（`skill` 表）

| 列 | 类型/约束 | 说明 |
|---|---|---|
| `name` | 现有：`text not null`，`char_length between 1 and 80`，`unique(lower(name))` | **展示名**，可中文；保持现状 |
| `slug`（新增） | `text not null`，`check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')`，长度 1–64，`unique(lower(slug))` | 系统标识；进 `SKILL.md` 的 `name`、包文件名、日志 |

- 新增列先可空 → 回填 → `set not null`，具体见 §5 迁移。
- 建议 `slug` **创建后不可修改**；确需改名视为换技能（或走显式迁移），避免运行中的包与任务引用漂移。
- 展示名的唯一性保持现状（大小写不敏感唯一），避免列表里出现两个同名技能。

### 4.2 契约（`CMP-skill`）

- `SkillSummary` / `SkillDetail` 增加 `slug`；`SaveSkill` 增加 `slug`（新建必填，更新时缺省=不改）。
- `SaveSkill` 校验：形状不合法 → `ValidationError("slug", "必须是 kebab-case（示例 workflow-init）")`；重名 → 现有 `NameConflictError`。
- 包生成：`buildSkillMarkdown` 的 `name:` 取 `slug`；`version`、`description` 不变。
- 包文件名：`<slug>-<version>.zip`（现在是 `<name>-<version>.zip`，中文名会产出色名不稳定的文件名）。
- 列表排序/检索：`sort` 增加 `slug` 可选；`q` 同时匹配 `name` 与 `slug`。
- 存量投影：`SkillDetail.name` 保持来自展示名；组件规格里「`SkillDetail.name` 以包内 frontmatter 为准」这条要改写（现在包内是 slug，展示名来自表）。

### 4.3 执行面契约（`executor-http-v3`）

建议**不改**：

- `skillSet.packages[].name` 继续下发展示名，客户端只把它用在错误文案里（`技能包 304 但本地无缓存：<name>`），中文更好读；
- 包的 `packageId`、`digest`、`etag` 语义不变；
- 如果后续想用它做日志关联，可加可选字段（如 `skillSlug`），属于独立小改动，不阻塞本次。

### 4.4 客户端（`agent-flow-client`）

**不需要改。** 客户端已经按同一 DSH 规则校验 frontmatter `name`；开发期最好加一条反例测试：服务端生成的包必须能过客户端的 `validateSkillsTree`（可以用一个固定样例 zip 做契约测试，防止两边规则再次分叉）。

### 4.5 UI（`agent-flow-ui`，另一个仓库）

创建/编辑表单加「系统标识」输入框，展示名仍是中文主标题；列表可显示 `展示名 (slug)`。UI 不在调度层仓库内，作为下游依赖列出即可。

## 5 迁移

1. `alter table skill add column slug text;`
2. 回填：
   - 现有 `name` 恰好是 kebab-case 且不冲突 → `slug = lower(name)`；
   - 其余（如中文名）→ 按 `skill-<id 前 8 位>` 生成占位，并输出一份「待人工确认」清单。
3. 建唯一索引 `unique(lower(slug))`，然后 `set not null`。
4. **重打包**：已有包里的 frontmatter 仍是旧 `name`，光加列不解决执行面失败。迁移后需要把存量技能按新 `slug` 重新生成包（保存一次或写批量重打包脚本），同步 `package_key` / `package_digest` / `revision` / `version`。
   - 重打包会改变 digest 与 packageId（`<id>.<revision>` 里的 revision 会变）；迁移窗口内不要有在跑的 run。
5. 过渡期兼容（可选）：读取到 `slug` 为空的历史行时，接口返回明确错误而不是静默用旧名生成包。

## 6 测试与验收

| ID | 断言 |
|---|---|
| `TC-SN-1` | 展示名 `工作流初始化` + `slug=workflow-init`：保存成功，包内 `SKILL.md` 的 `name: "workflow-init"`，`version` 不变 |
| `TC-SN-2` | `slug` 非法（中文、下划线、大写、连续 `--`、首尾 `-`）→ 保存返回 400，`field=slug`，不产生包 |
| `TC-SN-3` | `slug` 重复（大小写不敏感）→ 409，与原展示名冲突语义一致 |
| `TC-SN-4` | 下载包后客户端安装通过（用客户端 `validateSkillsTree` 做契约测试样例） |
| `TC-SN-5` | 迁移：中文名老数据回填占位 slug 后重打包，任务可执行；清单里列出待改名项 |
| `TC-SN-6` | 展示名修改不影响 `slug`，也不改 `packageId` 前缀以外的语义 |

端到端验收：带技能包的 run 在客户端进入 `running` 并真正执行，不再出现 `invalid_skill_format`。

## 7 风险与回滚

- **迁移风险**：存量包必须重打包，否则执行面继续失败；建议与「加字段」同批做，别只加列。
- **占位 slug 的可用性**：`skill-01a1cefc` 能跑但不可读，需安排一次人工改名（改名是否触发 revision 递增要定，见 §8）。
- **契约扩展**：新增字段向后兼容；若改 `name` 语义（方案 D）则是破坏性变更。
- **回滚**：加列可回滚（drop column）；已重打包的包无法回到旧 digest，需接受。

## 8 待定

1. 字段名：`slug` 还是 `skill_name`（建议前者，理由见 §3）。
2. 级别：涉及 DB schema 与公共契约，按 `arch-design-spec` 定级（倾向 P1，需人工评审确认）。
3. 回填策略：占位 `skill-<id8>` 自动生成，还是要求作者在下次保存时补填。
4. `slug` 是否允许改名、改名是否强制升 version/revision。
5. 展示名是否仍要求全局唯一（当前是）。
6. 是否把展示名也写进 frontmatter（如 `title` 键）：DSH 不读，纯为包可读性；建议先不加，保持 frontmatter 只有 `name/description/version`。
