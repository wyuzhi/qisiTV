# 上游更新与验证记录

qisiTV **v1.5.10** 基于上游 v1.5.9（`e2fd1d3`）和已有 qisiTV 定制，选择性吸收后续修复。它不是上游 v1.6.23 的完整合并，版本号也不表示已具备该版本的全部功能。

## 本次吸收范围

| 上游提交 | 改动 | qisiTV 适配 |
| --- | --- | --- |
| [`5da4253`](https://github.com/glanderness/BeefTV/commit/5da4253) | 复制媒体后节点丢失 | 副本移除原生成提交标记，避免普通保存把副本当成未确认生成结果过滤。 |
| [`522cd03`](https://github.com/glanderness/BeefTV/commit/522cd03) | 恢复画布备份导入入口 | 使用已有 ZIP 备份格式；新项目与媒体独立编号，目录授权与实际写入成功后才计为完成，失败保留已完成项目并说明剩余数量。 |
| [`85cb345`](https://github.com/glanderness/BeefTV/commit/85cb345) | 项目库操作栏换行 | 工具栏按内容宽度排列，容纳导入按钮并在窄窗口换行。 |
| [`852961a`](https://github.com/glanderness/BeefTV/commit/852961a) | 打开的任务详情持续更新 | 保留浏览器 LikeAI 任务查询与安全日志投影，适配查询取消、终态及画布切换。 |
| [`3a74793`](https://github.com/glanderness/BeefTV/commit/3a74793) | 取回原任务结果 | 按 LikeAI 浏览器任务链改写，校验当前画布与节点；复用已受理任务，不重新提交付费生成。 |

导入会拒绝缺失媒体或无法恢复的临时链接，并清除原任务、素材绑定和生成提交标记；不会用原项目缓存补出一个看似成功的新项目。绘图文档按新项目 ID 隔离保存。

## 保持的产品边界

- 浏览器是项目文件的唯一写入者，每个项目和素材保存在使用者授权的本机文件夹；IndexedDB 仍是缓存，不替代目录持久化。
- 保留外部本机 MCP 客户端与网页配对流程，不增加网页内 Agent、账号或云端工作区。
- 保留 qisiTV 品牌与 LikeAI 服务适配，不恢复上游钱包或其他服务商入口。
- 上游 pi Agent、整套后端 MCP 重构和导演台大改暂缓。后续迁移需要单独核对依赖、数据格式及回归修复。

同次整合保留独立开发的 qisi API 接入（`631e79f`）：使用独立 Key，保留官方 LikeAI 的既有配置。中转站的账号、计费和托管部署属于该服务的交付范围；画布项目仍由本机目录保存。

## 验证记录

联合 qisi API 代码后，实际通过 **75 项专项测试**、**10 项任务详情浏览器测试**、**1 项恢复反馈浏览器测试**、TypeScript 检查、生产构建和 diff 空白检查。核心复验命令：

```sh
cd web
bun test test/canvas-node-copy.test.ts test/generation-storage-consistency.test.ts test/canvas-backup-import.test.ts test/browser-project-folder.test.ts test/local-canvas-import-copy.test.ts test/browser-likeai-tasks.test.ts test/browser-qisi-api.test.ts test/canvas-generation-task-sync.test.ts test/canvas-resource-reload.test.ts test/canvas-resource-reload-persistence.test.ts test/canvas-generation-backend-commit.test.ts
bun test test/task-details.browser.test.ts
bun test test/canvas-resource-reload-feedback.browser.test.ts
bun run typecheck
VITE_QISITV_BROWSER_ONLY=1 QISITV_WEB_BASE=/qisitv/ bun run build
git diff --check
```

覆盖目录权限中断、磁盘写入失败、部分成功、重复导入隔离、嵌套媒体引用、缺失文件，以及原任务素材不能被副本重新绑定。真实 consumer、IndexedDB 与编辑器 adapter 的回归覆盖保存期间继续编辑、目录确认推进版本号、失败后再次附加原结果。任务详情测试使用独立无头浏览器验证刷新、关闭取消、终态和迟到响应。

全局通知沿用隐藏策略。导入与取回原结果的反馈改为页面内状态，恢复反馈测试验证全局通知隐藏时的进度、成功、失败、外部 Agent 指引和关闭操作。

最终构建已做页面验收：项目列表明暗主题、720px 窗口工具栏换行、导入按钮选取测试备份、未授权目录时的可见错误和设置跳转，以及 WorkBuddy 顺序与 LikeAI / qisi API 双配置入口。

目录测试使用内存文件系统模拟，持久化回归模拟目录写入确认。原生目录选择器的实机授权未完成自动验收，不能把这些测试称为跨浏览器磁盘验收。任务响应使用 mock，不提交真实付费生成；可查询原任务不代表获准创建新收费任务。

ZIP 导入仍沿用原有同步解压实现，大体积备份的解压可能阻塞页面；本次未改造归档引擎。
