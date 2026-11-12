import { isBrowserWorkspace } from "@/services/browser-workspace";
import { http } from "@/services/api/request";
import type { ModelProtocolDefinition, ModelProtocolWorkflow, ProtocolCapability } from "@/lib/model-protocols";

type PluginProviderCatalogItem = {
    id: string;
    version: string;
    name: string;
    vendor: string;
    categories: string[];
    scopes: string[];
    create?: string;
    poll?: string;
    contentType?: string;
    enabled: boolean;
    unavailableReason?: string;
    baseUrl?: string;
    authType?: string;
    module?: boolean;
    aliases?: string[];
    presets?: Array<{ id: string; label: string; baseUrl: string }>;
    // 这一版已经不再附带、只为已保存的配置保留的接口：照常执行，但不再给新的选择。
    retired?: boolean;
    workflows?: ModelProtocolWorkflow[];
};

export async function fetchPluginProviderCatalog(scope: string, capability?: ProtocolCapability) {
    if (isBrowserWorkspace() && scope === "user.custom-channel") {
        return BROWSER_MODEL_PROTOCOLS.filter(item => !capability || item.capability === capability);
    }
    try {
        const result = await http.get<{ providers: PluginProviderCatalogItem[] }>("/plugins/catalog", { params: { scope, capability } });
        // 退役接口留在列表里只为认出已保存的选择；enabled 为 false，选择器不会再列出它。
        return result.providers.filter((item) => item.enabled && !item.unavailableReason).flatMap((item) => toProviderDefinitions(item, capability));
    } catch (error) {
        // The local desktop profile can run without the optional plugin center.
        // Keep the built-in OpenAI-compatible protocols available so a custom
        // channel remains usable even when protocol metadata is unavailable.
        if (scope === "user.custom-channel") {
            const fallback = BUILTIN_OPENAI_PROTOCOLS.filter((item) => !capability || item.capability === capability);
            if (fallback.length) return fallback;
        }
        throw error;
    }
}

const BROWSER_MODEL_PROTOCOLS: ModelProtocolDefinition[] = (["text", "image", "video", "audio"] as const).map(capability => ({
    value: `likeai-${capability}`, label: "qisi API / LikeAI", capability,
    create: "POST /task/create_task", poll: "GET /task/query_task/{task_id}", contentType: "application/json", media: "网页内置协议", enabled: true,
}));

const BUILTIN_OPENAI_PROTOCOLS: ModelProtocolDefinition[] = [
    { value: "chat-completion", label: "OpenAI Chat Completions", vendor: "OpenAI", capability: "text", create: "POST /v1/chat/completions", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "openai-response", label: "OpenAI Responses", vendor: "OpenAI", capability: "text", create: "POST /v1/responses", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "openai-image", label: "OpenAI Images", vendor: "OpenAI", capability: "image", create: "POST /v1/images/generations", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "newapi", label: "OpenAI Videos", vendor: "OpenAI compatible", capability: "video", create: "POST /v1/videos", poll: "GET /v1/videos/{task_id}", contentType: "multipart/form-data", media: "内置协议", enabled: true },
];

// 一个接口能做几种生成（比如 ComfyUI 同时出图、视频、音频），就按能力各列一项：
// 选协议和给模型配协议时，都是一项对应一种能力。
export function toProviderDefinitions(item: PluginProviderCatalogItem, capability?: ProtocolCapability): ModelProtocolDefinition[] {
    const capabilities = (item.categories.length ? item.categories : ["text"]) as ProtocolCapability[];
    return capabilities.filter((value) => !capability || value === capability).map((value) => toProviderDefinition(item, value));
}

function toProviderDefinition(item: PluginProviderCatalogItem, capability: ProtocolCapability): ModelProtocolDefinition {
    return {
        value: item.id,
        label: item.name,
        vendor: item.vendor,
        capability,
        create: item.create || "",
        poll: item.poll,
        contentType: item.contentType || "application/json",
        media: `${item.vendor} · ${item.version}`,
        enabled: item.enabled && !item.unavailableReason && !item.retired,
        baseUrl: item.baseUrl,
        authType: item.authType,
        workflows: item.workflows || [],
        module: item.module,
        aliases: item.aliases,
        presets: item.presets,
    };
}
