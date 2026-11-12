import { http } from "@/services/api/request";

/** 外部编辑器/CLI 接入 BeefTV 画布的客户端类型。 */
export type AgentClientKind = "codex" | "workbuddy" | "claude" | "claude-desktop" | "openclaw" | "hermes" | "codebuddy" | "cursor" | "vscode" | "other";

/** 授予外部客户端的画布权限。 */
export type AgentClientMode = "read-only" | "read-write";

export type AgentClient = {
    id: string;
    label: string;
    kind: AgentClientKind;
    mode: AgentClientMode;
    createdAt: string;
    lastUsedAt: string | null;
    /** 桌面版「一键接入」写入的连接；手动新增的连接没有这个标记。 */
    desktopIntegration?: boolean;
};

/** 桌面版一键接入只支持 Claude Code 和 Codex。 */
export type AgentIntegrationKind = "claude" | "codex";

/** 本机 agent 配置与技能的当前状态；由桌面后端读取用户目录得到。 */
export type AgentIntegration = {
    kind: AgentIntegrationKind;
    name: string;
    detected: boolean;
    connected: boolean;
    skillInstalled: boolean;
    /** 上一次接入或断开没有清理完旧凭据，需要再操作一次。 */
    needsRetry: boolean;
};

export type AgentClientCli = {
    path: string;
    available: boolean;
    installCommand: string;
};

export type AgentClientList = {
    clients: AgentClient[];
    cli: AgentClientCli;
    /** 仅桌面形态返回；Web/服务端没有一键接入。 */
    integrations?: AgentIntegration[];
};

/**
 * 接入指引由后端生成：codex / claude 返回单条 `command`，cursor / other 返回 `json`。
 * 凭证只嵌在这段文本里，接口不再单独返回可展示的明文。
 */
export type AgentClientSetup = {
    kind: AgentClientKind;
    title: string;
    command?: string;
    json?: string;
};

export type AgentClientRegistration = {
    client: AgentClient;
    token: string;
    setup: AgentClientSetup;
};

export function listAgentClients(signal?: AbortSignal) {
    return http.get<AgentClientList>("/agent-clients", { signal });
}

export function createAgentClient(body: { kind: AgentClientKind; label?: string }) {
    return http.post<AgentClientRegistration>("/agent-clients", { kind: body.kind, ...(body.label ? { label: body.label } : {}) });
}

export function revokeAgentClient(id: string) {
    return http.delete<{ revoked: boolean }>(`/agent-clients/${encodeURIComponent(id)}`);
}

/** 桌面版一键接入：后端负责写入用户级配置和画布技能。 */
export function connectAgentIntegration(kind: AgentIntegrationKind) {
    return http.post<{ integration: AgentIntegration }>("/agent-clients/integrations", { kind });
}

/** 桌面版一键断开：先切断访问，再尽量移除对方里的 BeefTV 条目。 */
export function disconnectAgentIntegration(kind: AgentIntegrationKind) {
    return http.delete<{ integration: AgentIntegration; warning?: string }>(`/agent-clients/integrations/${encodeURIComponent(kind)}`);
}
