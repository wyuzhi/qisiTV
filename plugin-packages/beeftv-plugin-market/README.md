# BeefTV 插件市场（`beeftv-plugin-market`）

`beeftv-plugin-market` 是随 BeefTV 桌面包预装的唯一官方市场插件，本身通过 `pluginCenter.section` 插槽挂载在插件中心左侧的「插件市场」栏。

## 功能特性

- **精选推荐列表**：联网时优先从公开仓库 `Sunnyender-org/beeftv-plugins` 的 `registry.json` 读取最新推荐列表；断网或超时（3 秒）时自动无缝回退到内置离线副本 `registry.json`。
- **npm 社区搜索**：按 `keywords:beeftv-plugin` 搜索 npm 社区发布的插件包。
- **下载源切换**：支持在国内镜像（`https://registry.npmmirror.com`，默认）与 npm 官方源（`https://registry.npmjs.org`）之间切换。
- **插件详情与统一安装确认**：查看插件包名、版本、作者、分类标签与 README 文档；点击安装或更新时，统一唤起宿主的安装确认框，由用户明确确认后执行安装。
