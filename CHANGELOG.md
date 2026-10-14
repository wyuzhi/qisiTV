# Changelog

Changes to qisiTV and its inherited release history are documented in this file.

## Unreleased

## v1.5.14 (qisiTV)

- 修复网页画布和资产页点击下载没有浏览器下载反馈的问题：单个媒体正常发起浏览器下载，并显示准备、已发起或失败提示。
- 优先通过存储键读取原文件，支持临时预览链接已失效、只有存储键的图片、视频和音频；空节点明确提示。项目自动保存和画布备份导出仍沿用项目目录。

## v1.5.13 (qisiTV)

- 修复 Vidu 等未配置 1K/2K/4K 预设的图片模型点击自定义比例“应用”无反应的问题；点击和回车均可应用比例，也可将像素尺寸换算为比例。
- 修改比例时保留模型独立的质量选项（如 2160p），不额外开放模型未声明的分辨率档位；非法比例仍显示校验提示。

## v1.5.12 (qisiTV)

- 选择适配上游截至 v1.7.21 的画布修复，继续使用本机项目文件夹、外部 MCP 和独立的 qisi API / LikeAI 配置。
- 补齐单个画布、批量画布和文件夹删除确认；操作期间避免重复提交，失败在弹窗中显示并支持重试。
- 图片缩小后仍能点击重新加载按钮，加载失败提示适配明暗主题。
- 为模型目录建立索引，减少大模型列表中反复遍历渠道与模型配置的开销。
- 音视频分离先检查音轨，无声视频给出明确提示；两个结果写入本机项目成功后才报告完成，切换画布后停止追加迟到结果。
- 修复网站媒体工具保存结果时误请求桌面后端的问题，目录写入保持权威，浏览器缓存不阻塞落盘确认。
- 本次不是上游 v1.7.21 全量合并；未引入内置 Agent、钱包、新服务商或桌面更新器。

## v1.5.11 (qisiTV)

- 选择适配上游截至 v1.7.15 的画布修复，保留本机项目文件夹、外部 MCP、qisiTV 品牌及独立的 qisi API / LikeAI 配置。
- 修复素材引用菜单切换分类时关闭、点击穿透、键盘选择和删除引用后的焦点问题。
- 防止在画布控件上按退格键退出页面；Agent 删除节点时不再因编辑器时间戳差异误报冲突，真正的内容冲突仍会保护本地修改。
- 兼容旧视频的音频开关数据，避免预览崩溃；长视频任务显示已用时间与等待提示。
- 图片加载失败可重试，远程资源可绕过损坏缓存重新下载；修复连续滚轮缩放时的倍率跳变。
- 离开画布或切到后台时及时保存待落盘修改，优先写本机文件夹；未编辑时不反复创建新版本。
- 本次为选择性适配，不是上游 v1.7.15 全量合并；未引入上游内置 Agent、账户、桌面更新器和服务端转码体系。

## v1.5.10 (qisiTV)

- Selectively adapted upstream media-copy persistence, backup import, project toolbar layout, live task details, and original-result recovery improvements for the browser workspace.
- Imported backups create independent project/media copies and report success only after writing to the authorized project folder. Partial failures keep completed imports and report the remaining work.
- Task details refresh while work is running. Result recovery reuses the original LikeAI task, checks the current canvas and node, and never submits another paid generation.
- Keep the local-folder browser workspace, LikeAI configuration, branding, and external MCP clients, including WorkBuddy immediately after Codex. This is a qisiTV release based on v1.5.9 with selected later patches; it is not a full upstream v1.6.23 merge.
- Integrate the separately developed qisi API channel with its own Key and task transport, preserving existing direct LikeAI keys and selected models.

## qisiTV initial customization

- Merged upstream v1.5.9 while preserving qisiTV branding, LikeAI, and local Agent integration; Cloudflare publishing is optional and requires the fork's own release configuration.
- Renamed the product, icons, local Agent tools, packages, and runtime identifiers to qisiTV while preserving existing local data and upstream attribution.
- Added LikeAI model support and a shared MCP / CLI interface for external local Agents.
- Prepared the first audited public source snapshot.
- Added reproducible local builds, automated quality checks, and multi-architecture container publishing.
- Standardized the upstream public artifacts, runtime identifiers, documentation, and repository links.

