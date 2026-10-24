# qisiTV 网页完整功能对齐

状态：完整上游代码已合入 `codex/web-feature-parity`，形成 `v2.0.3-web-beta.2` 网页与独立本机引擎验收版。线上仍为 v1.5.17，本文不是正式发布或付费能力全部实测的声明。

## 目标和基线

用户要求 qisiTV 与 BeefTV 的区别在交付形式：qisiTV 通过网页使用，上游通过客户端使用；上游已具备的创作能力全部纳入，不能继续只挑少量修复。

- 当前 qisiTV：`cc973fd9dcd70a813b4aa4e7325e156f8c6574fd`。
- 对齐上游：v2.0.3，`e13263c948fbbada3724442fc2c9ee6aaea6cfa2`。
- 保留 qisiTV 品牌、本机独立项目文件夹、外部 MCP 多客户端以及现有 qisi API / LikeAI 配置。
- 无需画布注册、登录或云端项目库。外部模型服务或技能投稿服务的认证与画布账号分开。
- 新目标覆盖过去“不需要网页内助手”的限制，内置助手与外部 Agent 都须可用。
- 已确认当前网站部署授权。移植保留上游许可证及素材许可证；服务授权不替代外部 API 凭据。

## 合并前的功能缺口基线

| 模块 | 必须对齐的行为 | 合并前状态与适配点 |
| --- | --- | --- |
| 创作助手 | 多轮会话、附件、模型选择、技能固定版本、计划、生成确认、补充要求、停止、恢复、整轮撤销、审片与成片交付 | 网站隐藏旧助手；上游是新的 `agent-host/`、Go assistant runtime 和 NDJSON 合同，不能直接恢复旧面板。 |
| 可复用工作流 | 从选区/已完成任务保存、图编辑、类型化输入输出、模板修订、步骤执行、选图暂停、取消、失败恢复、结果回填 | 上游 `/canvas-workflows` 与 `/canvas-workflow-runs` 使用自己的 resource/task ID，需真实浏览器目录及任务适配。 |
| 技能库 | Markdown/ZIP/GitHub 导入、文件预览、启停、版本固定、更新、回退、私人改写 | 当前 `/skills` 跳首页，现存技能 API 仍指向未部署的 Go 服务。 |
| 技能市场 | 搜索、指定版本安装、完整性验证、安装链接、投稿准备、私有上传、公开送审、状态查看 | 上游仓库只有市场客户端；远端服务为 `beeftv.app/api/beeftv/skillhub/v1`。保留明确授权/确认步骤，不能声称已拥有独立市场服务器。 |
| AI 超分 | 图片和视频批量处理、冻结本批参数、任务回执、刷新恢复、原结果取回 | 当前只有图片插值放大。上游四种 Topaz 模型依赖 BeefAPI 算力；需实际可用通道，不能把插值或其他模型标为 Topaz。 |
| 3D 导演台 | 角色动作/路径、相机路径、机位、骨骼、群众、白膜录制、全景、场景检查 | 多数是可移植 Three.js/浏览器代码；媒体保存走当前项目目录，模型静态资源须适配 `/qisitv/` base。 |
| 深度与转换 | 深度图、线稿、姿态、深度视频、组件安装/下载校验、设备回退、任务恢复 | 网站转换节点直接禁用；深度视频依赖 Python/PyTorch、Video Depth Anything 和 FFmpeg。 |
| 时间线 | 剪辑、字幕、预览、渲染计划、原生/WASM 导出、取消、可编辑工程与结果保护 | 上游 WASM 路径也先请求 Go `/timeline/render-plan`，需移植计划编译或执行端口。 |
| 影音理解/转写 | 独立检查、审查记录、云转写/本机转写、失败说明 | 当前网站无完整业务适配；需要多模态/ASR 实际模型及本机执行能力。 |
| 兼容预览 | H.265 原片保留，按需 H.264 预览，进度、缓存、重试 | 适配 WASM/原生转换，引用与下载始终指向原片。 |
| 任务中心 | 完整列表、详情/日志、未确认提交、下载进度、取消/恢复、任务与节点对应 | 当前 `/tasks` 跳首页；先补浏览器任务合同再开放。 |
| 大素材与备份 | 分片/中断恢复、完整性验证、大文件导出、进度、取消、缺失资源提示 | 现行上传4MB、代理约4.2MB、结果128MB；不能仅上调数值绕过托管平台限制。 |
| 插件与 Eagle | 插件目录、安装、配置、素材查询、引用 | 当前网站关闭插件中心；本机服务访问需窄授权端口。 |
| 项目/短剧/历史 | 章节角色/场景/道具提取、任务回填、磁盘版本查看/恢复、素材引用保护 | 适配当前项目结构；磁盘已有 revision 文件，不能另建相互不同步的 Go 项目库。 |
| 外部 MCP | 新工作流、技能、媒体执行和助手业务操作 | 当前 MCP 白名单主要支持基础节点/生成；需共用新的业务操作层。 |
| 其他渠道能力 | 图层拆分/多图、H3 实时导演等上游支持的协议与结果语义 | 与具体外部模型绑定；逐项实现真实协议与能力检测，不能用同名空入口算完成。 |

