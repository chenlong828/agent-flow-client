---
layer: history
module: global
status: frozen
updated: 2026-11-03
---

# 2026-11-03 Bun 改为系统级安装

## 背景

初始化时把 Bun 放在项目 `.local/bun`，便于项目自包含；随后要求改为系统级安装，项目不再携带 Bun。

## 决策

1. 将 Bun 1.4.4 安装到 `~/.bun/bin`，通过 `~/.zshrc` 的 `PATH` 全局可用。
2. 删除项目 `.local/bun`；后续命令统一使用 `bun`，不再使用 `./.local/bun/bun`。
3. 项目文档不再提 `.local` 工具链；`.gitignore` 不再忽略 `.local/`。
4. 版本约束保留在 `package.json` 的 `engines.bun`。

## 影响

- 换机器需先安装 Bun；项目不再自包含 Bun。
- 与调度器项目的 `.local/bun` 方式不同，但版本一致（1.4.4）。
- `2026-11-03-bootstrap` 决策中的第 5 条由本决策取代。

## 未做

- 未安装到 `/usr/local/bin`（当前不可写）；使用用户级全局路径 `~/.bun/bin`。
