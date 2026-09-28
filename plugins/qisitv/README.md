# qisiTV Codex 插件

让 Codex 操作 <https://cheeser.link/qisitv/> 中的本地创作画布。无需 qisiTV 账号，项目与素材写入用户在网页授权的文件夹。

## 安装

需要 Git、Node.js 18+ 和支持 `codex plugin` 的 Codex。让 Agent 执行：

```sh
codex plugin marketplace add https://github.com/wyuzhi/qisiTV.git --ref main
codex plugin add qisitv@qisitv
```

然后在新的 Codex 任务中说：“连接 qisiTV，调用 qisitv_pair 给我配对码，先不要付费生成。”

打开网页的「本地文件与 Agent」，选择本机项目根文件夹并输入配对码。之后打开项目，保持网页运行，即可在 Codex 对话中读取选区、创建节点、组织连线、导入素材。安装说明见[网站版文档](../../docs/content/docs/backend/browser-workspace.mdx)。

## 运行方式

Codex 通过标准 stdio MCP 启动 `scripts/run.mjs`。启动器按本机系统与架构从本仓库固定 GitHub Release 获取 `qisitv-connect`，按 `runtime.json` 校验 SHA-256，并原子写入用户数据目录的 `qisiTV/MCP/runtime/<version>`。Mac、Windows、Linux 的 x64 / ARM64 均有对应程序。仅首次或缓存损坏时需要下载；所有启动日志写入 stderr。

本机程序自动管理 `127.0.0.1:17372` 的网页桥接服务，只接受已配对网页；多个 MCP 会话共享服务，最后一个会话关闭后空闲退出。浏览器是项目唯一写入者，网页关闭后不能继续操作画布。无需单独保留终端窗口。

网页仍需目录和本地网络权限。模型生成由用户配置 LikeAI Key，且须事先明确费用授权。插件本身不提交收费生成、不收集 Key、不建立云端项目数据库。

## 发布与验证

启动器的固定版本与六平台校验值在 `runtime.json`。发布新版本时先构建，上传新标签的 GitHub Release，再更新对应固定校验值；不可覆盖已发布版本的二进制。随插件附带程序及第三方许可证。

```sh
node --test plugins/qisitv/tests/*.test.mjs
```

开发验证可设置 `QISITV_MCP_CACHE_DIR` 为测试缓存根、`QISITV_CONNECT_CONFIG_DIR` 为测试桥接配置目录，并用 `node plugins/qisitv/scripts/run.mjs --port <测试端口>`。这些变量仅用于隔离，不应写入正常用户配置。
