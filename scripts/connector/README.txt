qisiTV MCP

用途：让 Codex 等本机 Agent 操作正在打开的 https://cheeser.link/qisitv/ 画布。
网站负责将画布和素材保存到你选择的真实项目文件夹；MCP 不建立第二份项目数据库。

1. 首次安装：macOS 双击 install-codex.command，Windows 双击 install-codex.cmd，
   Linux 运行 ./install-codex.sh。脚本将程序复制到用户安装目录，然后执行
   codex mcp add qisitv-web；不会修改已有的 qisitv 配置。
   安装成功后可关闭安装窗口、删除下载的解压目录。
2. 重新打开 Codex，让 MCP 生效。之后由 Codex 自动启动本地服务，无需单独运行 start。
3. 在 Codex 中说：“使用 qisitv-web，调用 qisitv_pair 获取配对码。不要生成素材。”
4. 用电脑端 Chrome / Edge 打开 https://cheeser.link/qisitv/#/local，选择项目文件夹，
   粘贴 Codex 给出的配对码并连接。浏览器询问本地网络访问时允许本地服务连接。
5. 打开画布，在 Codex 中说：“使用 qisitv-web 读取当前画布，新建一个文字节点。
   先不要生成图片或视频。”

使用期间保持网页和 Codex 打开。刷新网页后，在 Codex 中再次调用 qisitv_pair 获取新码。
所有 MCP 客户端退出后，后台服务在短暂宽限期后自动停止。没有账号、注册或云数据库。
多个网站窗口同时连接时，Agent 必须先用 canvas_list_sessions 选择目标窗口。

安装位置：
macOS：~/Library/Application Support/qisiTV/MCP
Windows：%LOCALAPPDATA%\qisiTV\MCP
Linux：${XDG_DATA_HOME:-~/.local/share}/qisiTV/MCP
更新前请关闭所有使用 qisitv-web 的 Agent，等待约 30 秒，再运行新版安装脚本并重开 Agent。
如果旧版仍有手动 start / serve 窗口，请先关闭那个窗口。

手动 MCP 配置（适用于支持 stdio MCP 的客户端）：
command: 固定位置中 qisitv-connect 的绝对路径（Windows 为 qisitv-connect.exe）
args: ["mcp"]
手动配置时不要移动程序。高级排查可手动运行 qisitv-connect serve，日常使用无需运行。

本版 macOS 软件尚未签名和公证。若系统阻止运行，请在确认下载来源后按 macOS
“隐私与安全性”中的“仍要打开”流程处理；不要关闭系统安全保护。
若双击脚本提示无执行权限，可在终端进入本目录后运行 chmod +x qisitv-connect *.command。
Windows 若提示发布者未知，请先确认文件来自 cheeser.link；本版没有代码签名。

配对码有效 10 分钟、一次使用，错误 5 次失效；浏览器会话最长 12 小时。
配对令牌只用于本机连接，不发给 LikeAI。Agent 令牌与浏览器令牌分离。
Agent 导入的单个本地媒体文件最多 32 MiB，更大素材请从网站导入。
生成媒体需在网站配置 LikeAI，并事先明确批准模型、时长/数量与费用范围。
连接超时后不要盲目重试修改或生成，请先读取画布/任务状态确认结果。
