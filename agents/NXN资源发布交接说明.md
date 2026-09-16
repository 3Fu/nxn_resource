# NXN 资料中心发布交接说明

本文档面向需要维护 NXN 官网“资料中心”的同事。发布目标仓库是 `3Fu/nxn_resource`，官网运行时从公开目录读取资料元数据；不需要重新部署 `nxnos.com`。

## 发布前准备

1. 在本机安装 Node.js 18+ 和 `ffmpeg`（只有目录包含视频时，首次迁移才需要 ffmpeg）。
2. 使用具有以下权限的 GitHub Fine-grained PAT：
   - 只授权仓库 `3Fu/nxn_resource`；
   - Metadata：Read；
   - Contents：Read and write；
   - 首次启用 GitHub Pages 时另需 Pages：Read and write。
3. 在 `agents/skills/nxn-resource-publisher/.env` 保存配置：

   ```dotenv
   NXN_RESOURCE_GITHUB_URL=https://github.com/3Fu/nxn_resource.git
   NXN_RESOURCE_GITHUB_TOKEN=github_pat_...
   NXN_RESOURCE_GITHUB_TOKEN_NAME=NXNOS_RESOURCES
   ```

   不要把令牌写进命令行、聊天、日志或 Git。`.env` 和 `.work/` 已在根目录 `.gitignore` 中忽略。

## 工作区约定

```text
workspace/
├─ assets/<assetKey>                 原始文件
└─ docs/
   ├─ catalog.json                   待发布目录
   ├─ catalogs/<version>.json        历史目录（由脚本写入）
   └─ previews/<id>/<version>/...    浏览器预览
```

目录字段和预览要求见 [`skills/nxn-resource-publisher/references/catalog-schema.md`](skills/nxn-resource-publisher/references/catalog-schema.md)。`assetKey` 必须是单一 URL-safe 文件名，不能包含路径分隔符或 `..`。

## 首次迁移

从网站仓库根目录运行：

```powershell
node agents\skills\nxn-resource-publisher\scripts\resource-center.mjs stage-initial `
  --workspace agents\skills\nxn-resource-publisher\.work\2026.09.09.2 `
  --website-root .
```

脚本会复制原件和预览、按需生成 H.264/AAC 视频预览，并自动校验 SHA-256。视频预览必须小于 95 MiB。

## 日常更新与发布

1. 复制一个新的工作区，编辑 `docs/catalog.json`，并把所有活动原件放入 `assets/`。
2. `catalogVersion` 使用新的点分数字符串，且必须大于线上当前版本，例如 `2026.09.09.3`。
3. 每个资源的 `downloadUrl` 和资料包 URL 必须指向本次 `resources-<catalogVersion>` Release。
4. 先校验：

   ```powershell
   node agents\skills\nxn-resource-publisher\scripts\resource-center.mjs validate `
     --workspace agents\skills\nxn-resource-publisher\.work\2026.09.09.2
   ```

5. 发布前向负责人确认：目标仓库、目录版本、增加/修改/下架的 ID，以及公开目录会发生变化。
6. 获得明确授权后发布：

   ```powershell
   node agents\skills\nxn-resource-publisher\scripts\resource-center.mjs publish `
     --workspace agents\skills\nxn-resource-publisher\.work\2026.09.09.2
   ```

脚本会创建 Release、上传原件和 ZIP，通过 Git Database API 提交预览，再归档并激活目录。输出的目录地址是：

`https://3fu.github.io/nxn_resource/catalog.json`

## 下架、镜像和回滚

- 下架：从下一版目录移除资源，保留旧 Release，不删除历史资产。
- 镜像线路：只修改 `sources`，仍需递增版本并完整校验。
- 回滚：先确认历史文件 `docs/catalogs/<version>.json`，再运行：

  ```powershell
  node agents\skills\nxn-resource-publisher\scripts\resource-center.mjs rollback --version 2026.09.09.2
  ```

  回滚只切换当前目录指针，不删除 Release。

## 失败处理

- 原件上传成功、目录未激活：可用相同工作区重试一次；脚本会复用同标签草稿并跳过同尺寸资产。
- 同一版本出现多个 Release：停止操作，先人工确认并清理重复状态；脚本会拒绝继续。
- 视频预览收到 422：不要循环重试；检查大小，或改用 Git Database API（当前脚本已使用）。
- Pages 访问 404：仓库 Settings → Pages 选择 Branch `main`、Folder `/docs`。目录文件本身应直接访问 `/catalog.json`，仓库根路径没有 `index.html` 时返回 404 是正常的。
- 官网加载失败时会依次尝试 Pages、jsDelivr、Raw GitHub，最后使用内置目录。内置目录必须与最近一次已发布版本同步。

## 发布后检查

确认以下地址返回 200：

- `https://3fu.github.io/nxn_resource/catalog.json`
- 每个 `previewKind` 为 `pdf` 或 `image` 的 `url`
- 至少一个原件 Release 下载地址

同时核对目录版本、资源数量、是否误包含已下架资源，并保留发布日志中的 Release 标签。
