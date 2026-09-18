# 网络代理与失败恢复

GitHub Release 访问不稳定时，优先使用代理和断点式重跑。下载器不会保留半成品为正式文件：所有内容先写入 `.part`，校验字节数和 SHA-256 后才改名。

## 下载器代理

`resource-download.mjs` 自动读取 `HTTPS_PROXY`、`ALL_PROXY`、`HTTP_PROXY`，同时遵守 `NO_PROXY`。检测到代理后，脚本使用系统 `curl` 完成请求，因此不依赖 Node 版本对代理环境变量的支持。

PowerShell 示例：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
node agents/skills/nxn-resource-publisher/scripts/resource-download.mjs `
  --catalog-url https://3fu.github.io/nxn_resource/catalog.json `
  --output "<cache-dir>" --all --json --retries 5 --stall-timeout 120
```

也可以显式指定代理：

```powershell
node agents/skills/nxn-resource-publisher/scripts/resource-download.mjs `
  --catalog-url https://3fu.github.io/nxn_resource/catalog.json `
  --output "<cache-dir>" --all --json `
  --proxy "http://127.0.0.1:7890"
```

如已设置环境代理但本次必须直连，可传 `--proxy-env false`。代理地址中的用户名和密码不会被脚本输出。

## 发布与同步脚本

`resource-sync.mjs prepare` 在需要重新下载历史 Release 原件时，同样支持 `--proxy`、`--proxy-env`、`--retries`、`--connect-timeout` 和 `--stall-timeout`。

`resource-center.mjs` 使用 Node 内置 `fetch`。在当前 Node.js 24 环境发布或校验时，可让内置 `fetch` 读取代理环境变量：

```powershell
$env:NODE_USE_ENV_PROXY = "1"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
node agents/skills/nxn-resource-publisher/scripts/resource-center.mjs verify-remote `
  --workspace "<workspace>" --assets true
```

Node.js 18 至 23 的内置 `fetch` 不保证支持该环境变量；这些版本应优先使用下载器完成 Release 拉取，或在操作系统层提供透明代理。

## GitHub 不稳定时的恢复步骤

1. 保持同一输出目录，重新运行原下载命令。已经存在且 SHA-256 正确的文件会返回 `skipped`。
2. 检查 JSON 的 `summary.failed` 和 `resources[].status`。只重跑失败项时，可再次使用 `--ids`。
3. 降低并发并增加重试，例如 `--concurrency 1 --retries 5 --stall-timeout 120`。
4. 不要用 `--force` 修复网络故障；它只会强制覆盖已验证文件，不能提高下载成功率。
5. 若代理本身不稳定，先确认 `curl --version` 可用，再切换代理地址或网络后重复同一命令。
