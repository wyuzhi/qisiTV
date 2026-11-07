import { useMemo } from "react";
import type { MediaCapabilities } from "@/lib/media-capabilities";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import { scopedLocalStorage } from "@/lib/user-scope";
import { beefAPIVideoContract, isBeefAPIEndpoint } from "@/lib/beefapi-video-contracts";
import { beefAPIImageContract } from "@/lib/beefapi-image-contracts";
import { defaultProtocolForCapability, defaultProtocolForModel, inferProtocolCapabilityFromModel, modelProtocolCapability, normalizeModelProtocol, usesOpenAICompatibleProtocolDefault, type ModelProtocol } from "@/lib/model-protocols";
import { normalizeVideoBoolean, normalizeVideoDuration, normalizeVideoResolution } from "@/lib/video-generation-options";
import { defaultModelCapabilityConfig, upgradeGPTImageCapability, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import { useUserStore } from "@/stores/use-user-store";
import type { CapabilitySpec } from "@/services/api/logical-models";
import { seedancePortraitLabel, seedancePortraitModel, type VideoPriceQuote } from "@/lib/seedance-portrait";
import { upgradeLL2ModelProfile } from "../../../plugin-packages/beeftv-plugin-ll2/client/index.js";
export { buildApiUrl, isSystemProxyBaseUrl, resolveBackendApiUrl, systemProxyChannelId } from "@/lib/channel-url";

export type ApiCallFormat = "openai" | "gemini" | "claude";
export type ChannelInterfaceType = ModelProtocol;
export type ChannelHeader = { name: string; value: string };
export type ReferenceMediaTransport = Partial<Record<"image" | "video" | "audio", "auto" | "inline" | "url" | "link">>;

// 兼容仍在使用旧目录标识的会话恢复和模型选择器。
export const PUBLIC_MODEL_CATALOG_ID = "managed";

export type ModelChannel = {
    id: string;
    name: string;
    publicAlias?: string;
    sortOrder?: number;
    baseUrl: string;
    referenceAssetOrigin?: string;
    apiKey: string;
    secretKey?: string;
    headers?: ChannelHeader[];
    apiFormat: ApiCallFormat;
    interfaceType?: ChannelInterfaceType;
    models: string[];
    // 仅平台目录使用：将已保存的旧 SKU 选择重定向到当前模型家族。
    modelAliases?: Record<string, string>;
    scope?: "system" | "user";
    enabled?: boolean;
    pinned?: boolean;
    presetVersion?: number;
    credentialRef?: string;
    hasApiKey?: boolean;
    hasSecretKey?: boolean;
    concurrencyLimit?: number;
    modelProfiles?: Array<{
        model: string;
        displayName?: string;
        description?: string;
        icon?: string;
        capability: ModelCapability;
        protocol?: ModelProtocol;
        referenceMediaTransport?: ReferenceMediaTransport;
        authType?: string;
        capabilityConfig?: ModelCapabilityConfig;
        /** "user" 表示能力参数由用户在「能力与参数」里亲手改过；未标记的配置只是界面默认值，不能拿来拦截生成。 */
        capabilitySource?: "user";
        imageCapabilitiesVersion?: string;
        videoCapabilitiesVersion?: string;
        mediaCapabilities?: MediaCapabilities;
        mediaCapabilitiesVersion?: string;
        videoPricing?: VideoPriceQuote | null;
        logicalModelId?: string;
        logicalCapabilitySpec?: CapabilitySpec;
        logicalCapabilityProfiles?: CapabilitySpec[];
        defaultOptions?: Record<string, unknown>;
    }>;
};

export type AiConfig = {
    channelMode: "remote";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    /** 画布助手模型；为空表示跟随 `textModel`。取值与其他默认模型一致，形如 `channelId::modelId`。 */
    assistantModel: string;
    /** 默认影音理解模型；为空表示不使用独立多模态模型。 */
    mediaReviewModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioPitch: string;
    audioVolume: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoArkPrivateAssetUpload: string; videoDraft: string; videoReturnLastFrame?: string;
    systemPrompt: string;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    quality: string;
    size: string;
    transparentBackground: string;
    seedreamMode?: string;
    seedreamMaxImages?: string;
    seedreamOutputFormat?: string;
    seedreamOptimize?: string;
    seedreamWatermark?: string;
    count: string;
    canvasImageCount: string;
};

export const CONFIG_STORE_KEY = "open_ai_canvas:ai_config_store";
export type ModelCapability = "image" | "video" | "text" | "audio";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const LEGACY_DEFAULT_MODEL_NAMES = new Set(["gpt-image-2", "grok-imagine-video", "gpt-5.5", "gpt-4o-mini-tts"]);

export const defaultConfig: AiConfig = {
    channelMode: "remote",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    // 创作端模型目录只能来自后台公开逻辑模型和用户自定义渠道，不能内置供应商模型。
    channels: [],
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    assistantModel: "",
    mediaReviewModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioPitch: "0",
    audioVolume: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoArkPrivateAssetUpload: "true", videoDraft: "false", videoReturnLastFrame: "false",
    systemPrompt: "",
    models: [],
    imageModels: [],
    videoModels: [],
    textModels: [],
    audioModels: [],
    quality: "auto",
    size: "1:1",
    transparentBackground: "false",
    seedreamWatermark: "false",
    count: "1",
    canvasImageCount: "1",
};

type ConfigStore = {
    config: AiConfig;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    replaceConfig: (config: AiConfig) => void;
    mergeSystemChannels: (channels: ModelChannel[]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
};

export type ConfigStoreSnapshot = {
    config?: Partial<AiConfig>;
};

function isVideoModelName(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return (
        value.includes("seedance") ||
        value.includes("video") ||
        value.includes("sora") ||
        value.includes("veo") ||
        value.includes("kling") ||
        value.includes("wan") ||
        value.includes("hailuo") ||
        value.includes("pika") ||
        value.includes("runway") ||
        value.includes("gen-3") ||
        value.includes("gen3") ||
        value.includes("hunyuan-video") ||
        value.includes("hunyuanvideo") ||
        value.includes("cogvideo") ||
        value.includes("mochi") ||
        value.includes("latte") ||
        value.includes("stable-video") ||
        value.includes("svd") ||
        value.includes("animatediff") ||
        value.includes("ltx-video") ||
        value.includes("ltxvideo") ||
        /minimax-(?:video|h3)/.test(value) ||
        value.includes("abab-video")
    );
}

function isImageModelName(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return (
        !isVideoModelName(model) &&
        !isAudioModelName(model) &&
        (value.includes("seedream") ||
            value.includes("gpt-image") ||
            value.includes("image") ||
            value.includes("dall-e") ||
            value.includes("dalle") ||
            value.includes("imagen") ||
            value.includes("flux") ||
            value.includes("sdxl") ||
            value.includes("stable-diffusion") ||
            value.includes("midjourney") ||
            value.includes("nano-banana") ||
            value.includes("nanobanana") ||
            value.includes("ideogram") ||
            value.includes("recraft") ||
            value.includes("playground") ||
            value.includes("leonardo"))
    );
}

function isTranscriptionModelName(model: string) {
    const parts = new Set(
        modelOptionName(model)
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean),
    );
    return ["asr", "stt", "whisper", "transcription", "transcriptions", "transcribe"].some((token) => parts.has(token));
}

function isAudioModelName(model: string) {
    if (isTranscriptionModelName(model)) return false;
    const value = modelOptionName(model).toLowerCase();
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice") || value.includes("music") || value.includes("sound");
}

function isTextModelName(model: string) {
    return !isImageModelName(model) && !isVideoModelName(model) && !isAudioModelName(model) && !isTranscriptionModelName(model);
}

export function modelMatchesCapability(model: string, capability?: ModelCapability) {
    if (!capability) return true;
    if (capability === "image") return isImageModelName(model);
    if (capability === "video") return isVideoModelName(model);
    if (capability === "audio") return isAudioModelName(model);
    return isTextModelName(model);
}

type ChannelModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];
type ChannelLookup = { byId: Map<string, ModelChannel>; byModel: Map<string, ModelChannel> };

