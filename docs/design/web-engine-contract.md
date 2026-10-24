# qisiTV Web 本机引擎合同

网页继续在 `https://cheeser.link/qisitv/` 交付。`qisitv-engine` 以 Go 的 Desktop profile 运行同一工作区、任务队列、助手宿主和业务 API，浏览器不再作为引擎项目的唯一文件写入者。`qisitv-connect open` 和 MCP 的配对辅助入口可以启动随包引擎；完整外部 Agent 工具由网页「Agent」页签发的 `qisitv mcp serve` 配置提供。

## 启动与打包

- `qisitv-connect` 同目录优先寻找 `qisitv-engine`（Windows 增加 `.exe`），不搜索 PATH。缺少引擎时原独立连接器保留旧行为；`open` 检测到旧服务时明确报告，不能把旧连接器假称完整引擎。
- `qisitv-connect open` 启动本机服务后打开固定第一方 URL。`--url` 仅输出一次性配对链接供测试或手动使用，不打开浏览器。不接受额外 URL 参数。
- 引擎默认绑定 `127.0.0.1:17372`。上游 API 绑定随机回环端口，私有启动凭据及 UI 引导凭据只由网关进程持有。
- 默认数据库目录为系统用户配置目录中的 `qisiTV/Engine/workspace`。隔离开发/测试使用绝对 `--data-dir` 或 `QISITV_ENGINE_DATA_DIR`；不读取或迁移既有用户数据库。
- 明确 `--projects-dir` 可预选根目录；普通启动必须在网页选择并确认。每个引擎 workspace 只绑定一个根目录，不能直接覆盖为另一个位置。
- 普通程序包支持相邻 `agent-host/server.mjs`、`agent-host/runtime/bin/node`（Windows `runtime/node.exe`）；macOS `.app` 也支持 Resources 布局。Node 及原生依赖按上游打包脚本固定版本配套，不能拿安装脚本的 Node 18 最低版本代替助手运行时。
- 引擎使用 SQLite CGO 构建，不能沿用连接器的 `CGO_ENABLED=0` 单二进制构建。完整 native CLI 由 `backend/cmd/beeftv` 编译为 `cli/qisitv` 或相邻 `qisitv`；历史 `backend/cmd/qisitv` 只保留旧 schema 查看，调用命令明确报协议退场，不读取旧 launch-token 或访问工作区。
- 引擎不随 MCP lease 到期退出，已接纳任务的执行不依赖网页标签页存活。进程退出和任务取消仍保留上游独立语义。
- `qisitv-connect open --skill-id ID --release-id VERSION` 只接受受限标识符，转到第一方网页的技能安装确认页，不下载或自动批准技能。OS URL handler 必须解析并校验后传这两个参数，不能把任意深链接直接当命令。

## 浏览器授权和传输

现有 `/pair`、`/resume`、`/unpair` 继续使用单次短码、来源绑定及最长十二小时的会话。`/engine/*` 需要 `Origin` 和 `X-QisiTV-Session`；AgentToken 不能充当浏览器会话。显式断开或到期会取消正在观察的流和上传，不重试或重新提交已经受理的生成任务。

网关向内部请求注入启动/引导凭据，去除浏览器传入的 Owner、Host、Client、Authorization、Cookie 和转发来源头。浏览器仍可持有自己的短期 UI 会话。响应不会下发内部启动、Owner 或 Host 凭据。

`/engine/api/*` 映射到完整 `/api/*`。请求体及响应流不整体缓存，保留 multipart、Range、ETag、Last-Event-ID、NDJSON、SSE 与取消信号。宿主运行回调、可执行命令配置和低层启停接口不向浏览器开放。网页的助手重启仍使用现有 `/assistant/host/restart`。

未确认根目录时，业务写请求返回 `folder_required`。已有项目目录不可达或文件被外部改动时，写请求返回 `project_folder_conflict`。同一规则也放在私有 API 内，因此原生 MCP 和内置助手不能绕过网页门禁创建任务。

## Shell 端点

以下路径均以 `/engine/shell` 为前缀，需要相同配对授权；成功响应为 `{code:0,data,msg}`。

