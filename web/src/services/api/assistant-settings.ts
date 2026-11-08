import { ensureAgentUiSession } from "@/services/api/agent-assistant";
import { http } from "@/services/api/request";

export type AssistantSettings = {
    /** 打开后，助手运行技能里的脚本前不再弹出确认卡片。 */
    skillScriptAutoRun: boolean;
};

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
