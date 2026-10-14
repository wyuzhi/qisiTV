# qisiTV v1.5.12 上游同步

本次检查 `glanderness/BeefTV` 至 v1.7.21（`788e3a1a85b3d43ea1102fabfceb9d0fc3c90788`）。相对于前次检查点 `bb8d5b83`，上游新增 48 个提交、改动 529 个文件。

qisiTV 按浏览器本机目录的调用链选择性适配，保持独立版本号 v1.5.12，不代表全量合并上游 v1.7.21。继续保留 qisiTV 品牌、外部 MCP 客户端（WorkBuddy 紧跟 Codex）、qisi API 与 LikeAI 的独立配置及密钥。

## 适配范围

| 来源提交 | 本次接入 |
| --- | --- |
| `7c5b83d8`（#120，部分） | 为单个画布、批量画布、画布内删除入口和项目文件夹补齐确认。锁定重复提交，失败保留弹窗和错误信息；读取当前目标，防止工作区切换后继续操作。 |
| `5e2ad602`（#138） | 图片失败提示适配明暗主题；缩小时显示保持屏幕尺寸的重试按钮，阻止点击穿透到节点操作。沿用现有资源缓存恢复逻辑。 |
| `63ccdb63`（#127，部分） | 按不可变渠道和模型配置数组建立索引，避免筛选、标签、图标查找反复遍历大型目录。重复模型名仍按渠道隔离，保持原有能力与协议判断。 |
| `d5fd6986`（#132，部分） | 分离音视频前探测音轨，无声素材立即给出明确错误；探测和编码临时文件在结束时清理。成功必须同时保存无声视频和独立音轨。 |

网站适配同时修复媒体工具保存后误请求桌面 `/canvas-projects` 接口的问题。网页以本机目录写入返回的快照为准，校验新节点已包含其中；浏览器缓存异步更新，不阻塞目录确认。分离过程保留原视频、相邻节点与连线，异步结果返回时再次核对画布和原节点，切换项目后停止追加。

项目文件夹属于项目列表分组，删除分组前先等待内部画布移入回收站，分组自身不承诺回收站恢复。

## 未直接合入的部分

- 内置 pi Agent、账户与钱包、BeefAPI/H3/新模型协议、云端转写、桌面更新器及服务端下载体系不属于当前网站运行方式，未整套导入。
- 上游资产库整体布局迁移会改变当前标签、收藏等操作，本次未整体替换。
- 上游模型菜单动画调整针对另一套 Select 实现，当前配置页使用内联模型卡片，不适用该补丁。
- 备份导入仍走 qisiTV 的本机目录实现；它已有逐项目 `finally` 进度清理，本次复验导入失败与部分成功，不引入上游桌面归档恢复引擎。
- 未改变付费生成提交、重试、默认模型或费用授权规则。

## 验证

实际通过 95 项专项测试（76 项单元/合同测试、19 项 Chromium 浏览器测试）、TypeScript 检查、网站生产构建及 `git diff --check`。

```sh
cd web
bun test test/canvas-video-segment-args.test.ts test/canvas-audio-probe.test.ts test/model-catalog-index.test.ts test/browser-project-folder.test.ts test/browser-likeai-tasks.test.ts test/browser-qisi-api.test.ts test/browser-agent-commands.test.ts test/browser-workspace-persistence.test.ts test/canvas-backup-import.test.ts test/local-workspace-stale-backend.test.ts test/canvas-delete-confirmation.browser.test.ts test/canvas-image-recovery.browser.test.ts test/canvas-leave-flush.browser.test.ts test/canvas-audio-persistence.browser.test.ts
bun run typecheck
VITE_QISITV_BROWSER_ONLY=1 QISITV_WEB_BASE=/qisitv/ bun run build
git diff --check
```

删除交互覆盖取消、重复点击、失败重试、工作区 A→B→A 与处理中切换。图片覆盖请求失败、解码失败、并发重试和四分之一倍率。音画分离运行真实页面 hook，覆盖成功保留相邻节点、目录失败、无音轨、处理中切换项目，以及缓存挂起时目录仍能完成保存。模型测试覆盖 2000 个条目的索引查找和配置更新。

浏览器 hook 测试替换媒体处理和文件仓库依赖；音轨探测合同使用模拟 FFmpeg，目录测试使用内存文件系统，不宣称完成原生目录授权或真实视频转码的跨浏览器验收。未执行真实付费生成。生产构建仍有既存的大 chunk 提示，本次未扩大到全站分包改造。