// Model pickers resolve every option against the channel list. Scanning the
// list per option is quadratic and freezes settings on large catalogs, so
// lookups are indexed once per (immutable) channels array / channel object.
const channelLookups = new WeakMap<ModelChannel[], ChannelLookup>();
const profileLookups = new WeakMap<ModelChannel, Map<string, ChannelModelProfile>>();

function channelLookup(channels: ModelChannel[]): ChannelLookup {
    let lookup = channelLookups.get(channels);
    if (lookup) return lookup;
    lookup = { byId: new Map(), byModel: new Map() };
    for (const channel of channels) {
        if (!lookup.byId.has(channel.id)) lookup.byId.set(channel.id, channel);
        for (const model of channel.models) if (!lookup.byModel.has(model)) lookup.byModel.set(model, channel);
    }
    channelLookups.set(channels, lookup);
    return lookup;
}

export function channelModelProfile(channel: ModelChannel | undefined, model: string) {
    if (!channel?.modelProfiles?.length) return undefined;
    let lookup = profileLookups.get(channel);
    if (!lookup) {
        lookup = new Map();
        for (const profile of channel.modelProfiles) if (!lookup.has(profile.model)) lookup.set(profile.model, profile);
        profileLookups.set(channel, lookup);
    }
    return lookup.get(model);
}

