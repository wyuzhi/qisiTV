# 项目文件夹与本地 Agent：实现说明

状态：项目目录保存、恢复、旧缓存迁移、网页配对和 MCP 命令处理已实现。使用步骤见[网站版、本地项目文件夹与 Agent](../content/docs/backend/browser-workspace.mdx)。本文记录当前架构与边界，不把尚未执行的实机或收费验证写成已通过。

## 产品行为

用户用桌面 Chrome / Edge 打开网站，在「本地文件与 Agent」选择项目根目录。每次新建项目产生一个真实子目录，导入素材与生成结果随画布保存到其中。普通网页创作只需要浏览器；需要 Agent 时在页面选择客户端，复制对应安装指令，由具有本机命令执行能力的 Agent 完成准备与配置。安装一次后，加载 MCP 工具、获取配对码，再在网页确认连接。没有注册、登录、积分、内置 Agent 聊天或云端项目数据库，模型服务保留 LikeAI。

浏览器始终是文件的唯一写入者。连接器不接管目录写入，也不建立另一份项目数据库；无论用户手工修改还是 Agent 发命令，最终都由同一网页状态与目录保存服务提交。

## 项目目录与格式

```text
qisiTV 项目/
└── 项目名称-项目ID/
    ├── project.qisitv.json
    ├── references/
    ├── images/
    ├── videos/
    ├── audio/
    ├── exports/
    └── .qisitv/
        ├── revision-1.json
        └── revision-2.json
```

项目清单的固定格式是 `format: "qisitv-project"`、`formatVersion: 1`，包含 `revision`、`project`、`media` 与可选 `drawings`、`deletedAt`。媒体索引由存储键映射到项目内相对路径、MIME、字节数、SHA-256 和媒体类型。文件以摘要命名，导入时复制到项目内，原始素材移动不会使副本断链。绘图原稿及其预览、渲染媒体也随项目保存。

目录名称由清理后的标题加项目 ID 构成；已绑定项目改标题不改目录。`references` 用于导入素材，生成媒体按类型进入 `images`、`videos`、`audio`，应用导出进入 `exports`。项目文档中的临时 `blob:` / `data:` 地址转换为相对文件引用，重新打开时恢复浏览器预览 URL。

每次保存依次写不可变媒体、上一个修订的 `.qisitv/revision-N.json`、当前清单。使用文件写入流的关闭操作提交单个文件；只有媒体和清单提交成功才返回成功。已经保存的历史素材不在这里自动删除，避免破坏旧版本。项目删除写入 `deletedAt`，不会立即清空磁盘素材目录。

模型 API Key、认证请求头及连接令牌被排除在清单之外。Agent 的幂等回执随项目保存，内容仅含请求摘要、节点 ID、任务 ID 与提交状态，不含 Key。浏览器仍保存目录句柄、媒体缓存、配置及任务状态；这些缓存不能代替文件夹中的正式项目。

## 保存、恢复与冲突

目录授权只由网页按钮的用户操作触发。远程 Agent 不能弹出目录选择器或绕过权限。目录失联、授权失效或不支持目录 API 时，保存明确失败，界面不退回 IndexedDB 后宣称磁盘成功。

打开根目录会扫描子目录清单、检查格式及修订，并验证媒体的路径、大小、摘要后恢复。缺失或修改过的媒体会报告错误；同一根目录内重复项目 ID 会被拒绝。清理网站缓存后可以重新选择根目录恢复已经完整写入的项目；更换浏览器或电脑时需要重新设置 LikeAI Key。

旧 IndexedDB 项目在选择目录后仍然保留，用户通过「保存这些项目到文件夹」迁移。磁盘版本与缓存内容不同，缓存副本先保存在版本记录中；磁盘恢复成功前不删除旧数据。未完成任务与供应商回执仍有浏览器状态依赖，迁移环境前应先等结果落盘，不承诺清空缓存后可以继续全部未完成任务。

同一网站来源下的目录写入通过 Web Locks 串行化，同时比较清单修订号。另一个标签页已经保存新修订时，旧修订不能覆盖它。Web Locks 不跨浏览器、用户配置或网站来源共享，因此不支持在不同浏览器中同时编辑同一物理目录；跨来源修订检查不能替代互斥锁。Agent 写操作要求 `baseRevision`，批量操作先在副本上完整校验再修改真实状态。异步读取参考或素材期间，用户改变了项目内容也会触发冲突。活跃编辑器通过 `publishCanvasRefresh` 三方合并，避免把用户尚在编辑的字段静默覆盖。

## 本地连接器与 MCP

### 安装体验与 LibTV 的区别

