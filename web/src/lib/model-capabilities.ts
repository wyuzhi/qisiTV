import { beefAPIImageContract } from "@/lib/beefapi-image-contracts";
import { modelProtocolCapability, type ModelProtocol, type ModelProtocolWorkflow } from "@/lib/model-protocols";
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
    workflowFieldChoiceValues,
    workflowFieldNumberBounds,
    workflowFieldOptionValues,
    workflowFieldPresetOptions,
    workflowFieldSubmissionValue,
    workflowImageCapabilityConfig,
    workflowOutputSizeValue,
    workflowVideoDefaultSize,
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
    workflowFieldChoiceValues,
    workflowFieldNumberBounds,
    workflowFieldPresetOptions,
    workflowFieldSubmissionValue,
    workflowImageCapabilityConfig,
    workflowOutputSizeValue,
    workflowVideoDefaultSize,
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

export function defaultModelCapabilityConfig(protocol?: ModelProtocol, model = ""): ModelCapabilityConfig {
    const text: TextCapabilityConfig = {
        streaming: protocol !== "likeai-text",
        // 文本模型的视觉能力必须由管理员明确开启，不能根据模型名猜测。
        references: { promptMaxChars: 32000, maxImages: 0, maxImageBytes: 0, maxVideos: 0, maxVideoBytes: 0 },
    };
    return {
        version: 1,
        text,
        image: defaultImageCapabilityConfig(protocol, model),
        video: defaultVideoCapabilityConfig(protocol, model),
    };
}

export function pluginWorkflowCapabilityConfig(protocol: ModelProtocol, workflow: ModelProtocolWorkflow): ModelCapabilityConfig | undefined {
    if (workflow.capability !== "image" && workflow.capability !== "video") return undefined;
    const fallback = defaultModelCapabilityConfig(protocol, workflow.id);
    const fields: WorkflowVideoFieldLike[] = workflow.parameters.map((parameter) => ({
        fieldName: parameter.name,
        source: parameter.mapping,
        fieldType: parameter.type,
        options: parameter.values,
        defaultValue: workflow.defaults?.[parameter.name],
    }));
    if (workflow.capability === "image") {
        return { ...fallback, image: workflowImageCapabilityConfig(fields, fallback.image!) };
    }
    return { ...fallback, video: workflowVideoCapabilityConfig(fields, fallback.video!) };
}