export function filterModelsByCapability(models: string[], capability?: ModelCapability, channels?: ModelChannel[]) {
    if (!capability) return models;
    const lookup = channels ? channelLookup(channels) : undefined;
    return models.filter((model) => {
        const decoded = decodeChannelModel(model);
        const channel = decoded ? lookup?.byId.get(decoded.channelId) : undefined;
        const modelName = decoded?.model || modelOptionName(model);
        const costEntry = channelModelProfile(channel, modelName);
        // 协议层优先级最高：协议决定 API 端点，明确属于其他能力时直接排除，
        // 防止用户将 video/image/audio 协议的模型误标为 text 后混入文本下拉。
        const protocolCapability = modelProtocolCapability(costEntry?.protocol);
        if (protocolCapability) return protocolCapability === capability;
        // 渠道接口层：渠道级协议推断能力
        const channelCapability = capabilityForChannelInterface(channel?.interfaceType);
        if (channelCapability) return channelCapability === capability;
        // 配置能力层：用户显式标记的 capability
        const configuredCapability = costEntry?.capability;
        if (configuredCapability) return configuredCapability === capability;
        // 模型名启发式：最后回退
        return modelMatchesCapability(model, capability);
    });
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    // 选项目录只从当前有效渠道重建，不能信任旧快照里残留的 config.models。
    // 这样旧版本内置模型、未绑定渠道的裸模型不会再次进入创作端。
    const models = modelOptionsFromChannels(config.channels);
    if (!capability) return models;
    return filterModelsByCapability(models, capability, config.channels);
}

export function configuredModelMatchesCapability(config: AiConfig, model: string, capability?: ModelCapability) {
    const normalized = normalizeModelOptionValue(model, config.channels);
    if (!normalized) return false;
    return selectableModelsByCapability(config, capability).includes(normalized);
}

export const MANAGED_BEEFAPI_CREDENTIAL_REF = "beeftv";

export function isBuiltinBeefAPIChannel(channel: Pick<ModelChannel, "id" | "pinned">) {
    return channel.id === "beeftv" && channel.pinned === true;
}

export function channelHasManagedBeefAPICredential(channel: Pick<ModelChannel, "id" | "pinned" | "credentialRef" | "hasApiKey">) {
    if (!isBuiltinBeefAPIChannel(channel)) return false;
    return channel.credentialRef === MANAGED_BEEFAPI_CREDENTIAL_REF || channel.hasApiKey === true;
}

export function channelHasGenerationCredential(channel: Pick<ModelChannel, "id" | "pinned" | "credentialRef" | "hasApiKey" | "apiKey" | "modelProfiles">, model = "") {
    if (model && channel.modelProfiles?.some((item) => item.model === modelOptionName(model) && item.authType === "none")) return true;
    return channelHasManagedBeefAPICredential(channel) || Boolean(channel.apiKey?.trim());
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && channelHasGenerationCredential(channel, model));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set) => ({
            config: defaultConfig,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            replaceConfig: (config) => set({ config }),
            mergeSystemChannels: (channels) =>
                set((state) => {
                    const systemChannels = channels.map((channel, index) =>
                        createModelChannel({
                            ...channel,
                            id: channel.id || `system-${index + 1}`,
                            name: channel.name || `系统渠道 ${index + 1}`,
                            scope: "system",
                            apiKey: channel.apiKey || "system",
                        }),
                    );
                    const userChannels = state.config.channels.filter((channel) => channel.scope !== "system");
                    return normalizeConfigSnapshot({ config: { ...state.config, channels: [...systemChannels, ...userChannels] } });
                }),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
        }),
        {
            name: CONFIG_STORE_KEY,
            storage: createJSONStorage(() => scopedLocalStorage),
            partialize: (state) => ({ config: configWithoutCachedSecrets(state.config) }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                return {
                    ...current,
                    ...normalizeConfigSnapshot({ config: persistedState.config }),
                };
            },
        },
    ),
);

// The canonical local workspace restores credentials at startup. Browser
// storage only caches presentation/preferences, never an extra plaintext copy.
export function configWithoutCachedSecrets(config: AiConfig): AiConfig {
    return {
        ...withoutRemovedSettings(config),
        apiKey: "",
        channels: config.channels.map((channel) => ({ ...channel, apiKey: "", secretKey: "", headers: [] })),
    };
}

// 旧版把 RunningHub 的 Key 存在 config.runningHub。这个能力搬进插件后没有代码再读它，
// 但对象展开会把它带回本地缓存和工作区配置，所以读写时都去掉。
function withoutRemovedSettings<T extends Partial<AiConfig>>(config: T): T {
    const { runningHub: _removed, ...rest } = config as T & { runningHub?: unknown };
    return rest as T;
}

