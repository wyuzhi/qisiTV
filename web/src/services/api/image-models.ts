import { sanitizeChannelModelCatalogItem, type ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import { createChannelTransport } from "@/services/api/channel-transport";
import { readAxiosError, validateGeminiPayload } from "@/services/api/image-response";
import { geminiApiUrl, geminiHeaders } from "@/services/api/image-transport";
import { http } from "@/services/api/request";
import { buildApiUrl, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { fetchBrowserLikeAIModels } from "@/services/browser-likeai-client";

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};

type GeminiModelPayload = { models?: Array<{ name?: string }> };
type OpenAIModelRecord = {
    id?: string;
    name?: string;
    display_name?: string;
    model_type?: string;
    supported_endpoint_types?: string[];
};
type OpenAIModelPayload = { data?: OpenAIModelRecord[]; error?: { message?: string } };

async function fetchOpenAIModelCatalog(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    const payload = await createChannelTransport(config, "image").get<OpenAIModelPayload>(buildApiUrl(config.baseUrl, "/models"));
    return (payload.data || [])
        .map((model) =>
            sanitizeChannelModelCatalogItem({
                id: model.id || model.name,
                displayName: model.display_name || model.name,
                modelType: model.model_type,
                supportedEndpointTypes: model.supported_endpoint_types,
            }),
        )
        .filter((item): item is ChannelModelCatalogItem => Boolean(item));
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (config.apiFormat === "gemini") {
            const requestConfig = { ...defaultGeminiConfig, ...config };
            const payload = await createChannelTransport(requestConfig, "image").get<GeminiModelPayload>(geminiApiUrl(requestConfig), { headers: geminiHeaders(requestConfig) });
            validateGeminiPayload(payload);
            return (payload.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const catalog = await fetchOpenAIModelCatalog(config);
        return catalog.map((model) => model.id).sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}

export type ChannelModelFetchResult = { models: string[]; catalog: ChannelModelCatalogItem[] };

export async function fetchChannelModels(channel: ModelChannel, viaBackend = false): Promise<ChannelModelFetchResult> {
    if (isBrowserWorkspace()) {
        if (channel.apiFormat !== "likeai") throw new Error("网页仅支持 LikeAI 模型服务");
        return fetchBrowserLikeAIModels(channel.apiKey, channel.baseUrl);
    }
    const managed = channel.id === "beefapi" && (channel.pinned || Boolean(channel.credentialRef));
    if (managed || channel.apiFormat === "likeai") {
        viaBackend = true;
    }
    if (!viaBackend) {
        if (channel.apiFormat !== "gemini") {
            const catalog = await fetchOpenAIModelCatalog({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
            return { models: catalog.map((item) => item.id).sort((a, b) => a.localeCompare(b)), catalog };
        }
        const models = await fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
        return { models, catalog: models.map((id) => ({ id })) };
    }
    try {
        // 登录态由同源后端代取模型目录，避免每个 OpenAI 兼容服务分别维护浏览器 CORS 白名单。
        const result = await http.post<{ models?: Array<string | ChannelModelCatalogItem> }>("/ai/models", {
            baseUrl: channel.baseUrl,
            apiKey: managed ? "" : channel.apiKey,
            apiFormat: channel.apiFormat,
            headers: channel.headers,
            channelId: managed ? channel.id : undefined,
            credentialRef: managed ? "beefapi-enterprise" : undefined,
        });
        const catalog = new Map<string, ChannelModelCatalogItem>();
        for (const item of result.models || []) {
            const entry = typeof item === "string" ? sanitizeChannelModelCatalogItem({ id: item }) : sanitizeChannelModelCatalogItem(item);
            if (!entry) continue;
            const existing = catalog.get(entry.id);
            catalog.set(entry.id, existing || entry);
        }
        const models = Array.from(catalog.keys()).sort((a, b) => a.localeCompare(b));
        const sortedCatalog = Array.from(catalog.values()).sort((a, b) => a.id.localeCompare(b.id));
        return { models, catalog: sortedCatalog };
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}