export function modelCapabilityConfigFor(
    config: { channels: Array<{ id: string; models: string[]; baseUrl?: string; credentialRef?: string; interfaceType?: ModelProtocol; modelProfiles?: Array<{ model: string; capability?: string; capabilityConfig?: ModelCapabilityConfig; protocol?: ModelProtocol; imageCapabilitiesVersion?: string; videoCapabilitiesVersion?: string }> }> },
    model: string,
): ModelCapabilityConfig {
    const separator = model.indexOf("::");
    const channelId = separator >= 0 ? model.slice(0, separator) : "";
    const modelName = separator >= 0 ? model.slice(separator + 2) : model;
    const channel = config.channels.find((item) => item.id === channelId) || config.channels.find((item) => item.models.includes(modelName));
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
        if (protocol === "openai-image" && beefAPIImageContract(modelName)?.fixedOutputs && ["beeftv.app", "beefapi.com", "enterprise.beefapi.com", "whatstoken.ai", "www.whatstoken.ai"].includes(new URL(channel?.baseUrl || "").hostname.toLowerCase())) return fallback;
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

// 工作流字段是供应商参数的唯一事实来源；不能用普通视频模型的固定清晰度列表覆盖它。
export type WorkflowVideoFieldLike = {
    nodeId?: string;
    classType?: string;
    fieldName?: string;
    label?: string;
    role?: string;
    safeToOverride?: boolean;
    optionsSource?: string;
    enabled?: boolean;
    source?: string;
    sourceFromUpstream?: boolean;
    randomEnabled?: boolean;
    fieldType?: string;
    options?: unknown[];
    fieldValue?: unknown;
    value?: unknown;
    default?: unknown;
    defaultValue?: unknown;
    min?: unknown;
    max?: unknown;
    step?: unknown;
};

export type WorkflowFieldNumberBounds = { min?: number; max?: number; step?: number };

export function workflowFieldKey(field: WorkflowVideoFieldLike) {
    return `field:${String(field.nodeId || "").trim()}:${String(field.fieldName || "").trim()}`;
}

export function workflowFieldRandomKey(field: WorkflowVideoFieldLike) {
    return `random:${String(field.nodeId || "").trim()}:${String(field.fieldName || "").trim()}`;
}

export function workflowFieldSource(field: WorkflowVideoFieldLike) {
    return String(field.source || "")
        .trim()
        .replace(/[\s_-]/g, "")
        .toLowerCase();
}

export function workflowParameterFields(fields: readonly WorkflowVideoFieldLike[]) {
    return fields.filter((field) => {
        const source = workflowFieldSource(field);
        const fieldType = String(field.fieldType || "")
            .trim()
            .toUpperCase();
        if (!field.fieldName || !field.nodeId || field.enabled === false || !workflowFieldSafeToOverride(field)) return false;
        if (["prompt", "text", "positiveprompt", "positive", "referenceimage", "image", "referencevideo", "video", "referenceaudio", "audio", "mask"].includes(source)) return false;
        if (["IMAGE", "VIDEO", "AUDIO"].includes(fieldType)) return false;
        return true;
    });
}

export function workflowFieldSafeToOverride(field: WorkflowVideoFieldLike) {
    if (field.safeToOverride === false) return false;
    const classType = String(field.classType || "")
        .trim()
        .toLowerCase();
    const fieldName = String(field.fieldName || "")
        .trim()
        .toLowerCase();
    if (classType === "int" && fieldName === "value") return false;
    return classType !== "imageresize+" || !["width", "height", "multiple_of"].includes(fieldName);
}

export function workflowFieldRole(field: WorkflowVideoFieldLike) {
    if (["prompt", "media", "business", "internal"].includes(String(field.role || ""))) return String(field.role);
    const source = workflowFieldSource(field);
    const fieldType = String(field.fieldType || "")
        .trim()
        .toUpperCase();
    if (["prompt", "text", "positiveprompt", "positive"].includes(source)) return "prompt";
    if (["referenceimage", "image", "referencevideo", "video", "referenceaudio", "audio", "mask"].includes(source) || ["IMAGE", "VIDEO", "AUDIO"].includes(fieldType)) return "media";
    if (!workflowFieldSafeToOverride(field)) return "internal";
    const key = normalizeWorkflowVideoFieldKey(String(field.fieldName || ""));
    if (
        [
            "aspectratio",
            "ratio",
            "duration",
            "durationseconds",
            "seconds",
            "videoseconds",
            "quality",
            "resolution",
            "seed",
            "noiseseed",
            "steps",
            "step",
            "sigmapoints",
            "cfg",
            "cfgscale",
            "guidance",
            "guidancescale",
            "sampler",
            "samplername",
            "scheduler",
            "fps",
            "count",
            "batch",
            "batchsize",
            "generateaudio",
            "watermark",
            "negativeprompt",
            "systemprompt",
        ].includes(key)
    )
        return "business";
    return field.classType ? "internal" : "business";
}

export function workflowFieldConfigurationError(field: WorkflowVideoFieldLike) {
    const bounds = workflowFieldNumberBounds(field);
    if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) return "最小值不能大于最大值";
    if (bounds.step !== undefined && bounds.step <= 0) return "步长必须大于 0";
    return "";
}

export function workflowFieldValueError(field: WorkflowVideoFieldLike, value: unknown) {
    const configurationError = workflowFieldConfigurationError(field);
    if (configurationError) return configurationError;
    const fieldType = String(field.fieldType || "")
        .trim()
        .toUpperCase();
    const bounds = workflowFieldNumberBounds(field);
    const numeric = ["NUMBER", "FLOAT", "INTEGER", "INT", "SLIDER"].includes(fieldType) || bounds.min !== undefined || bounds.max !== undefined || bounds.step !== undefined;
    if (numeric) {
        if (value === undefined || value === null || String(value).trim() === "" || !Number.isFinite(Number(value))) return "请输入有效数字";
        const parsed = Number(value);
        if ((bounds.min !== undefined && parsed < bounds.min) || (bounds.max !== undefined && parsed > bounds.max)) return "数值超出允许范围";
        if (bounds.step !== undefined) {
            const start = bounds.min ?? 0;
            const steps = (parsed - start) / bounds.step;
            if (Math.abs(steps - Math.round(steps)) > 1e-7) return "数值不符合步长";
        }
    }
    const options = workflowFieldChoiceValues(field).map(workflowFieldOptionValue);
    if (options.length && !options.includes(workflowFieldOptionValue(value))) return "当前值不在允许选项中";
    return "";
}