export function normalizeConfigSnapshot(snapshot: ConfigStoreSnapshot | undefined = {}) {
    // 坏存储/旧版本快照可能是 undefined 或缺 config，兜底为 defaultConfig，保证渲染不崩溃
    const persistedConfig = withoutRemovedSettings((snapshot?.config || {}) as Partial<AiConfig>);
    const config = {
        ...defaultConfig,
        ...persistedConfig,
        // Older desktop snapshots may contain explicitly stored `undefined`
        // values. Keep all fields consumed by `.trim()` callers as strings.
        baseUrl: typeof persistedConfig.baseUrl === "string" ? persistedConfig.baseUrl : defaultConfig.baseUrl,
        apiKey: typeof persistedConfig.apiKey === "string" ? persistedConfig.apiKey : "",
    };
    const hasPersistedChannels = Array.isArray(persistedConfig.channels);
    if (!hasPersistedChannels) config.channels = [];
    const channels = normalizeChannels(config, !hasPersistedChannels).map(enrichBeefApiMediaChannel).map(reconcileChannelModelProfiles);
    const models = modelOptionsFromChannels(channels);
    const imageModels = filterModelsByCapability(models, "image", channels);
    const videoModels = filterModelsByCapability(models, "video", channels);
    const textModels = filterModelsByCapability(models, "text", channels);
    const audioModels = filterModelsByCapability(models, "audio", channels);
    const model = normalizeSelectedModel(config.model || config.imageModel || config.textModel, channels, models);
    return {
        config: {
            ...config,
            channelMode: "remote" as const,
            apiFormat: normalizeApiFormat(config.apiFormat),
            channels,
            models,
            model,
            imageModel: normalizeSelectedModel(config.imageModel || model, channels, imageModels),
            videoModel: normalizeSelectedModel(config.videoModel, channels, videoModels),
            textModel: normalizeSelectedModel(config.textModel || model, channels, textModels),
            audioModel: normalizeSelectedModel(config.audioModel || defaultConfig.audioModel, channels, audioModels),
            // 助手模型允许为空（跟随默认文本模型），因此这里只保证类型，
            // 协议与渠道有效性由 `lib/assistant-model` 在读取时裁决。
            assistantModel: typeof config.assistantModel === "string" ? config.assistantModel.trim() : "",
            mediaReviewModel: typeof config.mediaReviewModel === "string" ? config.mediaReviewModel.trim() : "",
            audioVoice: config.audioVoice || defaultConfig.audioVoice,
            audioFormat: config.audioFormat || defaultConfig.audioFormat,
            audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
            audioPitch: config.audioPitch || defaultConfig.audioPitch,
            audioVolume: config.audioVolume || defaultConfig.audioVolume,
            audioInstructions: config.audioInstructions || "",
            // 旧版全局 systemPrompt 会跨任务污染请求；提示词定制现已按 operation 由服务端编译。
            systemPrompt: "",
            videoSeconds: normalizeVideoDuration(config.videoSeconds),
            vquality: normalizeVideoResolution(config.vquality),
            videoGenerateAudio: normalizeVideoBoolean(config.videoGenerateAudio) ?? "true",
            videoWatermark: normalizeVideoBoolean(config.videoWatermark) ?? "false",
            videoArkPrivateAssetUpload: normalizeVideoBoolean(config.videoArkPrivateAssetUpload) ?? "true", videoDraft: normalizeVideoBoolean(config.videoDraft) ?? "false",
            transparentBackground: config.transparentBackground === "true" ? "true" : "false",
            canvasImageCount: config.canvasImageCount || defaultConfig.canvasImageCount,
            imageModels,
            videoModels,
            textModels,
            audioModels,
        },
    };
}

function beefApiVideoProtocol(model: string, current?: ModelProtocol): ModelProtocol {
    const contract = beefAPIVideoContract(model)?.protocol as ModelProtocol | undefined;
    if (contract) return contract;
    // A video profile must not keep a protocol that runs a different
    // capability. BeefAPI often tags video models with a chat/text endpoint;
    // that stale protocol would make the backend reject the task outright
    // ("接口类型 chat-completion 不支持video生成"). Unknown/custom protocols
    // stay untouched.
    return current && protocolAllowsCapability(current, "video") ? current : defaultProtocolForCapability("video");
}

function protocolAllowsCapability(protocol: ModelProtocol | undefined, capability: ModelCapability): boolean {
    const resolved = modelProtocolCapability(protocol);
    return !resolved || resolved === capability;
}

