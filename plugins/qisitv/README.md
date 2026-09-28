# qisiTV Codex 插件与通用 MCP 准备程序

让本机 Agent 操作 <https://cheeser.link/qisitv/> 中的本地创作画布。Codex 使用插件，其他 stdio MCP 客户端使用同一份本机连接器。无需 qisiTV 账号，项目与素材写入用户在网页授权的文件夹。

## Codex 安装

需要 Git、Node.js 18+ 和支持 `codex plugin` 的 Codex。让 Agent 执行：

```sh
codex plugin marketplace add https://github.com/wyuzhi/qisiTV.git --ref main
codex plugin add qisitv@qisitv
```

然后在新的 Codex 任务中说：“连接 qisiTV，调用 qisitv_pair 给我配对码，先不要付费生成。”

## 其他 Agent

网页在 Codex 后依次提供 WorkBuddy、Claude Desktop、Claude Code、OpenClaw、Hermes、CodeBuddy、Cursor、VS Code 和通用 MCP 的安装指令。由能在本机执行命令的 Agent 检查 Git、Node.js 18+，克隆官方仓库 `https://github.com/wyuzhi/qisiTV.git` 的 `main` 分支到临时目录，在仓库内运行：

```sh
node plugins/qisitv/scripts/prepare.mjs --json
```

成功时 stdout 仅输出 `{ "command": "真实绝对路径", "args": ["mcp"] }`。程序和完整许可证保留在稳定用户目录；该命令不启动服务，也不修改客户端配置。Agent 再按所选客户端的官方 CLI 或 JSON / YAML 格式添加 `qisitv-web`，先备份已有配置，保留其他服务与字段。配置必须使用实际返回的 `command`，不能指向临时克隆目录；完成后可删除临时克隆。

WorkBuddy 在「插件 → MCP 服务器 → 配置 MCP」（较新版为「连接器 → 自定义连接器」）中配置用户级 `~/.workbuddy/mcp.json`。先备份，再将准备结果合并到 `mcpServers["qisitv-web"]`，保留其他设置；确认绿色状态，并实际调用 `qisitv_pair`。[官方说明](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)

Claude Desktop 普通聊天若不能执行本机命令，由其他本机 Agent 帮助准备，再通过 Desktop 设置粘贴配置。CodeBuddy 的 CLI 和 IDE 分别配置，VS Code 使用本机用户配置；各客户端命令、字段与官方依据见[网站版文档](../../docs/content/docs/backend/browser-workspace.mdx#各客户端的配置入口)。不是所有客户端都能使用 Codex 的插件命令。

## 配对与使用

加载 MCP 工具后，让 Agent 调用 `qisitv_pair`，先不要生成素材。打开网页的「本地文件与 Agent」，选择本机项目根文件夹并输入返回的配对码。之后打开项目，保持网页运行，即可读取选区、创建节点、组织连线、导入素材。刷新网页后重新获取配对码。

Agent 进程、连接器与浏览器必须运行在同一台电脑。Claude 网页版、远程 Gateway、SSH / 容器或云端 Agent 不能直接使用用户电脑的回环连接。工具未加载或配对失败时应说明实际状态，不编造配对码或完成结果。

## 运行方式

Codex 通过标准 stdio MCP 启动 `scripts/run.mjs`。它与 `scripts/prepare.mjs` 共用 `runtime.mjs`，按本机系统与架构从本仓库固定 GitHub Release 获取 `qisitv-connect`，按 `runtime.json` 校验 SHA-256，并原子写入用户数据目录的 `qisiTV/MCP/runtime/<version>`。Mac、Windows、Linux 的 x64 / ARM64 均有对应程序。仅首次或缓存损坏时需要下载；诊断写入 stderr。其他客户端通过 `prepare` 返回的绝对路径直接启动程序，参数为 `mcp`。

本机程序自动管理 `127.0.0.1:17372` 的网页桥接服务，只接受已配对网页；多个 MCP 会话共享服务，最后一个会话关闭后空闲退出。浏览器是项目唯一写入者，网页关闭后不能继续操作画布。无需单独保留终端窗口。

网页仍需目录和本地网络权限。模型生成由用户配置 LikeAI Key，且须事先明确费用授权。插件本身不提交收费生成、不收集 Key、不建立云端项目数据库。

## 发布与验证

启动器的固定版本与六平台校验值在 `runtime.json`。发布新版本时先构建，上传新标签的 GitHub Release，再更新对应固定校验值；不可覆盖已发布版本的二进制。随插件附带程序及第三方许可证。

客户端配置指引与共用 runtime 验证分开记录；不能把一次 stdio 冒烟或六平台构建写成所有客户端、所有系统的实机验收。

当前共用程序的 20 项 Node 测试通过，并在 macOS ARM64 验证了下载校验、MCP 初始化与列工具、配对码、退出后桥接关闭，以及 `prepare` 的 JSON 输出与许可证复制；未以此声称各客户端都已实机验收。详细范围见[实现说明](../../docs/design/project-folders-and-agent.md#已执行的验证)。

```sh
node --test plugins/qisitv/tests/*.test.mjs
```

开发验证可设置 `QISITV_MCP_CACHE_DIR` 为测试缓存根、`QISITV_CONNECT_CONFIG_DIR` 为测试桥接配置目录，并用 `node plugins/qisitv/scripts/run.mjs --port <测试端口>`。这些变量仅用于隔离，不应写入正常用户配置。