export function workflowVideoCapabilityConfig(fields: readonly WorkflowVideoFieldLike[], fallback = defaultVideoCapabilityConfig()): VideoCapabilityConfig {
    const profile: VideoCapabilityConfig = {
        ...fallback,
        references: { ...fallback.references },
        duration: { ...fallback.duration, values: fallback.duration.values ? [...fallback.duration.values] : undefined },
        ratios: [...fallback.ratios],
        resolutions: [...fallback.resolutions],
        generateAudio: { ...fallback.generateAudio },
        watermark: { ...fallback.watermark },
    };
    // 工作流没有统一的分辨率/时长协议。清空普通模型的候选值，
    // 后面只根据工作流字段自身声明的 options 或数值范围恢复控件。
    profile.resolutions = [];
    profile.defaultResolution = "";
    profile.ratios = [];
    profile.defaultRatio = "";
    profile.duration = { selection: "enum", values: [], default: fallback.duration.default };
    profile.generateAudio = { supported: false, default: false };
    profile.watermark = { supported: false, default: false };
    const resolutionField = fields.find((field) => workflowVideoFieldMatches(field, "vquality"));
    const durationField = fields.find((field) => workflowVideoFieldMatches(field, "videoseconds"));
    const ratioField = fields.find((field) => workflowVideoFieldMatches(field, "aspectratio"));

    if (resolutionField) {
        const options = workflowFieldChoiceValues(resolutionField).map(workflowFieldOptionValue).filter(Boolean);
        const bounds = workflowFieldNumberBounds(resolutionField);
        const generated = options.length ? options : bounds.min !== undefined && bounds.max !== undefined ? [] : workflowNumericFieldValues(resolutionField);
        const defaultValue = workflowFieldDefaultValue(resolutionField);
        if (bounds.min === undefined || bounds.max === undefined || bounds.max < bounds.min) {
            if (generated.length) profile.resolutions = generated;
        } else if (defaultValue !== "") profile.resolutions = [defaultValue];
        if (profile.resolutions.length) profile.defaultResolution = matchWorkflowValue(defaultValue, profile.resolutions) || profile.resolutions[0];
    }
    if (durationField) {
        const options = workflowFieldChoiceValues(durationField)
            .map(workflowFieldOptionValue)
            .map(workflowDurationNumber)
            .filter((value): value is number => value !== undefined);
        const bounds = workflowFieldNumberBounds(durationField);
        const generated = options.length ? options : workflowNumericFieldValues(durationField).map(Number).filter(Number.isFinite);
        const defaultValue = Number(workflowFieldDefaultValue(durationField));
        if (generated.length) {
            profile.duration = { selection: "enum", values: [...new Set(generated)], default: Number.isFinite(defaultValue) ? defaultValue : generated[0] };
        } else {
            const min = bounds.min;
            const max = bounds.max;
            const step = bounds.step;
            if (min !== undefined && max !== undefined && max >= min) {
                profile.duration = { selection: "range", min, max, ...(step !== undefined && step > 0 ? { step } : {}), default: Number.isFinite(defaultValue) ? defaultValue : min };
            } else if (Number.isFinite(defaultValue)) {
                // 只有默认值时不能臆造通用时长选项，只保留工作流当前值。
                profile.duration = { selection: "enum", values: [defaultValue], default: defaultValue };
            }
        }
    }
    if (ratioField) {
        const options = workflowFieldOptionValues(ratioField.options);
        const defaultValue = workflowFieldDefaultValue(ratioField);
        // 工作流声明了比例字段时，不能继续沿用普通模型的比例列表。
        // 没有 options 时只保留该字段当前默认值（例如 `auto`）。
        profile.ratios = options.length ? options : defaultValue ? [defaultValue] : [];
        if (profile.ratios.length) profile.defaultRatio = matchWorkflowValue(defaultValue, profile.ratios) || profile.ratios[0];
    }
    const generateAudioField = fields.find((field) => workflowBooleanFieldMatches(field, "generateaudio"));
    const watermarkField = fields.find((field) => workflowBooleanFieldMatches(field, "watermark"));
    if (generateAudioField) profile.generateAudio = { supported: true, default: workflowBooleanDefault(generateAudioField) };
    if (watermarkField) profile.watermark = { supported: true, default: workflowBooleanDefault(watermarkField) };
    return profile;
}

