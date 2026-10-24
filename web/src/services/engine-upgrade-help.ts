export const ENGINE_UPGRADE_HELP_TITLE = "用过旧版 qisitv-web？查看升级步骤";

export const ENGINE_UPGRADE_HELP_STEPS = [
    "在用过的 Agent 客户端中停用旧 qisitv-web 连接，并关闭手动启动旧连接器的终端窗口。",
    "等待约 30 秒，让旧服务退出；如果上次异常退出，可能需要约 75 秒。",
    "打开新版 qisiTV 本机引擎，按网页提示完成连接。",
    "在网页的“qisiTV MCP”页选择自己的 Agent，按页面提示配置新的 qisitv 连接。",
] as const;
