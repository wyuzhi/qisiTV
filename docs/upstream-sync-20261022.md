# qisiTV v1.5.16 上游检查与修复

2026-10-22 检查上游 `glanderness/BeefTV` 至 `d33ff1b7553cb938dc9e8f777c04a7e396a45d11`。相对上次检查点 `788e3a1a`，增加 254 个提交、改动 1377 个文件；已发布版本为 v2.0.1，主线包含其后的更新。qisiTV 保持独立版本 v1.5.16，本次为选择性适配。

## 来源与许可边界

上游 [许可证变更](https://github.com/glanderness/BeefTV/blob/6b30abfe61a269b67f3d5cdc1bafd24c7fa13b5c/LICENSE) 从该提交开始覆盖其后新增原创内容；第 5 节要求对外网站服务取得单独书面授权，包括免费服务。第 1 节保留历史 MIT 内容原有授权，明确列出 `2327ee2d80282b10dd8bef0f26b48990d46f5c3b`。本次采用的三个来源提交均在这一 MIT 快照中，未复制新许可下的新增实现，保留原 MIT 及作者声明。

| MIT 来源提交 | qisiTV 适配 |
| --- | --- |
| `f673516181ec33e922006dfee9fcfe4c9710ba9a`，部分 | 历史画布缺少 `chatSessions` 时仍可保存。本地复验发现仅补循环默认值仍会在持久化合并时报错，进一步修正读取归一化与数组合并，验证完整生成写回链。 |
| `e126cf93e0882d06134374fa09bd30e87c05cdac`，适配 | 节点搜索、导演台路径统计及关键帧排序不再依赖 `Array.toSorted`；对共享输入复制后排序，避免修改原始次序。 |
| `5e74aaa302f647df030deb92a715ef8bee4529f2`，部分 | 引用菜单、提示词引用与连接素材栏显示实际素材名；序号及请求 token 保持稳定。分辨率按数值升序展示，特殊枚举留在原位置，不改变请求值。 |

保留本机项目文件夹、外部 MCP、qisi API / LikeAI 的独立配置，以及 WorkBuddy 紧跟 Codex 的入口顺序。未合并上游内置 Agent、钱包、模型服务扩展、技能市场、桌面更新器和媒体后端大迁移。节点标题布局和视频共享解码租约依赖另一套画布运行时，本次未直接导入。

## qisiTV 自身修复

- 引用预览逐项显示，单个缓慢文件不再阻塞全部缩略图。请求缓存限制在当前 hook 生命周期，按项目、工作区 epoch、存储键及预览地址区分；移除引用、切换项目后忽略迟到响应，重新打开可重试缺失文件。
- 浏览器复制标签页可能连同 `sessionStorage` 一并复制。新标签页只有完成新配对或实际连上 WebSocket 后才拥有该连接；仅持有复制令牌、或恢复遇到已在线连接时，取消/换码不会发送撤销原连接的请求。原标签页主动断开仍撤销自己的授权。
- 修正备份导入测试中沿用旧全局通知文案的断言，继续核对页面内反馈和本机目录保存提示。

MCP 二进制保持 0.3.0，本次连接修复在网页端生效。原授权期限、首次确认、本机目录授权和付费边界保持原合同。

## 验证记录

回归先复现了缺失会话字段的保存异常、缺少 `toSorted` 时的搜索异常、复制标签页换码与取消误撤销两个场景，再验证修复。预览测试使用真实 Chromium 与可控文件读取夹具；不访问用户项目或调用付费生成。

通过 237 项专项测试（216 项单元/合同测试，21 项 Chromium 浏览器测试）、TypeScript 检查、网站生产构建及 `git diff --check`。浏览器测试覆盖素材引用名称与稳定 token、菜单与键盘交互、慢预览与项目往返、MCP 确认/刷新/重连/撤销、自定义图片比例，以及图片/视频/音频下载的文件名和字节。修正两处测试夹具问题：新增同名搜索项后精确选择目标、允许 AntD 退场动画短暂保留同名下载提示。

核心复验命令：

```sh
cd web
bun test test/canvas-array-compat.test.ts test/canvas-node-search.test.ts test/director-keyframe-editing.test.ts test/director-transform-semantics.test.ts test/canvas-storage-revision.test.ts test/generation-storage-consistency.test.ts test/agent-canvas-patch.test.ts test/browser-agent-connection.test.ts test/browser-agent-commands.test.ts test/browser-project-folder.test.ts test/browser-workspace-persistence.test.ts test/canvas-resource-references.test.ts test/canvas-resource-mention-editor.test.ts test/video-generation-options.test.ts test/channel-model-catalog.test.ts test/local-canvas-export-contract.test.ts test/canvas-backup-import.test.ts test/desktop-media-save.test.ts test/browser-likeai-tasks.test.ts test/browser-qisi-api.test.ts
bun test test/canvas-mention-interaction.browser.test.tsx test/reference-preview.browser.test.ts test/browser-agent-pairing.browser.test.ts test/canvas-download.browser.test.ts test/image-custom-ratio.browser.test.ts
VITE_QISITV_BROWSER_ONLY=1 QISITV_WEB_BASE=/qisitv/ bun run build
git diff --check
```

本机目录与任务接口使用隔离夹具；未操作用户项目或提交付费生成，不声称覆盖所有浏览器的原生目录授权。旧浏览器兼容性通过移除 `toSorted` 后运行实际算法验证；未宣称完成旧版 Safari 实机验收。生产构建仍存在原有大 chunk 提示，本次未扩展为全站分包改造。