完整工作流至少覆盖 16 种算子：`generate.image/video/audio/text`、`video.depth/trim/merge`、`image.select/describe`、`image.ai-upscale`、`video.ai-upscale`、`image.crop/resize`、`video.crop/frame/audio`。

## 已确定的运行方式

用户已选择第一项：

1. 网页是全部操作入口；浏览器能完成的工作在浏览器运行。原生媒体、深度模型和 Node 助手宿主通过同一个本机引擎按需运行，复用现有 MCP 的配对与自动管理体验。素材仍留本机。
2. 所有功能无需本机程序；浏览器不能运行的部分放网站服务器。需要新增计算与任务服务，并上传相关素材，须重新明确存储、删除、成本和隔离方式。

采用网页操作和本机引擎。本次完整功能版本进入工作区前连接引擎，统一保存、助手和工作流合同；旧线上 v1.5.17 仍保持原有独立网页模式，两个版本不能同时写迁移后的项目。首次安装需要用户本机运行已校验程序，后续以系统唤起入口启动；网页本身不能凭空启动未安装程序。引擎会话与进行中任务独立保活，不能依赖 Codex 一直开着。不扩大项目上传范围，不建立云端工作区。

## 共用业务和保存合同

手动 UI、内置助手、工作流、MCP 共用上游本机 operation contract。调用包含项目/会话范围、当前修订、幂等操作 ID、执行类型及必要参数。引擎模式下由同一本机 Go 工作区提交；SQLite 事务中的 outbox 驱动真实项目文件夹导出。浏览器不与引擎同时写同一项目，断线后不能回退成浏览器权威。

资源使用稳定 ID、文件摘要、相对路径和 MIME；可展示临时 URL 不构成资源身份。任务保存执行快照、模型身份、源参数、上游回执和输出绑定；敏感请求头、API Key、连接令牌不进入项目、工作流模板或诊断日志。

画布、绘图、媒体和任务回执投影到每项目真实目录，v2 manifest 显式标记 engineAuthority。工作流业务状态、助手会话、插件配置与技能版本也保存在本机引擎数据目录；完整备份必须同时保留项目根目录和引擎数据目录，不能声称复制一个项目文件夹就能恢复全部助手会话。IndexedDB 只作缓存。旧格式导入先校验原目录身份、文件摘要和任务回执，保留旧清单备份；运行中任务必须先结束或处理本地等待。

收到上游受理回执后，取消浏览器等待或刷新页面不等于供应商取消。状态未知时查询原任务，禁止自动重新创建付费任务。任何重试都区分查询/取回、未提交重试和新收费生成。

## 服务适配的实证边界

旧独立网页的 `browser-likeai-client.ts` 拒绝 tools、execution 和非空 textHistory，不能作为完整助手。完整引擎版保留 qisi API / 官方 LikeAI 媒体服务，同时允许助手独立配置支持工具调用和多轮会话的文本协议与模型。导入或刷新媒体目录不会覆盖已选择或明确清空的助手模型。

