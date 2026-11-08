import type { AgentClient, AgentClientKind, AgentClientMode, AgentClientSetup, AgentIntegration, AgentIntegrationKind } from "@/services/api/agent-clients";

export const agentClientKinds: AgentClientKind[] = ["codex", "claude", "claude-desktop", "cursor", "other"];

const kindLabels: Record<AgentClientKind, string> = {
    codex: "Codex",
    claude: "Claude Code",
    "claude-desktop": "Claude Desktop",
    cursor: "Cursor",
    other: "其他 MCP 客户端",
};

const kindSummaries: Record<AgentClientKind, string> = {
    codex: "在终端里连接 Codex。",
    claude: "在终端里连接 Claude Code。",
    "claude-desktop": "在 Claude 桌面应用里连接。",
    cursor: "在 Cursor 的配置里连接。",
    other: "支持 MCP 的工具都能连。",
};

const modeLabels: Record<AgentClientMode, string> = {
    "read-only": "旧版只读连接",
    "read-write": "全部创作工具",
};

const modeSummaries: Record<AgentClientMode, string> = {
    "read-only": "此连接保持只读；重新连接后可使用全部创作工具。",
    "read-write": "可使用 BeefTV 的全部创作工具，操作审批由连接的 Agent 负责。",
};

export function agentClientKindLabel(kind: AgentClientKind | string) {
    return kindLabels[kind as AgentClientKind] || "其他 MCP 客户端";
}

export function agentClientKindSummary(kind: AgentClientKind) {
    return kindSummaries[kind];
}

export function agentClientModeLabel(mode: AgentClientMode | string) {
    return modeLabels[mode as AgentClientMode] || modeLabels["read-only"];
}

export function agentClientModeSummary(mode: AgentClientMode) {
    return modeSummaries[mode];
}

export type AgentClientSetupBlock = {
    /** 待粘贴的整段内容；凭证只存在于这里，页面不再单独展示。 */
    text: string;
    format: "command" | "json";
    instruction: string;
};

const COMMAND_INSTRUCTION = "粘贴到终端运行；Windows 请使用 PowerShell。连接时请保持 BeefTV 开启。";

const configInstructions: Record<AgentClientKind, string> = {
    codex: "粘贴到你使用的工具的 MCP 配置文件里。",
    claude: "粘贴到你使用的工具的 MCP 配置文件里。",
    "claude-desktop": "打开 Claude Desktop 的设置 → 开发者 → 编辑配置，将 beeftv 项合并到 mcpServers，保留已有服务，然后完全退出并重新打开 Claude。连接时请保持 BeefTV 开启。",
    cursor: "粘贴到 ~/.cursor/mcp.json。",
    other: "粘贴到你使用的工具的 MCP 配置文件里。",
};

/**
 * codex / claude 给一条终端命令，cursor / other 给一段配置。
 * 后端只会给出其中一种；若与类型不一致，按实际给到的那一种展示，避免页面空白。
 */
export function agentClientSetupBlock(setup: AgentClientSetup | undefined): AgentClientSetupBlock | null {
    if (!setup) return null;
    const command = setup.command?.trim() || "";
    const json = setup.json?.trim() || "";
    const prefersCommand = setup.kind === "codex" || setup.kind === "claude";
    const text = prefersCommand ? command || json : json || command;
    if (!text) return null;
    const format: "command" | "json" = text === command ? "command" : "json";
    return { text, format, instruction: format === "command" ? COMMAND_INSTRUCTION : configInstructions[setup.kind] || configInstructions.other };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 最近使用：没用过要说没用过，不要显示一个假的时间。 */
export function agentClientLastUsedLabel(lastUsedAt: string | null | undefined, now: number = Date.now()) {
    if (!lastUsedAt) return "还没用过";
    const used = Date.parse(lastUsedAt);
    if (!Number.isFinite(used)) return "还没用过";
    const elapsed = now - used;
    if (elapsed < MINUTE) return "刚刚";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`;
    if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} 天前`;
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(used);
}

export function agentClientDisplayLabel(client: AgentClient) {
    return client.label?.trim() || agentClientKindLabel(client.kind);
}

export function agentIntegrationKindLabel(kind: AgentIntegrationKind) {
    return kind === "claude" ? kindLabels.claude : kindLabels.codex;
}

/** 状态只说明本机事实：没检测到、已接入或还没接入。 */
export function agentIntegrationStatusLabel(integration: AgentIntegration) {
    if (integration.needsRetry) return "需要重试";
    if (integration.connected) return "已接入";
    return integration.detected ? "未接入" : "未检测到";
}

export type AgentIntegrationAction = "connect" | "disconnect" | "unavailable";

export function agentIntegrationAction(integration: AgentIntegration): AgentIntegrationAction {
    // A connected config can outlive the agent installation; always let the
    // user remove what BeefTV wrote. Retry also starts by cleaning up.
    if (integration.needsRetry || integration.connected) return "disconnect";
    return integration.detected ? "connect" : "unavailable";
}

/** 一行说清接入会发生什么、未检测到该怎么办、断开能恢复什么。 */
export function agentIntegrationHint(integration: AgentIntegration) {
    const name = integration.name || agentIntegrationKindLabel(integration.kind);
    if (integration.needsRetry) return "上一次没有清理完连接。再点一次断开即可重试。";
    if (integration.connected && !integration.detected) return `已接入，但这次没有检测到 ${name}。重新打开或重新安装 ${name} 后就会生效。`;
    if (!integration.detected) return `没有检测到 ${name} 的命令行。安装后打开一次，再回到这里。`;
    if (integration.connected && !integration.skillInstalled) return "已接入，但使用说明没有写入。请检查对应技能目录里是否已有同名内容。";
    if (integration.connected) return `已接入。打开 ${name} 就能使用 BeefTV 画布。`;
    return `接入后会在 ${name} 里添加 BeefTV，并装好一份画布使用说明。`;
}
