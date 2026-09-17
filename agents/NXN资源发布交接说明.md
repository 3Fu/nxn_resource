# NXN 资料中心发布交接说明

Agent 维护流程的权威说明在 [`skills/nxn-resource-publisher/SKILL.md`](skills/nxn-resource-publisher/SKILL.md)。Codex、Hermes Agent 或其他工具处理本仓库时，先读取仓库根目录的 `AGENTS.md`，再加载该技能。

## 日常使用

用户只需要提供一个文件或文件夹，并说明“更新到官网”。Agent 负责：

1. 读取文件内容，补充或复用 `references/resource-metadata.json` 中的稳定 ID、标题、说明和预览类型。
2. 对新增资源更新 `doc/README.md`。
3. 运行 `resource-sync.mjs plan`，展示版本、ADD/CHANGE/UNCHANGED/RETIRE 和异常项。
4. 运行 `resource-sync.mjs prepare` 生成 `.work/<version>` 候选工作区。
5. 运行 `resource-center.mjs validate` 校验资产、哈希、URL 和预览。
6. 运行 `resource-center.mjs publish --workspace <workspace> --root <repo-root>` 发布，并把发布后的 catalog、归档、预览、manifest 和 `distribution=git` 原件回写仓库。
7. 运行 `resource-center.mjs verify-remote --workspace <workspace> --assets true`，确认线上 Pages 目录与候选目录一致，且 Release 原件、公开预览、封面和 bundle 均可读取。

不要为日常资源更新手工编辑 `docs/catalog.json`、`docs/catalogs/` 或 `docs/previews/`。历史 Release、历史 catalog 和预览路径不得在普通更新中删除。

## 运行前提

- Node.js 18 或更高版本。
- 处理视频时需要 `ffmpeg`/`ffprobe`。
- 处理 PPT 预览时需要 PowerPoint 或 LibreOffice。
- 发布凭据放在 `agents/skills/nxn-resource-publisher/.env`，不要输出、传递或提交其中的令牌。
- GitHub PAT 只需覆盖 `3Fu/nxn_resource` 的 Metadata read、Contents read/write。首次启用 Pages 时才需要 Pages read/write。

## 异常处理

- 没有内容变化时停止，不创建新版本。
- 只有同一版本的部分发布可以重试；重复 Release 或第二次失败必须停止并报告。
- 线上发布成功但本地回写失败时，修正本地问题后使用相同工作区、`--root` 和 `--allow-same-version true` 完成回写。
- 回滚只切换当前 catalog 指针，使用 `resource-center.mjs rollback --version <version>`。