// Enforce capability ↔ protocol consistency for every channel. BeefAPI media
// profiles are already repaired from the shared contracts above; for other
// channels the request protocol is what the user configured, so the
// capability follows it instead of inventing a different wire protocol.
function reconcileChannelModelProfiles(channel: ModelChannel): ModelChannel {
    if (!channel.modelProfiles?.length) return channel;
    let changed = false;
    const modelProfiles = channel.modelProfiles.map((raw) => {
        const profile = (upgradeLL2ModelProfile(raw) as typeof raw) || raw, capability = modelProtocolCapability(profile.protocol);
        if (profile !== raw) changed = true;
        return !capability || capability === profile.capability ? profile : ((changed = true), { ...profile, capability });
    });
    return changed ? { ...channel, modelProfiles } : channel;
}

function beefApiVideoCapabilityConfig(model: string, protocol: ModelProtocol, current?: ModelCapabilityConfig, sourced = false): ModelCapabilityConfig | undefined {
    const profile = beefApiSeedanceCapabilityConfig(model, current, sourced);
    if (sourced) return profile;
    const contract = beefAPIVideoContract(model);
    const limits = contract?.maxReferences;
    if (!limits) return profile;
    const resolved = profile || defaultModelCapabilityConfig(protocol, model);
    if (!resolved.video) return resolved;
    return { ...resolved, video: { ...resolved.video,
        resolutions: contract.resolutions || resolved.video.resolutions,
        defaultResolution: contract.resolutions?.includes(resolved.video.defaultResolution) ? resolved.video.defaultResolution : contract.resolutions?.[0] || resolved.video.defaultResolution,
        ratios: contract.ratios || resolved.video.ratios,
        defaultRatio: contract.ratios?.includes(resolved.video.defaultRatio) ? resolved.video.defaultRatio : contract.ratios?.[0] || resolved.video.defaultRatio,
        duration: contract.duration ? { ...resolved.video.duration, selection: "range", min: contract.duration.min, max: contract.duration.max, default: contract.duration.default } : resolved.video.duration,
        generateAudio: contract.generateAudio ? { ...resolved.video.generateAudio, supported: true } : resolved.video.generateAudio,
        references: { ...resolved.video.references, maxImages: Math.min(resolved.video.references.maxImages, limits.image ?? Infinity), maxVideos: Math.min(resolved.video.references.maxVideos, limits.video ?? Infinity), maxAudios: Math.min(resolved.video.references.maxAudios, limits.audio ?? Infinity) },
        operations: contract.operations || resolved.video.operations,
        defaultOperation: contract.operations?.includes(resolved.video.defaultOperation) ? resolved.video.defaultOperation : contract.operations?.[0] || resolved.video.defaultOperation,
    } };
}

function beefApiSeedanceCapabilityConfig(model: string, current?: ModelCapabilityConfig, sourced = false): ModelCapabilityConfig | undefined {
    if (sourced) return current;
    if (!/^seedance-2\.(?:0|5)(?:-|$)/i.test(model)) return current;
    const video = current?.video;
    const refs = video?.references;
    // Older built-in profiles disabled all video/audio references on every
    // hydration. Match that complete signature, not a user's individual limit.
    const legacy = video?.operations?.length === 2 && video.operations.includes("text_to_video") && video.operations.includes("image_to_video") &&
        refs?.maxImages === 9 && refs.maxVideos === 0 && refs.maxAudios === 0 &&
        refs.maxVideoBytes === 200 * 1024 * 1024 && refs.maxAudioBytes === 15 * 1024 * 1024 &&
        refs.maxVideoDurationSeconds === 0 && refs.maxAudioDurationSeconds === 0;
    const defaults = defaultModelCapabilityConfig("newapi", model);
    if (!current || !video) return defaults;
    // The built-in BeefAPI Seedance contract supports the audio switch even
    // when an older saved profile advertised no control. Keep its default.
    const generateAudio = { ...video!.generateAudio, supported: true }, draftSupported = Boolean(video!.draft?.supported ?? defaults.video?.draft?.supported);
    const baseRes = Array.isArray(video!.resolutions) ? video!.resolutions : defaults.video?.resolutions ?? [], baseOps = Array.isArray(video!.operations) ? video!.operations : defaults.video?.operations ?? [];
    const resolutions = draftSupported && !baseRes.some((item) => String(item).toLowerCase() === "480p") ? ["480p", ...baseRes] : baseRes;
    const operations = draftSupported && defaults.video?.operations?.includes("draft_to_final") && !baseOps.includes("draft_to_final") ? [...baseOps, "draft_to_final"] : baseOps;
    const flags = { resolutions, operations, ...(defaults.video?.draft ? { draft: video!.draft ?? defaults.video.draft } : {}), ...(defaults.video?.returnLastFrame ? { returnLastFrame: video!.returnLastFrame ?? defaults.video.returnLastFrame } : {}) };
    if (!legacy) return { ...current, video: { ...video!, generateAudio, ...flags } };
    const next = defaults.video!;
    return { ...current, video: { ...video!, generateAudio, ...flags, operations: next.operations, references: { ...refs!, maxImages: next.references.maxImages, maxVideos: next.references.maxVideos, maxAudios: next.references.maxAudios, maxVideoDurationSeconds: next.references.maxVideoDurationSeconds, maxAudioDurationSeconds: next.references.maxAudioDurationSeconds } } };
}

