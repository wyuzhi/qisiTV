# BeefTV for DeepSeek Harness

面向 AI 视频创作的 DSH 原生工作台，左侧复用 BeefTV 画布、项目、素材、技能、插件与模型设置，右侧常驻 DSH 原生 Agent。

## 初代运行方式

- 独立工作区保存在 DSH home 的 `storages/beeftv/workspace`，只使用插件内置的运行包，可在工作台内连接 BeefTV 账号或配置自带 Key。独立工作区会标明「独立工作区，和本机 BeefTV 不是同一份数据」。
- 连接本地 BeefTV 需要 `/Applications/BeefTV.app` 为 2.2.0 或更高版本。插件先读取应用版本，版本较低时只提示升级，不启动应用；通过检查后打开应用，等待其本机私有 IPC 就绪后接入，直接使用原账号连接、工程与素材。已经选了独立工作区时，本机 BeefTV 可用后会提示一次是否切换，点「暂不」后这台机器不再提示。
- 生成复用 BeefTV 的提议与审批机制；审片会调用审片模型，可能收费，提交前同样会询问。模型推理使用 DSH 当前模型配置。
- 画布选中节点后点「问助手」，选中的内容会填到右侧输入框，不会自动发送。
- 提交生成后会自动等结果，完成时在对话里接着做，不用再问一句。工作台菜单里可以关闭「生成完自动继续」，也可以调整每轮步数上限（默认 40 步）。点停止后，这一轮不会再自动继续。
- 关闭 DeepSeek Harness 或断开连接期间完成的生成不会自动续跑；重新打开 BeefTV 面板时会提示一次「有 N 个生成在你离开时完成。」
- 首版支持 macOS Apple Silicon，DSH 0.2.2-rc.1。原生运行包来自当前源码构建并安装的 `/Applications/BeefTV.app`。

## 构建与安装

先按仓库既有流程更新 `/Applications/BeefTV.app`，再从仓库根目录依次执行。

```sh
node plugins/deepseek-harness/package-runtime.mjs
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "file:$(pwd)/plugins/deepseek-harness"
```

打包会把安装版的可执行文件、CLI 和运行资源放进插件，独立运行时无需打开 BeefTV 桌面窗口。每次重新打包或修改插件后，都要重新执行上述 CLI 安装命令，再重新启动 DeepSeek Harness 加载更新。`file:` 安装可能通过硬链接复制单个文件，重建运行包目录会使已安装副本继续保留旧文件，必须重新安装刷新。插件包名为 `dsh-beeftv`，侧栏入口为 BeefTV。

## 权限与数据

Host 通过本机私有 IPC 获取运行时能力，账号与模型密钥留在 BeefTV 原有存储中。浏览器只得到当前连接生命周期内的临时画布访问地址。切换连接会撤销旧 MCP 客户端，后端只会关闭由插件启动的实例。

Agent 通过现有 BeefTV MCP 访问工作区。生成提交、业务目录中标记为写入、生成或无法识别的网关调用，以及会调用付费模型的只读操作（如审片），由 DSH 请求批准；选择完全权限时不弹出审批，直接执行。其余明确标记为只读且不提交生成的调用可直接读取。批准后使用 BeefTV 的 `caller` 模式核对版本与提交任务。画布视图上下文仅包含路由、画布标识与已选节点。已有工作区采用原位连接，独立工作区单独保存。

运行包遵循随包的 BeefTV LICENSE 与 NOTICE，第三方资源保留各自许可。
