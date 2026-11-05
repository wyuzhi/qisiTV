import type { AiConfig, ModelChannel, ModelCapability } from "@/stores/use-config-store";
import { buildApiUrl, createModelChannel } from "@/stores/use-config-store";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { inferProtocolCapabilityFromModel, type ModelProtocolDefinition } from "@/lib/model-protocols";
import { catalogEndpointCapability, type ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import { serviceCredentialGuide } from "@/lib/service-credentials";
import { DEFAULT_BASE_URL as LL2_DEFAULT_BASE_URL, LL2_CHANNEL_ID, LL2_CHANNEL_NAME, LL2_PRESET_MODELS, buildLL2ModelChannel, upgradeLL2ModelProfile } from "../../../plugin-packages/beeftv-plugin-ll2/client/index.js";

export const MODEL_SERVICE_PRESETS = [
    { id: "compatible", name: "第三方模型服务", subtitle: "OpenAI 兼容 API · 中转服务", icon: "OpenAI", baseUrl: "", apiFormat: "openai" },
    { id: LL2_CHANNEL_ID, name: LL2_CHANNEL_NAME, subtitle: "文本 · 多款主流视频 · 视频超分", icon: "OpenAI", baseUrl: LL2_DEFAULT_BASE_URL, apiFormat: "openai" },
    { id: "openai", name: "OpenAI", subtitle: "文本 · 图片（Sora 已停用）", icon: "OpenAI", baseUrl: "https://api.openai.com/v1", apiFormat: "openai" },
    { id: "gemini", name: "Google Gemini", subtitle: "文本 · 图片（Veo 已停用）", icon: "Gemini", baseUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini" },
    { id: "ark", name: "火山方舟", subtitle: "文本 · 即梦图片 · Seedance 视频", icon: "Volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiFormat: "openai" },
] as const;
export type ModelServicePresetId = typeof MODEL_SERVICE_PRESETS[number]["id"];
export const CAPABILITY_LABELS: Record<ModelCapability, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

export function isTopazUpscaleChannel(channel: Pick<ModelChannel, "id" | "models">): boolean {
    return channel.id === "fal-topaz-upscale" || channel.models.some(model => model.replace(/^\/+/, "").startsWith("topaz/upscale/"));
}

export function servicePresetFor(channel: ModelChannel): ModelServicePresetId {
    if (channel.id === LL2_CHANNEL_ID) return LL2_CHANNEL_ID;
    try {
        const host = new URL(channel.baseUrl).hostname;
        const ll2Host = new URL(LL2_DEFAULT_BASE_URL).hostname;
        if (host === ll2Host || host.endsWith(".ll2.cn")) return LL2_CHANNEL_ID;
        if (host === "api.openai.com") return "openai";
        if (host === "generativelanguage.googleapis.com") return "gemini";
        if (/^ark\.[a-z0-9-]+\.(?:volces|bytepluses)\.com$/.test(host)) return "ark";
    } catch { /* An unfinished connection has no provider identity yet. */ }
    return "compatible";
}

export function presetCatalogFor(id: ModelServicePresetId): ChannelModelCatalogItem[] {
    if (id !== LL2_CHANNEL_ID) return [];
    return LL2_PRESET_MODELS.map((item) => ({
        id: item.model,
        displayName: item.displayName,
        modelType: item.capability as ModelCapability,
    }));
}

// 插件用 JS 接入的生成服务，在「选择服务商」里各占一项。
export function pluginServices(protocols: ModelProtocolDefinition[]): ModelProtocolDefinition[] {
    const seen = new Set<string>();
    return protocols.filter((item) => item.module && item.enabled !== false && !seen.has(item.value) && seen.add(item.value));
}

export function createPluginServiceChannel(service: ModelProtocolDefinition, channelId: string): ModelChannel {
    return {
        ...createModelChannel({ id: channelId, apiFormat: "openai" }),
        name: service.label,
        baseUrl: service.baseUrl || "",
        interfaceType: service.value,
    };
}

export function ll2ProtocolsAvailable(protocols: ModelProtocolDefinition[]): boolean {
    return LL2_PRESET_MODELS.every((item) =>
        protocols.some((protocol) => protocol.value === item.protocol && protocol.capability === item.capability && protocol.enabled !== false),
    );
}

export function createServicePresetChannel(id: ModelServicePresetId, channelId: string, protocols?: ModelProtocolDefinition[]): ModelChannel {
    const preset = MODEL_SERVICE_PRESETS.find((item) => item.id === id)!;
    if (id === LL2_CHANNEL_ID) {
        const built = buildLL2ModelChannel({ apiKey: "", baseUrl: preset.baseUrl, selectedModels: undefined });
        return {
            ...createModelChannel({ id: channelId, apiFormat: preset.apiFormat }),
            name: preset.name,
            baseUrl: preset.baseUrl,
            models: built.models,
            modelProfiles: built.modelProfiles.map((profile) => {
                const definition = protocols?.find((p) => p.value === profile.protocol && p.capability === profile.capability && p.enabled !== false);
                return {
                    ...profile,
                    capability: profile.capability as ModelCapability,
                    protocol: definition?.value,
                    authType: definition?.authType,
                    capabilityConfig: profile.capabilityConfig as NonNullable<ModelChannel["modelProfiles"]>[number]["capabilityConfig"],
                };
            }),
        };
    }
    return {
        ...createModelChannel({ id: channelId, apiFormat: preset.apiFormat }),
        name: id === "compatible" ? "" : preset.name,
        baseUrl: preset.baseUrl,
    };
}

// Endpoint metadata is a hint, only resolve to protocols the host actually offers.
export function serviceModelProfile(channel: ModelChannel, item: ChannelModelCatalogItem, protocols: ModelProtocolDefinition[], explicitCapability?: ModelCapability): NonNullable<ModelChannel["modelProfiles"]>[number] {
    const preset = channel.apiFormat === "gemini" ? "gemini" : servicePresetFor(channel);
    const rawExisting = channel.modelProfiles?.find((profile) => profile.model === item.id);
    const existing = rawExisting && preset === LL2_CHANNEL_ID ? (upgradeLL2ModelProfile(rawExisting) as typeof rawExisting) : rawExisting;
    if (existing?.protocol && !explicitCapability) {
        const definition = protocols.find((protocol) => protocol.value === existing.protocol && protocol.enabled !== false);
        if (definition && definition.authType !== existing.authType) return { ...existing, authType: definition.authType };
        if (definition || !existing.protocol.startsWith("ll2-")) return existing;
    }
    const ll2Preset = preset === LL2_CHANNEL_ID ? LL2_PRESET_MODELS.find((presetItem) => presetItem.model === item.id) : undefined;
    if (ll2Preset && (!explicitCapability || explicitCapability === ll2Preset.capability)) {
        const definition = protocols.find((protocol) => protocol.value === ll2Preset.protocol && protocol.capability === ll2Preset.capability && protocol.enabled !== false);
        return {
            ...existing,
            model: ll2Preset.model,
            displayName: existing?.displayName || ll2Preset.displayName,
            capability: ll2Preset.capability as ModelCapability,
            protocol: definition?.value,
            authType: definition ? definition.authType : existing?.authType,
            ...(ll2Preset.defaultOptions ? { defaultOptions: ll2Preset.defaultOptions } : {}),
            capabilityConfig: existing?.capability === ll2Preset.capability && existing?.capabilityConfig
                ? existing.capabilityConfig
                : ll2Preset.capabilityConfig as NonNullable<ModelChannel["modelProfiles"]>[number]["capabilityConfig"],
        };
    }
    const fullvideoFull = ["sd-native-full-2.0", "sd-native-full-2.5", "原生不卡人脸-全参2.0", "原生不卡人脸-全参2.5"].includes(item.id);
    const capability = explicitCapability || existing?.capability || item.modelType || catalogEndpointCapability(item) || (fullvideoFull ? "video" : inferProtocolCapabilityFromModel(item.id));
    const compatibleCandidates: Partial<Record<ModelCapability, string>> = { text: "chat-completion", image: "openai-image", audio: "openai-audio" };
    const candidates: Record<ModelServicePresetId, Partial<Record<ModelCapability, string>>> = {
        compatible: compatibleCandidates,
        ll2: compatibleCandidates,
        openai: { text: "openai-response", image: "openai-image", video: "newapi" },
        gemini: { text: "gemini-generate-content", image: "gemini-image", video: "gemini-veo" },
        ark: { text: "chat-completion", image: "volcengine-ark-image", video: "volcengine-ark-video" },
    };
    const endpoints: Record<string, string> = { "responses": "openai-response", "openai-responses": "openai-response", "chat.completions": "chat-completion", "chat-completions": "chat-completion", "images.generations": "openai-image", "image-generation": "openai-image", "audio.speech": "openai-audio", "openai-video": "newapi", "openai-videos": "newapi", "video-generations-json": "video-generations-json", "volcengine-ark-video": "volcengine-ark-video" };
    const endpoint = item.supportedEndpointTypes?.map((value) => endpoints[value.trim().toLowerCase()]).find((id) => protocols.some((p) => p.value === id && p.capability === capability && p.enabled !== false));
    const inherited = protocols.find((p) => p.value === channel.interfaceType && p.capability === capability && p.enabled !== false)?.value;
    let proposed = inherited || endpoint || candidates[preset][capability];
    // Model names identify a family, not a provider's wire protocol. Ask the
    // user to select its contract unless the catalog explicitly declares it.
    if (fullvideoFull && capability === "video" && !inherited) proposed = item.supportedEndpointTypes?.includes("full-video") ? "full-video" : undefined;
    const definition = protocols.find((p) => p.value === proposed && p.capability === capability && p.enabled !== false);
    const protocol = definition?.value;
    return { ...existing, model: item.id, displayName: existing?.displayName || item.displayName, capability, protocol, authType: definition ? definition.authType : existing?.authType, capabilityConfig: existing?.capability === capability && existing.capabilityConfig ? existing.capabilityConfig : (capability === "image" || capability === "video") && protocol ? defaultModelCapabilityConfig(protocol, item.id) : undefined };
}

export function channelAllowsEmptyAPIKey(channel: Pick<ModelChannel, "models" | "modelProfiles" | "interfaceType">, protocols?: ModelProtocolDefinition[]) {
    const models = (channel.models || []).map((model) => model.trim()).filter(Boolean);
    // 还没选模型时，按渠道默认接口判断；插件服务（如本机 ComfyUI）可能不需要密钥。
    if (!models.length) return Boolean(channel.interfaceType) && protocols?.find((item) => item.value === channel.interfaceType)?.authType === "none";
    return models.every((model) => {
        const profile = channel.modelProfiles?.find((item) => item.model === model);
        const protocolId = profile?.protocol || channel.interfaceType;
        if (!protocolId) return false;
        const listed = protocols?.find((item) => item.value === protocolId);
        const auth = listed ? listed.authType : profile?.authType;
        return auth === "none";
    });
}

export function serviceConnectionError(channel: ModelChannel, options?: { protocols?: ModelProtocolDefinition[]; requireCredential?: boolean }): string {
    if (channel.referenceAssetOrigin?.trim()) {
        try {
            const origin = new URL(channel.referenceAssetOrigin.trim());
            if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return "素材服务地址只填写源站，不包含路径、账号或查询参数。公网请使用 HTTPS；本机、局域网或 CGNAT 可使用 HTTP 和端口";
        } catch { return "请填写完整的素材服务地址"; }
    }
    try {
        const url = new URL(channel.baseUrl.trim());
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "请填写不含账号、查询参数或片段的 HTTP(S) 服务地址";
        if (/\/(chat\/completions|responses|images\/generations|models)\/?$/i.test(url.pathname)) return "请填写服务的基础地址，不要包含模型或生成接口路径";
    } catch { return "请填写完整的服务地址，例如 https://api.example.com/v1"; }
    if (options?.requireCredential !== false) {
        const credential = serviceCredentialGuide(channel, options?.protocols);
        if (credential.conflict) return credential.conflict;
        if (!channel.apiKey.trim() && !channel.hasApiKey && !channelAllowsEmptyAPIKey(channel, options?.protocols)) return `请填写 ${credential.apiKeyLabel}`;
        // 空的 Secret Key 栏有两种意思：还没填，或者后端已经存着一份（回读时被清空）。后端会把
        // 「这份密钥到底存没存」作为 hasApiKey/hasSecretKey 返回，只认这个标记，不靠
        // 「连接已经存在」推断——改协议后旧的空密钥仍然是空，后端沿用不了任何东西。
        if (credential.secretKeyRequired && !channel.secretKey?.trim() && channel.hasSecretKey !== true) return `请填写 ${credential.secretKeyLabel}：这个请求协议要两个密钥，缺一个会签名失败`;
    }
    return "";
}

export function mergeSavedServiceChannel<T extends Pick<AiConfig, "channels" | "model" | "imageModel" | "videoModel" | "textModel" | "audioModel" | "assistantModel" | "mediaReviewModel">>(
    latest: T,
    channel: ModelChannel,
): { channels: ModelChannel[]; baseConfig: T; mergedChannel: ModelChannel } {
    const isLL2 = servicePresetFor(channel) === LL2_CHANNEL_ID;
    const exact = latest.channels.find((item) => item.id === channel.id);
    const existing = exact ?? (isLL2 ? latest.channels.find((item) => servicePresetFor(item) === LL2_CHANNEL_ID) : undefined);
    const mergedChannel = existing ? { ...channel, id: existing.id } : channel;
    const removedIds = new Set<string>();
    if (existing && isLL2) {
        for (const item of latest.channels) {
            if (item.id !== existing.id && servicePresetFor(item) === LL2_CHANNEL_ID) {
                removedIds.add(item.id);
            }
        }
    }
    const channels = existing
        ? latest.channels
            .filter((item) => !removedIds.has(item.id))
            .map((item) => item.id === existing.id ? mergedChannel : item)
        : [...latest.channels, mergedChannel];
    const allowedModels = new Set(mergedChannel.models);
    const remapModel = (val?: string) => {
        if (!val || !existing || removedIds.size === 0) return val || "";
        for (const removedId of removedIds) {
            if (val.startsWith(`${removedId}::`)) {
                const modelName = val.slice(removedId.length + 2);
                return allowedModels.has(modelName) ? `${existing.id}::${modelName}` : "";
            }
        }
        return val;
    };
    const baseConfig = removedIds.size > 0
        ? {
            ...latest,
            model: remapModel(latest.model),
            imageModel: remapModel(latest.imageModel),
            videoModel: remapModel(latest.videoModel),
            textModel: remapModel(latest.textModel),
            audioModel: remapModel(latest.audioModel),
            assistantModel: remapModel(latest.assistantModel),
            mediaReviewModel: remapModel(latest.mediaReviewModel),
        }
        : latest;
    return { channels, baseConfig, mergedChannel };
}

export function modelCatalogRequestURL(channel: ModelChannel) {
    if (!channel.baseUrl.trim()) return "";
    try {
        if (channel.apiFormat === "gemini") return `${channel.baseUrl.replace(/\/+$/, "").replace(/\/v1beta$/, "")}/v1beta/models`;
        return buildApiUrl(channel.baseUrl, "/models");
    } catch { return ""; }
}
