export type AgentClientId = "codex" | "claude-desktop" | "claude-code" | "openclaw" | "hermes" | "codebuddy" | "cursor" | "vscode" | "other";

type AgentClient = {
    id: AgentClientId;
    label: string;
    method: "插件" | "MCP";
    description: string;
    configure: string[];
    verify: string;
    nextStep: string;
    note?: string;
    docs: string;
};

export const AGENT_CLIENTS: readonly AgentClient[] = [
    {
        id: "codex", label: "Codex", method: "插件",
        description: "安装 qisiTV 插件，由 Codex 自动管理本地 MCP。",
        configure: [
            "检查 Git、Node.js 18+ 和 codex plugin 命令是否可用；缺失时说明需要补充的环境，不要声称已安装。",
            "执行 codex plugin marketplace add https://github.com/wyuzhi/qisiTV.git --ref main",
            "执行 codex plugin add qisitv@qisitv",
        ],
        verify: "核对插件安装结果；不要重复添加同名独立 MCP。",
        nextStep: "在 Codex 新建一个任务，获取配对码",
        docs: "https://github.com/wyuzhi/qisiTV/tree/main/plugins/qisitv",
    },
    {
        id: "claude-desktop", label: "Claude 桌面版", method: "MCP",
        description: "使用桌面版的本地 MCP 配置，连接这台电脑上的画布。",
        configure: [
            "使用 Claude Desktop 的设置 → Developer → Edit Config。本机 macOS 文件为 ~/Library/Application Support/Claude/claude_desktop_config.json，Windows 为 %APPDATA%/Claude/claude_desktop_config.json。",
            '备份已有配置，将准备器返回的 JSON 作为根对象 mcpServers["qisitv-web"] 的值合并；保留其他服务器和设置，不要覆盖整个文件。',
            "如果当前聊天没有本机终端或文件权限，请明确说明；把准备和配置工作交给具有本机执行能力的 Agent，或引导用户在桌面版设置粘贴已准备好的配置，不要声称聊天已替用户安装。",
        ],
        verify: "检查 JSON 有效并确认 qisitv-web 出现在桌面版的本地 MCP 列表。",
        nextStep: "完全退出并重启 Claude 桌面版，获取配对码",
        note: "适用于 Mac / Windows 的 Claude 桌面版本地 MCP。claude.ai 网页版和云端连接器不能直接连接这台电脑；没有本机执行能力时，可让其他本地 Agent 帮你完成安装。",
        docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    },
    {
        id: "claude-code", label: "Claude Code", method: "MCP",
        description: "通过 Claude Code 的 MCP 命令注册到本机用户配置。",
        configure: [
            '执行 claude mcp add --transport stdio --scope user qisitv-web -- "PROGRAM" mcp；PROGRAM 必须替换为准备器返回的 command 实际路径，并按当前系统正确传参。',
        ],
        verify: "先用 claude mcp get qisitv-web 检查是否已存在；已正确配置则复用，存在不同配置则说明差异后更新。配置后再次检查，在会话内用 /mcp 查看状态。",
        nextStep: "重新加载 Claude Code 的 MCP 或新开会话，获取配对码",
        docs: "https://code.claude.com/docs/en/mcp",
    },
    {
        id: "openclaw", label: "OpenClaw", method: "MCP",
        description: "通过 OpenClaw 原生 MCP 管理命令连接本机画布。",
        configure: [
            "检查 openclaw mcp add --help 是否支持本地命令；旧版缺少该功能时说明需要更新，不要改用另一套未经确认的配置。",
            '执行 openclaw mcp add qisitv-web --command "PROGRAM" --arg mcp；PROGRAM 替换为准备器返回的 command 实际路径。',
            '需要手动配置时，使用 ~/.openclaw/openclaw.json 的 mcp.servers["qisitv-web"]，值为 { transport: "stdio", command: 准备器返回的路径, args: ["mcp"] }。先备份并保留其他配置。',
        ],
        verify: "先检查现有同名配置，避免覆盖其他用途；执行 openclaw mcp doctor qisitv-web --probe 检查工具发现。",
        nextStep: "在本机 OpenClaw 重新加载 MCP，获取配对码",
        note: "OpenClaw 网关须运行在当前电脑。部署在服务器或另一台设备上的网关不能直接连接这里的本地画布。",
        docs: "https://docs.openclaw.ai/tools/mcp",
    },
    {
        id: "hermes", label: "Hermes", method: "MCP",
        description: "通过 Hermes Agent 的 MCP 命令连接，无需单独保留终端窗口。",
        configure: [
            "检查 hermes mcp add --help 是否可用。",
            '执行 hermes mcp add qisitv-web --command "PROGRAM" --args mcp；PROGRAM 替换为准备器返回的 command 实际路径，--args 必须放在最后。',
            '如需手动配置，在 ~/.hermes/config.yaml 的 mcp_servers.qisitv-web 下写入 command 和 args: ["mcp"]；先备份，保留其他 YAML 字段。',
        ],
        verify: "检查同名配置；通过 /reload-mcp 或新会话确认 qisitv_pair 等工具可用。",
        nextStep: "在 Hermes 使用 /reload-mcp 或新开会话，获取配对码",
        note: "Hermes Agent 须在当前电脑运行；云服务器中的 Hermes 不能直接访问这里的本机服务。",
        docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/",
    },
    {
        id: "codebuddy", label: "CodeBuddy", method: "MCP",
        description: "支持 CodeBuddy CLI，以及 IDE 中的自定义本地 MCP。",
        configure: [
            '使用 CodeBuddy CLI 时，执行 codebuddy mcp add --scope user qisitv-web -- "PROGRAM" mcp；PROGRAM 替换为准备器返回的 command 实际路径。用 CLI 管理当前配置，不猜测或覆盖旧配置文件路径。',
            '使用 CodeBuddy IDE 时，在设置 → MCP → Add MCP / 自定义 MCP 中合并 { mcpServers: { "qisitv-web": { type: "stdio", command: 准备器返回的路径, args: ["mcp"] } } }；不要假设 IDE 与 CLI 共用配置。',
        ],
        verify: "CLI 用 codebuddy mcp get qisitv-web 检查已有及安装后配置；IDE 在 MCP 列表中确认服务可用。已有同名不同配置先说明，不覆盖无关设置。",
        nextStep: "重新加载 CodeBuddy 的 MCP 或重启客户端，获取配对码",
        docs: "https://www.codebuddy.ai/docs/cli/mcp",
    },
    {
        id: "cursor", label: "Cursor", method: "MCP",
        description: "连接 Cursor 本地 IDE 的 MCP 工具。",
        configure: [
            '备份并合并本机用户文件 ~/.cursor/mcp.json，在根对象 mcpServers["qisitv-web"] 下放入准备器返回的 command、args，另加 type: "stdio"。保留其他服务器和设置。',
            "若现有配置包含 JSONC 注释或其他扩展语法，保留原格式编辑，不用 JSON.stringify 重写整个文件；同名配置不同先说明。",
        ],
        verify: "在 Cursor Settings → Tools & MCP 检查 qisitv-web 已启用，并确认工具列表包含 qisitv_pair。",
        nextStep: "在 Cursor 重新加载 MCP，打开 Agent 对话获取配对码",
        docs: "https://cursor.com/docs/mcp",
    },
    {
        id: "vscode", label: "VS Code", method: "MCP",
        description: "连接 VS Code 本机 Copilot Agent 的 MCP 工具。",
        configure: [
            '优先使用 code --add-mcp，并传入一个正确转义的 JSON 参数：{ name: "qisitv-web", type: "stdio", command: 准备器返回的路径, args: ["mcp"] }。',
            '或执行 MCP: Open User Configuration，在根对象 servers["qisitv-web"] 下写入 type: "stdio" 和准备器的 command、args；先备份，保留其他配置与注释。这里是 servers，不是 mcpServers。',
            "使用本机用户配置，不把服务安装到 SSH、容器或远程工作区。保留 VS Code 的服务信任确认，由用户确认自己添加的服务。",
        ],
        verify: "通过 MCP: List Servers 检查 qisitv-web，并在 Copilot Agent 模式确认工具可用。",
        nextStep: "在 VS Code 启用 MCP，打开 Copilot Agent 获取配对码",
        docs: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
    },
    {
        id: "other", label: "其他 MCP 客户端", method: "MCP",
        description: "适用于支持本机 stdio MCP 的其他 Agent。",
        configure: [
            "检查当前客户端的官方 MCP 配置格式，确认支持本机 stdio。服务名使用 qisitv-web，命令与参数直接采用准备器返回的 command 和 args，不要把本机地址填进远程 HTTP MCP URL。",
            "先检查、备份并合并当前客户端配置，保留其他 MCP 服务和设置；若客户端只支持云端远程 MCP，明确说明当前本地版本不适用，不宣称已连接。",
        ],
        verify: "重新加载客户端，列出工具并确认 qisitv_pair 可用；无法检查时明确说明待用户验证。",
        nextStep: "重新加载客户端的 MCP 工具，获取配对码",
        note: "客户端需要支持本机 stdio MCP，并与网页运行在同一台电脑上。",
        docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    },
];

