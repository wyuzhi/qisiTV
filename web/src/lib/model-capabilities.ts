import { beefTVImageContract } from "@/lib/beeftv-image-contracts";
import { channelForId } from "@/lib/channel-identity";
import { modelProtocolDefinition, modelProtocolDefinitionFor, type ModelProtocol, type ModelProtocolDefinition, type ModelProtocolWorkflow } from "@/lib/model-protocols";
import {
    defaultImageCapabilityConfig,
    imageResponseFormatSelectable,
    imageSizeRequest,
    mergeConfiguredImageCapability,
    normalizeCapabilityString,
    normalizeCapabilityStrings,
    normalizeImageSizeSetting,
    normalizeImageValue,
    resolveImageResponseFormat,
    sanitizeServerImageCapability,
    STANDARD_IMAGE_SIZE_VALUES,
    upgradeGPTImageCapability,
    type ImageCapabilityConfig,
    type ImageResponseFormat,
    type ImageResponseFormatConfig,
    type ImageSizeParameter,
} from "./model-capabilities-image";
import {
    alignDocumentedVideoRouteLimits,
    DEFAULT_VIDEO_PROMPT_MAX_CHARS,
    defaultVideoCapabilityConfig,
    isSeedance25Model,
    isSeedance2Family,
    normalizeVideoValue,
    resolveVideoRatioValue,
    resolveVideoResolutionValue,
    sanitizeServerVideoCapability,
    tightenDocumentedOutputDuration,
    versionedVideoCapability,
    videoDurationAllowed,
    videoDurationOptions,
    videoDurationRequirement,
    videoReferencesForOperation,
    videoResolutionRequest,
    videoSupportsTaskTypeConstraints,
    type VideoCapabilityConfig,
} from "./model-capabilities-video";

export {
    DEFAULT_VIDEO_PROMPT_MAX_CHARS,
    defaultImageCapabilityConfig,
    imageResponseFormatSelectable,
    imageSizeRequest,
    isSeedance25Model,
    isSeedance2Family,
    normalizeCapabilityString,
    normalizeImageSizeSetting,
    normalizeImageValue,
    normalizeVideoValue,
    resolveImageResponseFormat,
    resolveVideoRatioValue,
    resolveVideoResolutionValue,
    sanitizeServerImageCapability,
    sanitizeServerVideoCapability,
    STANDARD_IMAGE_SIZE_VALUES,
    tightenDocumentedOutputDuration,
    upgradeGPTImageCapability,
    versionedVideoCapability,
    videoDurationAllowed,
    videoDurationOptions,
    videoDurationRequirement,
    videoReferencesForOperation,
    videoResolutionRequest,
    videoSupportsTaskTypeConstraints,
    type ImageCapabilityConfig,
    type ImageResponseFormat,
    type ImageResponseFormatConfig,
    type ImageSizeParameter,
    type VideoCapabilityConfig,
};

export type ModelCapabilityConfig = {
    version: number;
    text?: TextCapabilityConfig;
    image?: ImageCapabilityConfig;
    video?: VideoCapabilityConfig;
    /** Local display state; never a supplier capability or request option. */
};


export type TextCapabilityConfig = {
    /** Whether the upstream text endpoint accepts SSE streaming responses. */
    streaming?: boolean;
    /** Whether the model exposes a user-selectable reasoning/thinking mode. */
    thinking?: boolean;
    references: {
        promptMaxChars: number;
        maxImages: number;
        maxImageBytes: number;
        maxVideos: number;
        maxVideoBytes: number;
    };
};

export function normalizeModelCapabilityConfig(config: ModelCapabilityConfig): ModelCapabilityConfig {
    return {
        ...config,
        text: config.text ? { ...config.text, streaming: config.text.streaming !== false } : config.text,
        image: config.image
            ? {
                  ...config.image,
                  size: {
                      ...config.image.size,
                      values: normalizeCapabilityStrings(config.image.size.values),
                      default: normalizeCapabilityString(config.image.size.default),
                  },
                  quality: {
                      ...config.image.quality,
                      values: normalizeCapabilityStrings(config.image.quality.values),
                      default: normalizeCapabilityString(config.image.quality.default),
                  },
              }
            : undefined,
        video: config.video
            ? {
                  ...config.video,
                  ratios: normalizeCapabilityStrings(config.video.ratios),
                  defaultRatio: normalizeCapabilityString(config.video.defaultRatio),
                  resolutions: normalizeCapabilityStrings(config.video.resolutions),
                  defaultResolution: normalizeCapabilityString(config.video.defaultResolution),
                  operations: normalizeCapabilityStrings(config.video.operations),
                  defaultOperation: normalizeCapabilityString(config.video.defaultOperation),
              }
            : undefined,
    };
}

