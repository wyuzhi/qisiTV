import { agentAssistantFailureText, ensureAgentUiSession } from "@/services/api/agent-assistant";
import { ApiError, http } from "@/services/api/request";

export type AssistantSettings = {
    /** 打开后，助手运行技能里的脚本前不再弹出确认卡片。 */
    skillScriptAutoRun: boolean;
};

/**
 * 判断错误是否源于当前页面/客户端无权访问创作助手会话（如非本机只读访问或 401/403）。
 * 这类场景下技能页不应常驻报错，而应隐藏仅本机助手可用的脚本自动运行开关。
 */
export function isAssistantSettingsUnavailableError(error: unknown): boolean {
    if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403) return true;
        if (error.reason === "forbidden" || error.reason === "unauthenticated" || error.reason === "read_only_client") return true;
    }
    if (error instanceof Error && error.message === agentAssistantFailureText("forbidden")) {
        return true;
    }
    return false;
}

// 助手设置与助手入口共用同一套界面会话身份，避免只凭工作区所有者就能写入。
async function headers() {
    return { headers: { "X-Beeftv-Ui-Session": await ensureAgentUiSession() } };
}

export async function getAssistantSettings() {
    return http.get<AssistantSettings>("/assistant/settings", await headers());
}

export async function updateAssistantSettings(input: AssistantSettings) {
    return http.patch<AssistantSettings>("/assistant/settings", input, await headers());
}
