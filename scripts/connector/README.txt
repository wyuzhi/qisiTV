qisiTV 本地连接器

用途：让 Codex 等本机 Agent 操作正在打开的 https://cheeser.link/qisitv/ 画布。
网站负责将画布和素材保存到你选择的真实项目文件夹；连接器不建立第二份项目数据库。

1. 将本文件夹移动到一个固定位置。之后不要单独移动可执行程序，否则需要重新配置 MCP。
2. macOS 双击 start.command；Windows 双击 start.cmd；Linux 运行 ./start.sh。
3. 保持终端窗口打开。网站点击“连接本地 Agent”，输入终端显示的一次性配对码。
4. 首次使用 Codex，运行 install-codex.command / install-codex.cmd / install-codex.sh。
   此操作执行 codex mcp add qisitv-web，添加新工具，不修改已有的 qisitv 配置。
   完成后在 Codex 中重新加载 MCP 工具或开启新对话。
5. 在 Codex 中说：“使用 qisitv-web 读取当前画布，新建一个文字节点。先不要生成图片或视频。”

每次重新打开网页需重新配对。在本目录另一个终端运行 ./qisitv-connect pair-code 可获得新码
（Windows 为 qisitv-connect.exe pair-code）。
关闭终端会断开连接。无需使用 Agent 时，不必启动此程序。没有账号、注册或云数据库。
多个网站窗口同时连接时，Agent 必须先用 canvas_list_sessions 选择目标窗口。

手动 MCP 配置（适用于支持 stdio MCP 的客户端）：
command: 本文件夹中 qisitv-connect 的绝对路径（Windows 为 qisitv-connect.exe）
args: ["mcp"]

本版 macOS 软件尚未签名和公证。若系统阻止运行，请在确认下载来源后按 macOS
“隐私与安全性”中的“仍要打开”流程处理；不要关闭系统安全保护。
若双击脚本提示无执行权限，可在终端进入本目录后运行 chmod +x qisitv-connect *.command。
Windows 若提示发布者未知，请先确认文件来自 cheeser.link；本版没有代码签名。

配对码有效 10 分钟、一次使用，错误 5 次失效；浏览器会话最长 12 小时。
配对令牌只用于本机连接，不发给 LikeAI。Agent 令牌与浏览器令牌分离。
Agent 导入的单个本地媒体文件最多 32 MiB，更大素材请从网站导入。
生成媒体需在网站配置 LikeAI，并事先明确批准模型、时长/数量与费用范围。
连接超时后不要盲目重试修改或生成，请先读取画布/任务状态确认结果。