function applyProtocolWorkflowVideoCapability(video: VideoCapabilityConfig, workflow: ModelProtocolWorkflow) {
    const findParam = (mapping: string) => workflow.parameters.find((item) => (item.mapping || item.name) === mapping || item.name === mapping);
    const ratioParam = findParam("aspectRatio") || findParam("ratio") || findParam("size");
    const resolutionParam = findParam("resolution");
    const durationParam = findParam("duration");
    if (ratioParam?.values?.length) {
        video.ratios = normalizeCapabilityStrings(ratioParam.values);
        const defRatio = normalizeCapabilityString(workflow.defaults?.[ratioParam.name] ?? workflow.defaults?.aspectRatio ?? workflow.defaults?.ratio);
        video.defaultRatio = video.ratios.includes(defRatio) ? defRatio : video.ratios[0] || "";
    } else if (resolutionParam?.values?.length) {
        video.ratios = [];
        video.defaultRatio = "";
    }
    if (resolutionParam?.values?.length) {
        video.resolutions = normalizeCapabilityStrings(resolutionParam.values);
        const defRes = normalizeCapabilityString(workflow.defaults?.[resolutionParam.name] ?? workflow.defaults?.resolution);
        video.defaultResolution = video.resolutions.includes(defRes) ? defRes : video.resolutions[0] || "";
    }
    if (durationParam) {
        const defDuration = Number(workflow.defaults?.[durationParam.name] ?? workflow.defaults?.duration);
        const rangeMatch = durationParam.description?.match(/(\d+)\s*[~～-]\s*(\d+)/);
        if (durationParam.values?.length) {
            const values = durationParam.values.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
            if (values.length) {
                video.duration = { selection: "enum", values, default: values.includes(defDuration) ? defDuration : values[0]! };
            }
        } else if (rangeMatch) {
            const min = Number(rangeMatch[1]);
            const max = Number(rangeMatch[2]);
            const fallbackDefault = Number.isInteger(defDuration) && defDuration >= min && defDuration <= max ? defDuration : Math.min(max, Math.max(min, video.duration.default));
            video.duration = { selection: "range", min, max, step: 1, default: fallbackDefault };
        } else if (Number.isInteger(defDuration) && defDuration > 0) {
            video.duration = { selection: "enum", values: [defDuration], default: defDuration };
        }
    }
}

export function defaultModelCapabilityConfig(protocol?: ModelProtocol, model = "", protocols?: ModelProtocolDefinition[]): ModelCapabilityConfig {
    const text: TextCapabilityConfig = {
        streaming: true,
        // 文本模型的视觉能力必须由管理员明确开启，不能根据模型名猜测。
        references: { promptMaxChars: 32000, maxImages: 0, maxImageBytes: 0, maxVideos: 0, maxVideoBytes: 0 },
    };
    const video = defaultVideoCapabilityConfig(protocol, model);
    const workflow = protocols?.length
        ? (modelProtocolDefinitionFor(protocol, "video", protocols) || modelProtocolDefinition(protocol, protocols))?.workflows?.find((item) => item.id === model && item.capability === "video")
        : undefined;
    if (workflow) applyProtocolWorkflowVideoCapability(video, workflow);
    return {
        version: 1,
        text,
        image: defaultImageCapabilityConfig(protocol, model),
        video,
    };
}

export function modelCapabilityConfigFor(
    config: { channels: Array<{ id: string; legacyIds?: string[]; models: string[]; baseUrl?: string; credentialRef?: string; interfaceType?: ModelProtocol; modelProfiles?: Array<{ model: string; capability?: string; capabilityConfig?: ModelCapabilityConfig; protocol?: ModelProtocol; imageCapabilitiesVersion?: string; videoCapabilitiesVersion?: string }> }> },
    model: string,
): ModelCapabilityConfig {
    const separator = model.indexOf("::");
    const channelId = separator >= 0 ? model.slice(0, separator) : "";
    const modelName = separator >= 0 ? model.slice(separator + 2) : model;
    const channel = channelForId(config.channels, channelId) || config.channels.find((item) => item.models.includes(modelName));
    // Older desktop config migrations can leave two entries for the same model:
    // a legacy operation-only array followed by the real capability object. The
    // first-match lookup silently selected the malformed legacy entry, so video
    // reference requests were evaluated against stale limits. Prefer a complete
    // capability object while retaining the legacy entry as a fallback.
    const profile = channel?.modelProfiles?.find((item) => item.model === modelName && item.capabilityConfig && !Array.isArray(item.capabilityConfig)) || channel?.modelProfiles?.find((item) => item.model === modelName);
    const protocol = profile?.protocol || channel?.interfaceType;
    if (profile?.imageCapabilitiesVersion && profile.capabilityConfig?.image) return structuredClone(profile.capabilityConfig);
    const sourcedVideo = versionedVideoCapability(profile?.capabilityConfig?.video, profile?.videoCapabilitiesVersion);
    if (sourcedVideo) return { ...defaultModelCapabilityConfig(), video: sourcedVideo };
    const fallback = defaultModelCapabilityConfig(protocol, modelName);
    // Official gateway contracts also upgrade capabilities cached by older installs.
    try {
        if (protocol === "openai-image" && beefTVImageContract(modelName)?.fixedOutputs && ["beeftv.app", "whatstoken.ai", "www.whatstoken.ai"].includes(new URL(channel?.baseUrl || "").hostname.toLowerCase())) return fallback;
    } catch { /* Config without a public endpoint uses its stored capabilities. */ }
    if (!profile?.capabilityConfig) {
        alignDocumentedVideoRouteLimits(fallback.video, protocol, modelName, channel);
        return fallback;
    }
    const capabilityConfig = normalizeModelCapabilityConfig(profile.capabilityConfig);
    const text = capabilityConfig.text ? { ...fallback.text!, ...capabilityConfig.text, references: { ...fallback.text!.references, ...capabilityConfig.text.references } } : fallback.text;
    const video = (capabilityConfig.video ? { ...fallback.video!, ...capabilityConfig.video, references: { ...fallback.video!.references, ...capabilityConfig.video.references, promptMaxUtf16Units: capabilityConfig.video.references.promptMaxUtf16Units ?? 0 } } : fallback.video)!;
    alignDocumentedVideoRouteLimits(video, protocol, modelName, channel);
    const image = upgradeGPTImageCapability(mergeConfiguredImageCapability(fallback.image!, capabilityConfig.image), protocol, modelName);
    return { ...fallback, ...capabilityConfig, text, image, video };
}