export function workflowVideoFieldsFromJson(value: Record<string, unknown> | undefined) {
    if (!value || typeof value !== "object") return [] as WorkflowVideoFieldLike[];
    const fields: WorkflowVideoFieldLike[] = [];
    Object.entries(value).forEach(([nodeId, rawNode]) => {
        if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) return;
        const node = rawNode as Record<string, unknown>;
        const classType = String(node.class_type || node.type || "").trim();
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return;
        Object.entries(inputs as Record<string, unknown>).forEach(([fieldName, fieldValue]) => {
            if (Array.isArray(fieldValue)) return;
            const fieldType = typeof fieldValue === "number" ? "NUMBER" : typeof fieldValue === "boolean" ? "BOOLEAN" : "TEXT";
            const candidate = { nodeId, classType, fieldName, fieldValue, fieldType };
            const safeToOverride = workflowFieldSafeToOverride(candidate);
            const role = workflowFieldRole(candidate);
            fields.push({ ...candidate, safeToOverride, role, enabled: safeToOverride && role !== "internal" });
        });
    });
    return fields;
}

export function workflowVideoFieldMatches(field: WorkflowVideoFieldLike, source: string) {
    const keys = [field.source, field.fieldName, field.label].map((value) => normalizeWorkflowVideoFieldKey(String(value || ""))).filter(Boolean);
    if (source === "vquality") {
        // quality 是工作流自己的质量参数（可能是 0.1-3 这类连续值），
        // 只有显式 videoquality/videoresolution/vquality 才属于视频分辨率。
        if (workflowFieldSource(field) === "quality" || keys.some((key) => ["quality", "imagequality"].includes(key))) return false;
        return keys.some((key) => ["vquality", "videoresolution", "videoquality", "resolution"].includes(key) || key.includes("清晰度") || key.includes("分辨率"));
    }
    if (source === "videoseconds") {
        return keys.some((key) => ["videoseconds", "duration", "seconds", "durationseconds", "videoduration", "videodurationseconds", "videolength", "clipduration"].includes(key) || key.includes("时长") || key.includes("秒数"));
    }
    if (source === "size") {
        return keys.some((key) => ["size", "imagesize", "imageresolution", "resolution"].includes(key));
    }
    if (source === "quality") {
        return workflowFieldSource(field) === "quality" || keys.some((key) => ["quality", "imagequality"].includes(key) || key.includes("清晰度"));
    }
    return keys.some((key) => ["aspectratio", "ratio", "imageaspectratio", "imageratio", "videoaspectratio", "videoratio"].includes(key));
}

function workflowBooleanFieldMatches(field: WorkflowVideoFieldLike, name: "generateaudio" | "watermark") {
    const keys = [field.source, field.fieldName, field.label].map((value) => normalizeWorkflowVideoFieldKey(String(value || ""))).filter(Boolean);
    return keys.some((key) => key === name || key.endsWith(name));
}

function workflowBooleanDefault(field: WorkflowVideoFieldLike) {
    const value = workflowFieldDefaultValue(field).toLowerCase();
    return value === "true" || value === "1" || value === "yes";
}

export function normalizeWorkflowVideoFieldKey(value: string) {
    return String(value)
        .toLowerCase()
        .replace(/[\s_-]/g, "");
}

export function workflowFieldOptionValue(value: unknown): string {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const item = value as Record<string, unknown>;
        for (const key of ["value", "id", "key", "name", "label"]) {
            if (item[key] !== undefined && item[key] !== null && String(item[key]).trim()) return String(item[key]).trim();
        }
    }
    return value === undefined || value === null ? "" : String(value).trim();
}

export function workflowFieldDefaultValue(field: WorkflowVideoFieldLike | undefined) {
    if (!field) return "";
    return workflowFieldOptionValue(field.fieldValue ?? field.defaultValue ?? field.value ?? field.default);
}

/**
 * 读取画布当前的工作流字段值。新版本按 nodeId + fieldName 保存；旧画布曾按
 * source 语义键保存，比例字段必须兼容读取，否则会静默回退到工作流默认的 1:1。
 */