function enrichBeefApiMediaChannel(channel: ModelChannel): ModelChannel {
    if (!isBeefAPIEndpoint(channel.baseUrl)) return channel;
    const models = channel.models;
    const existing = new Map((channel.modelProfiles || []).map((item) => [item.model, item]));
    for (const model of models.filter(isImageModelName)) {
        const current = existing.get(model);
        if (current?.imageCapabilitiesVersion && current.capabilityConfig?.image) continue;
        // These BeefAPI models use Images, even when an older generic catalog
        // saved a text protocol. Do not rewrite arbitrary custom model routes.
        const contract = beefAPIImageContract(model);
        const staleTextProtocol = (/^(gpt-image(?:-|$)|dall-e(?:-|$))/i.test(model) || Boolean(contract)) && modelProtocolCapability(current?.protocol) === "text";
        const protocol = contract?.protocol || (staleTextProtocol ? "openai-image" : current?.protocol || "openai-image");
        const capabilityConfig = contract ? defaultModelCapabilityConfig(contract.protocol, model) : current?.capabilityConfig || defaultModelCapabilityConfig(protocol, model);
        existing.set(model, {
            ...(current || {}),
            model,
            capability: "image",
            protocol,
            capabilityConfig: capabilityConfig.image ? { ...capabilityConfig, image: upgradeGPTImageCapability(capabilityConfig.image, protocol, model) } : capabilityConfig,
        });
    }
    for (const model of models.filter(isTextModelName)) {
        const current = existing.get(model);
        if (current?.capability && current.capability !== "text") continue;
        if (current?.protocol && modelProtocolCapability(current.protocol) !== "text") continue;
        existing.set(model, {
            ...(current || {}),
            model,
            capability: "text",
            protocol: current?.protocol || "chat-completion",
        });
    }
    for (const model of models.filter(isAudioModelName)) {
        const current = existing.get(model);
        if (current?.capability && current.capability !== "audio" && current.capability !== "text") continue;
        existing.set(model, {
            ...(current || {}),
            model,
            capability: "audio",
            protocol: current?.protocol && current.capability === "audio" ? current.protocol : "openai-audio",
        });
    }
    for (const model of models.filter(isTranscriptionModelName)) {
        const current = existing.get(model);
        if (!current) continue;
        if (current.capability === "image" || current.capability === "video") continue;
        existing.delete(model);
    }
    for (const model of models.filter((model) => isVideoModelName(model) || Boolean(beefAPIVideoContract(model)))) {
        if (channel.id === "beeftv" || channel.credentialRef === MANAGED_BEEFAPI_CREDENTIAL_REF) continue;
        const current = existing.get(model);
        if (current?.videoCapabilitiesVersion?.trim() && current.capabilityConfig?.video) continue;
        // Repair known routes using the shared contract; preserve catalog and
        // custom protocols for models whose wire contract is not declared here.
        const protocol = beefApiVideoProtocol(model, current?.protocol);
        existing.set(model, {
            ...(current || {}),
            model,
            capability: "video",
            protocol,
            capabilityConfig: beefApiVideoCapabilityConfig(model, protocol, current?.capabilityConfig, current?.videoCapabilitiesVersion !== undefined),
        });
    }
    return { ...channel, models, modelProfiles: Array.from(existing.values()) };
}

function normalizeSelectedModel(value: string, channels: ModelChannel[], options: string[]) {
    const model = normalizeModelOptionValue(value, channels);
    if (model && options.includes(model)) return model;
    // Keep an explicit paid-tier choice visible when the catalog removes it.
    // An ordinary/default choice must never select the paid tier implicitly.
    if (seedancePortraitModel(value)) return value;
    return options.find((option) => !seedancePortraitModel(option)) || "";
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    const customChannelsEnabled = useUserStore((state) => state.features.customChannelsEnabled);
    return useMemo(() => effectiveConfigForCustomChannels(config, customChannelsEnabled), [config, customChannelsEnabled]);
}