## v1.5.9

- Validate reference image dimensions, aspect ratios, file sizes and audio/video duration using each model's configured capabilities before submitting.
- Preserve supported reference counts, resolutions and durations instead of silently dropping media or downgrading requested settings.
- Support local and inline reference audio for BeefAPI and native Ark channels, while retaining provider-specific audio-only rules.
- Show actionable reference conversion and request-size errors in both canvas nodes and task history, with safe diagnostics and no unsafe unchanged retries.

## v1.5.8

- Add a persistent light/dark switch to the workspace sidebar, with matching home, asset library, menus and settings surfaces.
- Restore canvas appearance controls with light, dark and custom modes; keep each canvas appearance independent from the workspace theme.
- New canvases follow the workspace theme unless an explicit default appearance is saved.

## v1.5.7

- Desktop update checks and downloads now use Cloudflare-hosted files, preserving signed manifests and package integrity verification.
- Publish immutable platform packages before switching the update feed, with verified downloads and protection against incomplete or older releases.
- Check Seedance reference audio total duration and explain gateway media validation failures with the affected clip and actionable limits.

## v1.5.6

- Validate Seedance reference audio/video duration before submission and preserve duration metadata for character voice samples.
- Explain material conversion failures with actionable duration limits and retain request identifiers for support.
- Keep existing task polling available and prevent unsafe resubmission while provider acceptance is uncertain.

## v1.5.5

- Desktop update checks and downloads now use the current user's static HTTP/HTTPS system proxy on macOS and Windows when no explicit environment proxy is configured.
- Keep a manual update check in the sidebar and show a retry action when checking fails, instead of hiding connection failures.
- Preserve proxy bypass rules, signed manifest verification and package integrity checks throughout redirected downloads.

## v1.5.4

- Generation failures now explain the cause and the next action across canvas nodes, task history and custom channels.
- Distinguish content moderation, account quota, provider billing, invalid parameters, rate limits, uncertain submissions and failed result downloads without guessing refunds or the offending input.
- Preserve safe error codes and request identifiers for support, including business errors returned with HTTP 200 and JSON errors inside media downloads.
- Prevent unsafe unchanged batch retries; edited prompts and reference media can be submitted as new attempts after moderation failures.
- Cover all 42 currently declared BeefAPI error codes with a shared frontend and backend regression contract.
- Improved the shared model picker with a viewport-safe, internally scrollable layout and consistent single-line model options.
- Removed redundant model icons, secondary descriptions, and stale option backgrounds from model selection UI.
- Restored native right-click paste behavior in canvas prompt editors and added regression coverage.
- Added regression coverage for generation output delivery, model picker overflow, and local generation error handling.
- Added a canonical local app update script to keep one installed qisiTV application instead of accumulating duplicate builds.

## v1.5.3

- Desktop builds show the installed version in the sidebar and check for published updates on startup.
- Signed updates can be downloaded in the app, then installed with an explicit restart while keeping local projects, assets, settings and connections.
- Pending canvas, director and timeline saves are checked before restarting; failed downloads or verification leave the current installation intact.
- Maintainers can build and publish signed macOS and Windows update packages from main. Existing installations need one manual upgrade to this version before in-app updates are available.

## v1.5.2

- Improved canvas node rendering and inline image cropping, annotation, and local redraw interactions.
- Rebuilt the recycle bin with a fixed two-row viewport, selection, recovery, and confirmed permanent deletion.
- Fixed project cover selection across media nodes and canvases, including fallbacks and centered empty placeholders.
- Added a short product demo and updated the README branding.

## v1.5.1

- Initial public upstream snapshot.
- Local-first AI video workspace with image, video, audio, text, asset, canvas, and model-channel workflows.
- BeefAPI remains a built-in local channel while its model catalog is discovered dynamically.