export function workflowFieldCurrentValue(field: WorkflowVideoFieldLike | undefined, values: Readonly<Record<string, unknown>>) {
    if (!field) return undefined;
    for (const key of [workflowFieldKey(field), ...workflowFieldLegacyKeys(field)]) {
        if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    }
    // 旧画布和新工作流 schema 可能分别使用 aspectRatio / aspect_ratio，
    // 字段语义相同但存储键不同。读取时按节点号和规范化字段名兼容，
    // 避免找不到用户已选值后回退到工作流或全局默认比例。
    const nodeKey = normalizeWorkflowParameterPart(field.nodeId);
    const fieldKeys = [field.fieldName, field.source, field.label].map((value) => normalizeWorkflowParameterPart(value)).filter(Boolean);
    if (nodeKey && fieldKeys.length) {
        for (const [key, value] of Object.entries(values)) {
            const match = key.match(/^field:([^:]+):(.+)$/i);
            if (!match) continue;
            if (normalizeWorkflowParameterPart(match[1]) === nodeKey && fieldKeys.includes(normalizeWorkflowParameterPart(match[2]))) return value;
        }
    }
    return field.fieldValue ?? field.defaultValue ?? field.value ?? field.default;
}

export function workflowFieldHasStoredValue(field: WorkflowVideoFieldLike | undefined, values: Readonly<Record<string, unknown>>) {
    if (!field) return false;
    if ([workflowFieldKey(field), ...workflowFieldLegacyKeys(field)].some((key) => Object.prototype.hasOwnProperty.call(values, key))) return true;
    const nodeKey = normalizeWorkflowParameterPart(field.nodeId);
    const fieldKeys = [field.fieldName, field.source, field.label].map((value) => normalizeWorkflowParameterPart(value)).filter(Boolean);
    if (!nodeKey || !fieldKeys.length) return false;
    return Object.keys(values).some((key) => {
        const match = key.match(/^field:([^:]+):(.+)$/i);
        return Boolean(match && normalizeWorkflowParameterPart(match[1]) === nodeKey && fieldKeys.includes(normalizeWorkflowParameterPart(match[2])));
    });
}

function normalizeWorkflowParameterPart(value: unknown) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, "");
}

function workflowFieldLegacyKeys(field: WorkflowVideoFieldLike) {
    const keys = [field.source, field.fieldName, field.label].map((value) => normalizeWorkflowVideoFieldKey(String(value || ""))).filter(Boolean);
    if (keys.some((key) => ["aspectratio", "ratio", "imageaspectratio", "imageratio", "videoaspectratio", "videoratio"].includes(key))) {
        return ["source:aspectRatio", "source:aspect_ratio", "source:ratio"];
    }
    if (keys.some((key) => ["size", "imagesize", "imageresolution"].includes(key))) return ["source:size"];
    if (keys.some((key) => ["quality", "imagequality"].includes(key))) return ["source:quality"];
    if (keys.some((key) => ["vquality", "videoresolution", "videoquality"].includes(key))) return ["source:vquality", "source:videoResolution"];
    if (keys.some((key) => ["videoseconds", "duration", "durationseconds", "seconds"].includes(key))) return ["source:videoSeconds", "source:duration", "source:duration_seconds"];
    if (keys.some((key) => ["count", "batch", "batchsize"].includes(key))) return ["source:count", "source:batch"];
    return [] as string[];
}

function workflowNumericFieldValues(field: WorkflowVideoFieldLike) {
    const bounds = workflowFieldNumberBounds(field);
    const min = bounds.min;
    const max = bounds.max;
    const step = bounds.step;
    if (min === undefined || max === undefined || max < min || step === undefined || step <= 0) return [] as string[];
    const count = Math.floor((max - min) / step) + 1;
    if (count <= 0 || count > 32) return [] as string[];
    return Array.from({ length: count }, (_, index) => String(Number((min + index * step).toFixed(6))));
}

function workflowDurationNumber(value: string) {
    const parsed = Number(
        String(value)
            .trim()
            .replace(/(?:s|秒)$/i, ""),
    );
    return Number.isFinite(parsed) ? parsed : undefined;
}

function matchWorkflowValue(value: string, options: string[]) {
    if (!value) return "";
    return options.find((option) => option.toLowerCase() === value.toLowerCase()) || options.find((option) => option.replace(/p$/i, "").toLowerCase() === value.replace(/p$/i, "").toLowerCase()) || "";
}