export function effectiveConfigForCustomChannels(config: AiConfig, customChannelsEnabled: boolean): AiConfig {
    if (customChannelsEnabled) return config;
    const channels = config.channels.filter((channel) => channel.scope === "system");
    return normalizeConfigSnapshot({ config: { ...config, channels } }).config;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    const interfaceType = normalizeChannelInterfaceType(channel?.interfaceType);
    const providedBaseUrl = channel?.baseUrl?.trim();
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || "新渠道",
        sortOrder: channel?.sortOrder ?? 0,
        baseUrl: providedBaseUrl || (interfaceType ? defaultBaseUrlForChannelInterface(interfaceType) : defaultBaseUrlForApiFormat(apiFormat)),
        referenceAssetOrigin: channel?.referenceAssetOrigin?.trim() || undefined,
        apiKey: channel?.apiKey || "",
        secretKey: channel?.secretKey || "",
        headers: Array.isArray(channel?.headers) ? channel.headers.map((header) => ({ name: String(header.name || ""), value: String(header.value || "") })) : [],
        apiFormat,
        interfaceType,
        models: uniqueRawModels(channel?.models || []),
        scope: channel?.scope === "system" ? "system" : "user",
        enabled: channel?.enabled !== false,
        pinned: channel?.pinned === true,
        presetVersion: channel?.presetVersion,
        credentialRef: channel?.credentialRef,
        hasApiKey: channel?.hasApiKey,
        hasSecretKey: channel?.hasSecretKey,
        modelProfiles: channel?.modelProfiles?.map((item) => ({ ...item, protocol: normalizeModelProtocol(item.protocol) })),
    };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelDisplayName(config: AiConfig, value: string) {
    const portrait = seedancePortraitLabel(value);
    if (portrait) return portrait;
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    const displayName = channelModelProfile(channel, model)?.displayName?.trim();
    if (displayName) return displayName;
    return channel.scope === "system" ? "系统模型" : model;
}

export function modelIcon(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    return resolveModelChannel(config, value).modelProfiles?.find((item) => item.model === model)?.icon || "";
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return modelDisplayName(config, value);
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    const displayName = modelDisplayName(config, value);
    // 平台前台模型只展示公开名称；供应来源和内部目录适配器不属于创作端信息。
    if (!channel || channel.scope === "system") return displayName;
    return `${displayName}（${channel.name}）`;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(
        channels.flatMap((channel) =>
            channel.models
                .map(normalizeRawModelName)
                .filter(Boolean)
                .filter((model) => !model.replace(/^\/+/, "").startsWith("topaz/upscale/"))
                .filter((model) => !["topaz-standard-v2", "topaz-wonder-3.5", "topaz-proteus", "topaz-starlight-fast-2"].includes(model))
                .filter((model) => channel.scope !== "system" || hasSystemModelProfile(channel, model))
                .map((model) => encodeChannelModel(channel.id, model)),
        ),
    );
}

export function hasSystemModelProfile(channel: ModelChannel, model: string) {
    if (channel.scope !== "system") return true;
    return channel.modelProfiles?.some((item) => item.model === model) === true;
}

export function normalizeModelOptionValue(value: unknown, channels: ModelChannel[]) {
    const model = typeof value === "string" ? value.trim() : "";
    if (!normalizeRawModelName(model)) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        const resolved = channel?.modelAliases?.[decoded.model] || decoded.model;
        return channel && seedancePortraitModel(decoded.model) === seedancePortraitModel(resolved) && channel.models.includes(resolved) ? encodeChannelModel(channel.id, resolved) : "";
    }
    const channel = channels.find((item) => item.models.includes(model) || Boolean(item.modelAliases?.[model])) || channels[0];
    const resolved = channel?.modelAliases?.[model] || model;
    return channel && seedancePortraitModel(model) === seedancePortraitModel(resolved) && channel.models.includes(resolved) ? encodeChannelModel(channel.id, resolved) : "";
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const lookup = channelLookup(config.channels);
    const matched = decoded ? lookup.byId.get(decoded.channelId) : lookup.byModel.get(model);
    return matched || config.channels[0] || createModelChannel({ id: "default", name: "默认渠道", baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName) });
}

export function logicalModelIDForConfig(config: AiConfig) {
    const channel = resolveModelChannel(config, config.model);
    return channel.modelProfiles?.find((item) => item.model === modelOptionName(config.model))?.logicalModelId || "";
}