LikeAI [官方公开文档](https://task.likeai.pro/api-doc) 的图片 `huoshan_image_super_resolution` 和视频 `tengxun_video_super_resolution` 已接入 AI 超清节点及任务恢复，参数、鉴权、原资源归属和回执通过本机 mock 测试。它们不等于 Topaz；上游 Topaz 路径保留，并在渠道设置中提供显式连接入口，不默认开通钱包或更换助手服务。两类服务都需要用户配置有效渠道，尚未执行收费端到端验证。检查文档与离线测试不构成收费生成授权。

上游技能市场服务端不在当前源码内。市场浏览、安装及投稿客户端可以适配，但独立目录/审核服务需要单独实现；不能擅自复制远程用户技能或代用户公开投稿。

## 实施和验收顺序

| 阶段 | 交付条件 | 状态 |
| --- | --- | --- |
| 1. 运行与操作基础 | 统一操作/资源/任务合同，目录格式迁移和授权边界 | 引擎与配对网关、v1→v2 迁移已实现；事务/崩溃/冲突及真实 Go 路由落盘测试通过 |
| 2. 前端与媒体 | 导演台、图像处理、时间线渲染计划与真实超分适配 | 完整上游前端和媒体后端已合入；真实 Chrome 上传、灰度转换、调色、预览与下载通过；原生 FFmpeg 导出通过，超分协议使用本地 fixture 验收 |
| 3. 技能和工作流 | 本机包/模板/修订、16算子、暂停选图、取消、恢复、落盘 | 上游实现已合入；技能文件鉴权已适配，旧媒体补齐可信元数据后实际执行合并/时长算子通过 |
| 4. 创作助手 | 工具调用模型、宿主/会话、方案审批、补充/停止、撤销、续跑、审片交付 | Node 24.22.1 与 SDK 宿主已打包；配对网页 API → 真实宿主 → 本地模拟模型 → 工具修改画布 → 项目目录实测通过，六组浏览器助手测试通过 |
| 5. 服务与完整回归 | 市场、Topaz/H3等实际服务、MCP新操作、大素材、诊断、升级恢复 | 多客户端 native agentops 接入；外部服务需要用户配置，未进行收费验证 |

每个模块必须走通“入口 → 配置 → 执行 → 进度/错误 → 结果 → 本机落盘 → 重新打开/原任务恢复”。菜单出现、编译通过和 mock 请求成功不能单独作为完整对齐证据。外部服务未配置、平台未实测、收费验证未授权时如实记录，保留未完成项。

最终验收包含：旧项目可打开、素材不丢失、复制/引用身份不变、重复点击不重复收费、切换项目的迟到响应不串项目、权限撤销后禁止写入、失败清晰可恢复、MCP与手工编辑并发不覆盖、原生执行与浏览器路径分别验证。

## 审计代码入口

- 上游：`agent-host/`、`backend/internal/assistantruntime/`、`assistantturns/`、`operations/`、`canvasworkflow/`、`skillhub/`、`topaz/`、`depthcapture/`、`depthruntime/`。
- 上游 UI/API：`canvas-assistant-*`、`use-canvas-assistant*`、`agent-assistant.ts`、`canvas-workflows.ts`、`skill-market.ts`、`media-upscale.ts`、`timeline-export.ts`、`director-*`。
- 当前网站：`browser-agent-commands.ts`、`browser-agent-connection.ts`、`browser-project-folder.ts`、`browser-likeai-client.ts`、`browser-likeai-tasks.ts`、`services/api/workspace.ts`、`router.tsx`。

开发验收使用隔离的 `.local/engine-smoke/` 数据与项目目录，未改用户作品、未调用收费模型。测试日志位于 `.local/parity-*.log`；不把编译、mock 通过等同于收费供应商端到端通过。

### 已执行的完整应用验收

- beta.2 安装包复制到仓库外、使用系统 PATH 启动：签名/文件摘要、连接器唤起引擎、明确选择项目目录、原生 MCP 工具、Node 宿主、FFmpeg H.264/AAC、迁移中断恢复及项目媒体缺失保护共八项检查通过。
- 真实网页点击灰度转换：生成 canonical `resource:` 引用、写入项目清单与素材文件，刷新页面后结果仍可见。检查日志：`parity-browser-conversion.log`。
- 人为移走合成项目的一张图片：网页显示文件夹保存失败；还原原文件后点击「核对并恢复写入」，校验完成并恢复已写入状态。检查日志：`parity-browser-folder-recovery.log`。
- 完整网页断线恢复连续两次通过：真实 UI 编辑并保存，停止引擎后再次编辑、关闭标签页，重启引擎并重新配对后恢复离线草稿；最终 manifest 从版本 3 更新到 4，内容一致。可复现脚本：`scripts/smoke-engine-web-disconnect.mjs`，只允许明确指定且匹配的隔离工作区。
- 新版仅交付 Apple Silicon、macOS 13.5+ 的引擎安装包；临时签名、未做 Apple 公证。Intel Mac、Windows、Linux 全能力安装包不在本次实机验收范围，界面明确说明；没有将旧 MCP 下载冒充新引擎。
- 远端收费模型、技能市场投稿、Topaz、H3 及需要另行下载的深度模型，没有进行真实付费或远端写入验收；保留配置/授权/进度/错误合同，不能宣称供应商端全部实测通过。

### 媒体浏览器回归补充

- 音视频分离使用原项目、用户 scope 和源资源身份；切换项目、A→B→A、替换源视频后，迟到的 FFmpeg 结果不会上传或写入另一个项目。原生媒体保存先提交引擎并回读确认，浏览器缓存挂起不会阻断磁盘保存；失败不会显示“已保存”。`canvas-audio-persistence.browser.test.ts` 和 `canvas-media-persist-scope.test.ts` 覆盖这些路径。
- 导演台内置角色兼容旧 `/canvas/` URL 和 `/qisitv/canvas/` 部署路径，自定义模型保持原 URL。`director-bundled-assets.test.ts` 分别验证无 Vite 环境和子路径部署；骨骼及视觉回归沿用原检查。
- 图片引用预览以项目、资源及预览 URL 区分请求；旧请求完成或释放时只能清理自身的缓存 Promise，避免跨项目或 A→B→A 清掉新请求。独立图片 fixture 保留原有三个浏览器检查，视频预览 fixture 和 lease 检查同时保留。

2026-10-24 前端完整套件已运行到结束：4,276 通过、1 失败、15 跳过。唯一失败为发布合同仍匹配修改前的 `import.meta.env` 字串，已同步断言并定向通过该文件全部 5 项；完整运行日志保留原结果。随后显式启用 14 项真实媒体验收，全部通过：原生 FFmpeg 的混音/中文字幕/空隙与淡入淡出 3 项、时间线浏览器 WASM Worker 8 项、画布合并 Worker 2 项、视频兼容预览 1 项。剩余 1 项仅为未提供 `QISITV_SEGMENT_QA_MP4` 的额外外部样片检查，同文件自动生成的真实媒体编码检查已通过。日志分别为 `.local/parity-web-suite-complete.log`、`parity-release-contract-retest.log` 与 `parity-optional-*.log`，最终 TypeScript 检查通过。以上不包含收费生成验证。

PR #10 首轮云端 Linux Backend 全 Go 检查、Windows 存储迁移及 Director Chrome 83/83 断言通过。Web 两个夹具在 CI 的 Bun 1.3.9 中路径解析失败，已用相同版本复现并修正，1.3.9 与 1.4.2 的真实 Chrome 复验均通过。旧安装 CI 调用已删除的 Wails 构建脚本，现改为四平台本机引擎源码检查，Mac ARM 另行打包并做完整离仓库验收；发布检查中 Ubuntu 镜像的断言改为检查真正运行 apt 的任务，完整 233 项本机通过。修正后的云端结果须在对应提交重新运行后确认。

提交 `8ac9c8eb` 的云端 Quality 四项已全部通过：完整 Backend、Web、Release publisher、Windows storage migration。独立引擎流水线的 Linux、Intel Mac、Apple Silicon Mac 原生检查通过；Apple Silicon 的固定源码媒体构建、App/DMG 打包及八项离仓库验收也通过。Windows 引擎检查另发现 SQLite 只读校验 URI 未规范化盘符，现修正为绝对路径与正斜杠，并补真实数据库重开、拒写、原文件不变和无日志文件的回归检查。两处 Windows 测试夹具也改为解析 JSON 路径及实际子进程环境，保留原有行为断言；修正后的 Windows 云端结果单独跟踪，不以其他平台通过代替。

GitGuardian 扫描合入的上游历史时标记两处测试样例：`agent-host/model-proxy-cases.mjs` 的仅供本机子进程信任的自签测试证书，以及 `agent-host/eval/sim-go.test.mjs` 的脱敏断言输入。已核对两者均为合成 fixture，不含用户密钥；当前源码改为测试运行时生成证书和随机 token，相关 11 项通过。没有删除上游提交历史、关闭扫描或跳过安全检查；历史告警的分类由 GitGuardian 工作区处理。

### 旧合同测试替代

- `local-agent-sync.test.ts` 复制已移除的 Agent patch/repository 私有实现，已退场。当前统一提交与并发保护由 `canvas-refresh-editor-conflict.test.ts`、`canvas-external-document-merge.test.ts`、`canvas-external-revision.test.ts`、`canvas-external-revision-store.test.ts`、`canvas-patch-merge.test.ts` 和 Go operations 修订/幂等测试覆盖。
- `browser-workspace-persistence.test.ts` 假定完整 UI 永不访问 Go、浏览器独立写项目，与本版单一引擎权威相冲突，已退场。旧格式的安全迁移仍由 `browser-engine-migration.test.ts`、`browser-project-folder.test.ts` 及 Go projectfolder 故障/冲突测试覆盖；不会恢复浏览器与引擎双写以迁就旧测试。
- `canvas-resource-reload-persistence.test.ts` 及 `generation-storage-consistency.worker.ts` 中专属的三个 `reload-*` 场景依赖已退场的浏览器 folder-ack 回填，已移除；worker 的媒体清理、跨 scope 引用、提交竞争及复制保存场景保留。恢复期间手工编辑、持久化失败不确认、崩溃后按原任务幂等回填由 `canvas-task-bind-cutover.test.ts` 覆盖；原生落盘与磁盘冲突由 Go projectfolder 的 `TestConflictNeverOverwritesExternalManifestAndRejectsWrites`、`TestProjectionRecoversRenameBeforeAcknowledgement`、`TestProjectionRejectsBrowserOnlyMediaAndKeepsConfirmedManifest` 覆盖；网页重载入口及失败反馈由 `video-recovery.browser.test.ts` 与 `canvas-resource-reload-feedback.browser.test.ts` 覆盖。不能为旧断言恢复引擎与浏览器双写。
- `canvas-resource-reload.test.ts` 导入已删除的 `reloadCanvasGenerationResource`，旧“修订变化一律拒绝”和“外部 Agent 结果一律拒绝”不适用于统一引擎绑定，已退场。现有 `retrieveTaskResult` 通过原任务 `/query-provider` 取回，成功后调用 `canvas.task.bind`；节点“继续取回”则查询原任务并仅恢复暂停的结果下载。`video-recovery.browser.test.ts` 实际运行 hook，覆盖双击去重、失败后同回执重试、取回期间换任务/删除/切换项目不绑定，以及保留手动标题与位置；`canvas-task-bind-cutover.test.ts` 继续覆盖绑定期间的新任务和手工内容、scope/修订冲突及持久化失败。任务/资源归属和 Agent 与手动结果一致性由 Go `TestGenerationDeliveryRejectsForeignResourceAndSkipsCancelled`、`TestGenerationDeliveryIsIdenticalForManualAndAgentMetadata`、`TestGenerationDeliveryBindExistingRequiresOwnedReadyResource` 覆盖。
