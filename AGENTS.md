# AGENTS.md

## Git 约定
- 禁止使用 `git worktree`（含 `git worktree add/list/remove`）。不要创建多余的工作目录或把分支检出到别处。
- 所有分支变更（新建、切换、合并）都在本仓库目录 `D:\project\ontology_management` 内通过常规 `git checkout` / `git branch` / `git merge` 完成。

## 依赖与实现原则
- 优先直接使用知名、成熟的库或现成组件，非必要不重复造轮子。只有现有库/组件确实不满足业务需求时，才自行实现，并在代码中说明理由。

