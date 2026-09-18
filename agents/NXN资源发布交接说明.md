# NXN 资料中心发布交接说明

Agent 维护流程的权威说明在 [`skills/nxn-resource-publisher/SKILL.md`](skills/nxn-resource-publisher/SKILL.md)。Codex、Hermes Agent 或其他工具处理本仓库时，先读取仓库根目录的 `AGENTS.md`，再加载该技能。

## 日常使用

用户只需要提供一个文件或文件夹，并说明“更新到官网”。Agent 负责：

1. 读取文件内容，补充或复用 `references/resource-metadata.json` 中的稳定 ID、标题、说明和预览类型。
2. 对新增资源更新 `doc/README.md`。
3. 运行 `resource-sync.mjs plan`，展示版本、ADD/CHANGE/UNCHANGED/RETIRE 和异常项。
4. 运行 `resource-sync.mjs prepare` 生成 `.work/<version>` 候选工作区。
5. 运行 `resource-center.mjs validate` 校验资产、哈希、URL 和预览。
6. 运行 `resource-center.mjs publish --workspace <workspace> --root <repo-root>` 发布，并把发布后的 catalog、归档、预览和 manifest 回写仓库；原件只保留在 GitHub Release。
7. 运行 `resource-center.mjs verify-remote --workspace <workspace> --assets true`，确认线上 Pages 目录与候选目录一致，且 Release 原件、公开预览、封面和 bundle 均可读取。

不要为日常资源更新手工编辑 `docs/catalog.json`、`docs/catalogs/` 或 `docs/previews/`。历史 Release、历史 catalog 和预览路径不得在普通更新中删除。

`doc/` 只保留 `README.md` 和 `manifest.json`，作为人类可读索引和机器索引。接待智能体使用 `resource-download.mjs` 从 Release 下载原件，脚本按原始中文文件名落盘、校验 SHA-256，并返回本机路径。

```powershell
node agents/skills/nxn-resource-publisher/scripts/resource-download.mjs --catalog-url https://3fu.github.io/nxn_resource/catalog.json --output "<cache-dir>" --all --json
```

下载器会自动识别 `HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY`，代理流量通过系统 `curl` 执行，并支持 `--proxy`、`--retries`、`--concurrency` 和 `--stall-timeout`。网络中断后保持同一输出目录重跑即可，已校验文件会跳过。完整恢复流程见 [`skills/nxn-resource-publisher/references/network-recovery.md`](skills/nxn-resource-publisher/references/network-recovery.md)。

`docs/` 不能与 `doc/` 合并或删除：它是 GitHub Pages 的发布目录，仍需保存网站使用的 `catalog.json`、历史 catalog 和浏览器预览文件；这里不保存原件。

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