| 方法 / 路径 | 输入 | data |
| --- | --- | --- |
| GET `/engine/status`（不加 shell 前缀） | 无 | `ready,version,workspaceConfigured,projectDirectory,apiPath,shellPath,storage,sessionId,expiresAt` |
| POST `/project-folders/choose` | 无 | `path,cancelled`，选择本身不授予目录写权限 |
| POST `/project-folders/configure` | `{path,confirmed:true}` | `workspaceConfigured,projectDirectory` |
| GET `/project-folders/list` | 无 | `Status[]` |
| GET `/project-folders/status` | `?canvasId=` | `Status` |
| GET `/project-folders/receipts` | `?canvasId=` | 原始导入收据数组 |
| POST `/project-folders/import` | `directory`（相对根）、`expectedWorkspaceId`、`expectedManifestSha256`、`receiptsComplete`、`receipts` | `Status` |
| POST `/project-folders/flush` | `{canvasId}` | `Status`，新画布立即绑定并写入真实文件夹 |
| POST `/project-folders/recheck` | `{canvasId}` | `Status`；仅恢复为已确认字节后解除冲突，不覆盖外部修改 |
| GET `/depth` | 可选 `?refresh=true` | 上游组件状态 |
| POST `/depth/download`、`/depth/pause` | 无 | 上游组件状态 |
| GET、PUT `/reference-storage` | PUT 为上游 Config | 不含 Secret 的 PublicConfig |
| POST `/reference-storage/upload` | `{ids:string[]}`，1 至 20 个已归属工作区的资源 ID | ID 到临时引用 URL 的映射 |
| GET `/reference-storage/upload-status` | 无 | 上游 TaskReferenceProgress |
| POST `/reference-storage/test` | 无 | `{ok:true}`；用户主动执行对象存储连通性测试 |
| GET `/storage` | 无 | 内部引擎数据目录的 `dataDir,usedBytes,freeBytes` 及构造维护命令所需的 `engineExecutable,runtimeOS` |
| POST `/maintenance/stop` | `{confirmed:true}` | `{stopping:true}`；后台任务空闲、引用传输完成且项目落盘后才关闭引擎 |

`Status` 包含 `canvasId,workspaceId,directory,state,revision,exportedRevision,pending,error,legacyReceipts`。项目迁移与所有权文件细节以 projectfolder 服务合同为准。

## 外部 Agent

网页签发的是独立客户端凭据，生成配置保留上游 `BEEFTV_DATA_DIR / BEEFTV_CLIENT_ID / BEEFTV_CLIENT_TOKEN` 协议字段，品牌和服务名为 qisiTV / qisitv。支持 Codex、WorkBuddy、Claude Code、Claude Desktop、OpenClaw、Hermes、CodeBuddy、Cursor、VS Code 和通用 stdio。WorkBuddy 用 `~/.workbuddy/mcp.json` 的 `mcpServers`，VS Code 用 `servers`，不得覆盖客户端其他配置。

旧 `qisitv-web` 在引擎模式保留启动、配对和会话发现；旧画布工具返回 `NATIVE_AGENT_SETUP_REQUIRED`，不会把新引擎画布误写到旧浏览器文件系统。需要在 Agent 页面添加新的原生 `qisitv` 配置。未注册的旧 cloud-agent admission/writeback 路径退场，新的付费执行沿用上游 agentops 的提案、审批和权限链。

## 离线存储迁移

迁移的是引擎数据库、资源和本机配置；用户独立项目根目录保持原位置。网页进入维护前先停止编辑、等待任务完成并调用 `/maintenance/stop`。引擎退出后运行随包命令：

```text
qisitv-engine storage migrate --expected-source /absolute/current/engine-directory --to /absolute/empty/directory
qisitv-connect open
```

网页的「本机引擎」维护区读取真实目录和用量，展示完整备份需要的引擎目录与独立项目根目录。选择迁移位置只生成经过 shell 引用的命令，不执行迁移。用户确认后先保存网页配置，调用停机端点；必须等待进程退出，再由用户在本机终端运行命令。Windows 命令使用 PowerShell 的调用语法，macOS/Linux 使用单引号引用；目录中的空格、引号和 shell 特殊字符不作为命令执行。

CLI 在目录指针锁内核对 `--expected-source` 与网页显示的当前目录相同，防止旧页面或自定义 `--data-dir` 实例误迁移另一份工作区。CLI 必须取得工作区锁，拒绝复制活跃 SQLite；发现未合入数据库的 WAL 或回滚日志时，要求先重新打开引擎并干净退出，不能忽略日志继续迁移。复制前后校验所有持久文件的 SHA-256 和 SQLite 完整性，原子更新固定配置位置中的目录指针，保留原目录。目标不得覆盖现有文件、安装目录、固定配置目录或独立项目根目录。磁盘未挂载时启动明确失败，不能在默认位置静默创建空工作区。失败迁移不会修改目录指针；目标中的已复制内容保留供核对。

确认新位置可用后，可再次停止引擎并运行 `qisitv-engine storage cleanup --confirm` 清理原副本；文件与迁移收据不一致时拒绝清理。第二次迁移前必须先审阅并清理上次副本，避免丢失旧副本的验证收据。迁移后外部 Agent 的原生配置含绝对数据目录，需要从 Agent 页面重新生成并更新。`--profile-dir` 仅供显式隔离环境；设置 `QISITV_ENGINE_DATA_DIR` 时拒绝修改默认目录指针。

