# BeefTV 插件市场（`beeftv-plugin-market`）

`beeftv-plugin-market` 随 BeefTV 桌面包预装并默认启用（位于 `agent-host/bundled-plugins/`），通过 `pluginCenter.section` 插槽挂载在插件中心左侧的「插件市场」栏。

## 功能特性

- **精选推荐列表（国内加速链）**：联网时优先通过国内加速链（`beeftv-plugin-catalog` npm 镜像、`cdn.jsdelivr.net`、`gh-proxy`、`ghfast.top` 与 GitHub 官方源）读取 `Sunnyender-org/beeftv-plugins` 的 `registry.json` 并缓存到本地；断网或超时时自动无缝回退到缓存与内置离线副本。
- **npm 社区搜索**：按 `beeftv-plugin` / `pi-package` 检索所选下载源（默认 `https://registry.npmmirror.com`）上的社区插件包。
- **下载源切换**：支持在国内镜像（`https://registry.npmmirror.com`，默认）与 npm 官方源（`https://registry.npmjs.org`）之间切换。
- **远程详情与多源在线安装**：未安装时即可在线读取插件 `README.md`、仓库链接与版本信息；点击安装或更新时，支持从 npm 镜像、预打包镜像 `.tgz`（含 SHA-256 校验）与 `github:owner/repo` 在线下载安装。