export function getAgentClient(id: AgentClientId) {
    return AGENT_CLIENTS.find((agent) => agent.id === id) ?? AGENT_CLIENTS[0];
}

export function buildAgentInstallationPrompt(id: AgentClientId): string {
    const agent = getAgentClient(id);
    const preparation = agent.id === "codex" ? [] : [
        "确认 Agent 与 qisiTV 网页在同一台电脑运行，并具有本机终端/文件访问能力；没有时说明限制并提供人工配置步骤，不假装已安装。",
        "检查 Git 与 Node.js 18+。创建一个新的临时目录，用 git clone --depth 1 https://github.com/wyuzhi/qisiTV.git 下载官方仓库；不要覆盖已有目录。",
        "在仓库根目录运行 node plugins/qisitv/scripts/prepare.mjs --json。它会选择本机系统、下载并校验固定版本，把程序与许可证保存到稳定缓存，只输出 { command: 程序绝对路径, args: [\"mcp\"] }；不要自行猜测路径、跳过校验或要求用户手选系统安装包。",
        "执行添加或编辑前，先检查客户端现有的 qisitv-web 配置：正确配置则复用；不同配置先说明差异再更新。修改文件前备份，保留所有无关服务器、设置与注释，不输出已有密钥。",
    ];
    return [
        `请帮我在本机 ${agent.label} 接入 qisiTV，服务名为 qisitv-web。`,
        "本次只安装和连接，不要调用任何收费生成接口，不要读取或发送我的 LikeAI API Key。",
        ...[...preparation, ...agent.configure, agent.verify].map((line, i) => `${i + 1}. ${line}`),
        `完成后：${agent.nextStep}。调用 qisitv_pair，展示真实返回的配对码和网页 https://cheeser.link/qisitv/#/local；安装成功不等于已经配对。`,
        "使用期间保持网页打开。本机服务随 MCP 自动管理，不需要另开 start 窗口。保留系统权限确认，不关闭安全保护。",
    ].join("\n\n");
}

export const AGENT_PAIRING_PROMPT = "使用 qisitv-web，调用 qisitv_pair 获取配对码，不要生成素材。";
export const AGENT_TRIAL_PROMPT = "使用 qisitv-web 连接的画布。先列出会话，读取我当前打开的项目和选区，然后在空白处添加一个文字节点，内容是「第一个镜头的创作思路」。先不要调用付费生成。";