export function channelConnectionSignature(channel: ModelChannel) {
    return [channel.baseUrl.trim(), channel.referenceAssetOrigin?.trim() || "", channel.apiKey.trim(), channel.secretKey?.trim() || "", channel.apiFormat, channel.interfaceType || "auto", JSON.stringify(channel.headers || [])].join("\n");
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    const model = modelOptionName(value || config.model);
    const modelProfile = channel.modelProfiles?.find((item) => item.model === model);
    const modelProtocol = normalizeModelProtocol(modelProfile?.protocol);
    const capability = modelProfile?.capability || inferProtocolCapabilityFromModel(model);
    const interfaceType = modelProtocol
        || normalizeModelProtocol(channel.interfaceType)
        || (capability === "video" || channel.scope === "system" || !usesOpenAICompatibleProtocolDefault(channel.apiFormat)
            ? undefined
            : (modelProfile?.capability ? defaultProtocolForCapability(modelProfile.capability) : defaultProtocolForModel(model)));
    return {
        ...config,
        model,
        baseUrl: channel.baseUrl,
        referenceAssetOrigin: channel.referenceAssetOrigin,
        referenceMediaTransport: channel.scope === "system" ? undefined : modelProfile?.referenceMediaTransport,
        apiKey: channel.credentialRef ? "" : channel.apiKey,
        secretKey: channel.credentialRef ? "" : channel.secretKey,
        headers: channel.headers,
        apiFormat: interfaceType ? (interfaceType === "gemini-veo" || interfaceType === "gemini-image" || interfaceType === "gemini-generate-content" ? ("gemini" as const) : interfaceType === "claude-api" ? ("claude" as const) : ("openai" as const)) : channel.apiFormat,
        interfaceType,
        channelId: channel.scope === "system" ? channel.id : "",
        credentialRef: channel.credentialRef || (isBuiltinBeefAPIChannel(channel) ? MANAGED_BEEFAPI_CREDENTIAL_REF : undefined),
    };
}

function normalizeChannels(config: AiConfig, ensureDefault = true) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels
        .map((channel, index) =>
            createModelChannel({
                ...channel,
                id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
                name: channel.name || (index === 0 ? "默认渠道" : `渠道 ${index + 1}`),
                models: uniqueRawModels(channel.models || []),
            }),
        )
        .filter((channel) => !isEmptyDefaultChannel(channel));
    if (!channels.length && ensureDefault && config.apiKey.trim()) {
        channels.push(
            createModelChannel({
                id: "default",
                name: "默认渠道",
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: uniqueRawModels([...(config.models || []), config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel]),
            }),
        );
    }
    return channels.map((channel) => ({ ...channel, models: uniqueRawModels(channel.models) }));
}

function isEmptyDefaultChannel(channel: ModelChannel) {
    if (channel.scope === "system") return false;
    if (channel.id !== "default" || channel.name.trim() !== "默认渠道" || channel.apiKey.trim()) return false;
    const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const defaultBaseUrl = defaultConfig.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl && baseUrl !== defaultBaseUrl) return false;
    // 只清理旧版本写入浏览器的无密钥“默认渠道”和内置模型；没有 API Key 但已填写自定义模型时仍保留，
    // 让用户可以先保存模型目录再补充密钥，而不是把真实自定义配置误判为空。
    return !channel.models.length || channel.models.every((model) => LEGACY_DEFAULT_MODEL_NAMES.has(modelOptionName(model)));
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    return apiFormat === "gemini" ? GEMINI_BASE_URL : OPENAI_BASE_URL;
}

export function defaultBaseUrlForChannelInterface(interfaceType?: ChannelInterfaceType) {
    if (interfaceType === "gemini-veo" || interfaceType === "gemini-image") return GEMINI_BASE_URL;
    if (interfaceType === "novita-video") return "https://api.novita.ai/v3";
    if (interfaceType === "volcengine-ark-agent-plan-image" || interfaceType === "volcengine-ark-agent-plan-video") return "https://ark.cn-beijing.volces.com/api/plan/v3";
    if (interfaceType === "volcengine-ark-image" || interfaceType === "volcengine-ark-video") return "https://ark.cn-beijing.volces.com/api/v3";
    if (interfaceType === "volcengine-jimeng-image" || interfaceType === "volcengine-jimeng-video") return "https://visual.volcengineapi.com";
    if (interfaceType === "minimax-video") return "https://api.minimaxi.com";
    if (interfaceType === "grok-image" || interfaceType === "newapi" || interfaceType === "newapi-channel-1" || interfaceType === "newapi-channel-2" || interfaceType === "xai-video") return "";
    return OPENAI_BASE_URL;
}

function capabilityForChannelInterface(interfaceType?: ChannelInterfaceType): ModelCapability | undefined {
    return modelProtocolCapability(interfaceType);
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" || apiFormat === "claude" ? apiFormat : "openai";
}

function normalizeChannelInterfaceType(value: unknown): ChannelInterfaceType | undefined {
    return normalizeModelProtocol(value);
}

function uniqueRawModels(models: string[]) {
    return Array.from(new Set((models || []).map(normalizeRawModelName).filter(Boolean)));
}

function uniqueModelOptions(models: string[]) {
    return Array.from(
        new Set(
            (models || [])
                .filter((model): model is string => typeof model === "string")
                .map((model) => model.trim())
                .filter(Boolean),
        ),
    );
}

function normalizeRawModelName(value: unknown) {
    if (typeof value !== "string") return "";
    const model = modelOptionName(value).trim();
    return model && model !== "undefined" && model !== "null" ? model : "";
}