LibTV 的[插件页面](https://www.liblib.tv/plugin)采用「复制一段指令给 Agent 安装，再完成账户授权」的入口；起司 TV 沿用这种由 Agent 完成安装的操作方式。底层连接不同：LibTV 的[公开 MCP 配置](https://github.com/liblib-ai/marketplace/blob/main/plugins/libtv/.mcp.json)指向远程 HTTP 服务 `https://mcp.liblib.tv/mcp`，[marketplace 配置](https://github.com/liblib-ai/marketplace/blob/main/.agents/plugins/marketplace.json)要求安装时认证；该服务提供 [OAuth 受保护资源元数据](https://mcp.liblib.tv/.well-known/oauth-protected-resource/mcp)，对应其账户授权流程。

起司 TV 插件使用本机 stdio MCP 与回环 WebSocket，用户授权的是当前电脑上的网页会话和项目目录。这里保留无账号、本地文件保存和一次性网页配对，不添加远程 HTTP MCP、OAuth 账号登录或云端项目同步。安装步骤相似不代表数据架构相同。

### 命令路径

```text
本机 Agent / stdio MCP
        │ qisitv-web 工具
        ▼
qisitv-connect · 127.0.0.1:17372
        │ 已配对的 WebSocket 会话
        ▼
网页命令处理器 → 当前画布状态 → 项目文件夹
        │
        └─ 生成功能 → 网站临时 LikeAI 转发 → LikeAI
```

客户端启动 `qisitv-connect mcp` 时，连接器自动启动或复用后台本机服务，只监听回环地址。用户不需要另行运行 `start` 脚本或保持终端窗口。MCP 工具 `qisitv_pair` 无参数，在网页未连接时也可调用，返回临时配对码与网页入口。用户在网页输入配对码后建立 WebSocket；页面必须保持打开。

配对码十分钟有效、一次使用、错误五次失效，浏览器会话最长十二小时。只允许明确的网站来源，浏览器令牌与 Agent 令牌隔离，不以知道端口作为授权。网页刷新或断线后由 Agent 再次调用 `qisitv_pair`，用户重新确认连接，不自动重播命令。

### 多客户端安装

网页提供 Codex、Claude Desktop、Claude Code、OpenClaw、Hermes、CodeBuddy、Cursor、VS Code、通用 MCP 九种安装指令。它们使用同一个 stdio 服务端，配置格式和工具加载方式分别适配，不把 Codex 插件安装命令复制给其他客户端。

Codex 保留公开插件入口：Agent 检查 Git、Node.js 18+ 和 `codex plugin`，从 `https://github.com/wyuzhi/qisiTV.git` 的 `main` 分支添加 `qisitv` marketplace，安装 `qisitv@qisitv`，在新任务加载 `qisitv-web`。其他入口让 Agent 克隆同一官方仓库到临时目录，执行 `node plugins/qisitv/scripts/prepare.mjs --json`。准备程序复用固定 Release 与 SHA-256 校验，把可执行文件和完整许可证保留在用户的稳定目录，只向 stdout 输出 `{command, args: ["mcp"]}`；不启动服务，不改客户端配置。

Agent 使用返回的真实绝对路径，通过客户端原生命令或 JSON / YAML 合并 `qisitv-web`，备份已有配置并保留无关字段。同名项先核对，不盲目覆盖。配置不依赖临时克隆目录；完成后可删除该临时目录。网页按客户端提供安装指令和官方说明，程序路径以 `prepare` 的输出为准。环境缺失、下载失败、配置失败、工具未加载分别报告，只有真正调用 `qisitv_pair` 才能提供配对码。

Claude Desktop 普通聊天若没有本机 shell，由可执行本机命令的 Agent 完成准备，再由用户在 Desktop 设置合并配置。客户端配置不意味着用户已经授予目录读写、网页配对或付费生成权限。各客户端的字段、CLI、配置位置和官方来源统一维护在[使用教程](../content/docs/backend/browser-workspace.mdx#各客户端的配置入口)，包括 CodeBuddy CLI / IDE 的区别，以及 VS Code 的本机用户配置。

所有入口要求 MCP 进程与浏览器同机。远程 OpenClaw / Hermes Gateway、云端或容器 Agent 的回环地址不能直接连接用户电脑；Claude 网页版不能加载本机 stdio MCP。这里不增加 HTTP 公网桥接，也不自动开放端口。

系统安装包和 `install-codex.command` / `.cmd` / `.sh` 留在手动下载的折叠备选。手动脚本将程序复制到用户固定位置后注册，因此成功后可删除解压目录。插件、自动准备和手动包是替代路径，不要求重复安装。网页不能自行修改客户端配置。插件名称 `qisitv` 与旧 Go 工作区的 `qisitv` MCP 不表示同一数据源；画布命令明确使用 `qisitv-web`。多个网页会话由 `canvas_list_sessions` 明确选择，不猜测最近项目。

### 命令执行

命令协议为 `{id, operation, args}`，响应为 `{id, result}` 或 `{id, error: {code, message}}`。网页暴露画布读取、创建、节点和连线修改、参考设置、批量操作、素材导入、模型列表及生成任务操作。`canvas_current` 读取当前路由和编辑器选区；未打开任何画布时返回空交互。写入前校验项目已绑定所选目录，成功响应等待实际文件提交。

连接器的 `asset_import` 只读取 Agent 明确指定的本机媒体路径，随后发送名称、MIME 和字节，不把绝对路径交给网页。最大文件为 32 MiB。项目目录读取、生成调用与文件写入仍由网页负责，连接器没有通用网页文件系统接口。

## 付费任务与结果

`task_submit` 必须包含目标节点、所选模型、提示词、授权范围、最新修订和稳定幂等键，每次一个任务。参考素材从指定画布中的节点、连线和首尾帧字段解析；调用方可用明确的参考节点列表覆盖。模型列表不返回 Key，工具拒绝密钥、请求头和服务地址参数。

提交意图先写入项目，再调用现有 `prepareBackendGenerationTask` 和浏览器 LikeAI 任务服务。重复幂等键与同一请求复用任务；更改请求却复用键会被拒绝。网络中断后不重新创建收费任务，有供应商编号只查询，没有回执则提示先核对。任务回执和项目意图之间发生中断时，按稳定操作 ID 寻找已有任务恢复。

任务终态由订阅处理器回填原绑定节点并保存，即使用户已切换至另一个画布。文件权限或修订冲突阻止回填时会发出保存错误，`task_apply_result` 可在问题解决后重试附加原结果，不重新生成。关闭整个网页后无法继续在后台写磁盘；重新打开后由任务恢复逻辑或显式查询、回填继续处理。

普通画布操作没有付费生成副作用。测试使用模拟任务；真实付费生成仍需当次明确的模型、秒数或数量与费用授权。

## 已执行的验证

共用启动器与准备程序的 20 项 Node 测试已通过。macOS ARM64 实测完成首次从 GitHub 下载、SHA-256 校验、MCP `initialize` 和 `tools/list`；使用已校验缓存调用 `qisitv_pair` 成功，stdout 保持纯 JSON-RPC，MCP 退出后桥接服务约 31.2 秒关闭。

通用 `prepare` 在独立缓存中实测返回配置 JSON，原生程序摘要匹配，三份顶层许可声明与源文件逐字一致，另有 12 个许可证文件成功复制；准备过程没有启动服务或修改用户客户端配置。以上证明 macOS 的共用运行链，不代表九种客户端界面、其他操作系统或付费生成均已验收。

## 当前边界

- 多客户端入口依据各客户端官方文档适配。共用 runtime 的验证不能替代九个客户端逐一实机验收；未执行的客户端或平台测试不写成已通过。
- 文件夹直接读写要求支持目录 API 的桌面 Chrome / Edge。连接器不会让不支持该 API 的浏览器获得目录保存能力。
- Agent 素材导入的 32 MiB 限制与 LikeAI 参考上传限制不同；网站向 LikeAI 上传单文件上限为 4,000,000 字节。
- 单个生成结果自动下载上限为 128 MiB；超限或下载失败保留原结果链接，不能声称已落盘。
- 目录选区是根目录，不提供任意绝对路径写入。连接 Agent 期间切换根目录需先断开连接。
- 所有平台包均由同一 Go 连接器源码构建：Mac Apple 芯片 / Intel、Windows x64 / ARM、Linux x64 / ARM。构建不等于对应操作系统实机验收；Mac 与 Windows 包暂未代码签名，Mac 也未公证。
- 原 Go 工作区的 SQLite 与统一资源库仍独立存在，没有自动迁移成网站项目文件夹的功能。

## 代码入口

- `web/src/services/browser-project-folder.ts`：目录授权、文件格式、媒体写入、修订检查与恢复。
- `web/src/services/local-workspace-repository.ts`：网页项目保存、迁移与恢复的统一入口。
- `web/src/services/browser-agent-connection.ts`：配对、WebSocket、当前画布交互与命令应答。
- `web/src/services/browser-agent-commands.ts`：操作校验、画布变更、任务授权与回填。
- `web/src/services/browser-likeai-tasks.ts`：任务回执、状态查询、媒体下载及幂等。
- `web/src/pages/local-setup/index.tsx`：用户设置与安装教程。
- `backend/internal/browserbridge/`、`backend/cmd/qisitv-connect/`：本机桥接与 MCP。
- `scripts/build-qisitv-connect.sh`、`scripts/export-qisitv-website.sh`：连接器包和网站导出。
- `plugins/qisitv/scripts/prepare.mjs`：自动准备本机程序与许可证，输出客户端无关的 stdio 配置；`run.mjs` 为 Codex 插件启动入口。
