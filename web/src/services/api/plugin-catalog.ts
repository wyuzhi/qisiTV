import { http } from "@/services/api/request";
import type { ModelProtocolDefinition, ProtocolCapability } from "@/lib/model-protocols";
import { workspaceCapabilities } from "@/services/workspace-mode";

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
    workflows?: Array<{
        id: string;
        label: string;
        providerId: string;
        capability: ProtocolCapability;
        parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>;
        defaults?: Record<string, string | number | boolean>;
    }>;
};

export async function fetchPluginProviderCatalog(scope: string, capability?: ProtocolCapability) {
    if (workspaceCapabilities().local && scope === "user.custom-channel") {
        return BUILTIN_LIKEAI_PROTOCOLS.filter((item) => !capability || item.capability === capability);
    }
    try {
        const result = await http.get<{ providers: PluginProviderCatalogItem[] }>("/plugins/catalog", { params: { scope, capability } });
        return result.providers.filter((item) => item.enabled && !item.unavailableReason).map(toProviderDefinition);
    } catch (error) {
        // The local desktop profile can run without the optional plugin center.
        // LikeAI uses built-in protocols and does not need the plugin center.
        if (scope === "user.custom-channel") {
            const fallback = BUILTIN_LIKEAI_PROTOCOLS.filter((item) => !capability || item.capability === capability);
            if (fallback.length) return fallback;
        }
        throw error;
    }
}

const BUILTIN_LIKEAI_PROTOCOLS: ModelProtocolDefinition[] = (["text", "image", "video", "audio"] as const).map((capability) => ({
    value: `likeai-${capability}`,
    label: `LikeAI ${{ text: "文本", image: "图片", video: "视频", audio: "音频" }[capability]}`,
    vendor: "LikeAI",
    capability,
    create: "POST /task/create_task",
    poll: "GET /task/query_task/{task_id}",
    contentType: "application/json",
    media: "内置协议",
    enabled: true,
    baseUrl: "https://task.likeai.pro/task-api",
}));

function toProviderDefinition(item: PluginProviderCatalogItem): ModelProtocolDefinition {
    return {
        value: item.id,
        label: item.name,
        vendor: item.vendor,
        capability: (item.categories[0] || "text") as ProtocolCapability,
        create: item.create || "",
        poll: item.poll,
        contentType: item.contentType || "application/json",
        media: `${item.vendor} · ${item.version}`,
        enabled: item.enabled && !item.unavailableReason,
        baseUrl: item.baseUrl,
        workflows: item.workflows || [],
    };
}