网页更新和引擎更新分别交付。当前引擎没有接入上游 BeefTV 的签名更新源；引擎自动更新和各平台深链接注册仍需要随 qisiTV 安装包独立验收，不能宣称已经完成所有发布体验。

首次安装与侧栏更新入口共同读取网页构建版本，下载同源 `downloads/engine/qisiTV-Engine-<版本>-darwin-arm64.dmg`。网站导出脚本在构建前要求相同 `VERSION` 的 DMG 和 SHA-256 文件；默认以两个精确的 307 跳转交付 DMG 与校验文件，目标固定为 `wyuzhi/qisiTV` 同版本 GitHub Release，不使用 latest 或任意仓库地址。安装包来源为 `QISITV_ENGINE_DMG` 或仓库 `dist/engine/`；缺包、版本不符或哈希错误会中止导出。生产导出还校验当前版本 FFmpeg.wasm 对应源码包及其二进制匹配，构建后的 `licenses/sources.json` 必须包含同版本源码地址。

大体积引擎安装包不会进入网站静态上传；导出会清理既有 engine DMG/校验文件，保留旧非引擎下载与网站其他路由。上线前必须先向对应 Release 上传已验证的 DMG、SHA-256 与 FFmpeg.wasm 源码包。显式设置 `QISITV_ENGINE_DOWNLOAD_MODE=static` 可供本机预览，改为复制已校验安装包并移除当前版本跳转。当前只提供 Mac Apple 芯片、macOS 13.5 及以上的临时签名测试包，未完成 Apple 公证，不将旧 MCP 包或 GitHub release 列表作为完整引擎安装入口。

## 当前验证边界

自动测试覆盖来源/会话/凭据隔离、流即时刷新和撤销取消、multipart/Range、普通 sidecar 布局、启动选择、单次配对链接、多客户端配置、目录确认与冲突门禁。完整 Go handler 通过配对网关创建画布并写出真实 manifest 的链路已在隔离临时目录测试。没有调用付费模型或上传真实用户素材。各平台正式安装包、真实供应商模型及完整用户界面仍需各自发布验收。

### 2026-10-24 Web 助手和维护验收

`backend/cmd/qisitv-engine/assistant_gateway_test.go` 的 `TestPairedWebAssistantToolPersistsProjectFolder` 实际启动 Node `server.mjs` 和完整 Go Desktop runtime。模拟网页只使用第一方 Origin 和配对会话，内部换取短期 UI session；无配对请求返回 401，宿主回调从网页访问返回 403。本地 OpenAI SSE fixture 共收到两次请求，真实助手调用 `canvas.nodes.create` 创建文本节点，再通过同一网关读到节点。项目服务把结果写入真实 `project.qisitv.json`；之后读历史保留回复且不新增模型请求。测试覆盖的是浏览器 HTTP 协议到落盘的端到端链路，不等同于真人浏览器界面或真实付费模型验收。

复验命令（Node 指向与发行包一致的本机运行时）：

```sh
cd backend
GIN_MODE=release QISITV_TEST_NODE=/absolute/path/to/node go test ./cmd/qisitv-engine -run '^TestPairedWebAssistantToolPersistsProjectFolder$' -count=1 -v
```

本次单测实际通过，用时 3.023 秒；引擎、browserbridge、旧 agentbridge schema 与退场 CLI 四个 Go 包随后全通过。`web/test/engine-maintenance-command.test.ts` 验证 POSIX 特殊字符经过真实 `/bin/sh` 后仍为原始参数、未执行注入；同时验证 PowerShell 引用及非法路径拒绝。`TestOfflineMigrationRejectsStaleBrowserSource` 验证源目录不匹配时不创建目标、不切换目录指针。

六个独立 Chrome harness（`assistant-input`、`assistant-model-picker`、`assistant-outputs`、`assistant-production`、`assistant-proposal-invalidation`、`assistant-stop`）随后串行通过 33 项测试、245 条断言，覆盖真实前端的上传与引用、权限、跨画布撤销、技能安装、模型选择持久化、带鉴权的媒体预览、历史恢复、计划状态、提案失效和停止恢复。模型服务与业务回包使用本机 fixture，不代表远端算力或技能市场已经验收。

安装交付专项执行真实导出脚本与 SHA-256 校验，前端构建以隔离 stub 替代：缺安装包、缺校验文件、坏哈希或版本不同均在构建前失败；默认路径与显式路径的正确安装包及校验文件可导出，旧下载被保留，构建版本不能被陈旧环境变量覆盖。安装 helper、导出合同和当前助手入口共 22 项测试通过；网页类型检查通过。
