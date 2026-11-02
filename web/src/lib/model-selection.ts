import { defaultImageCapabilityConfig, modelCapabilityConfigFor, normalizeImageValue, normalizeVideoValue, STANDARD_IMAGE_SIZE_VALUES, videoDurationAllowed, videoReferencesForOperation, type ImageCapabilityConfig } from "@/lib/model-capabilities";
import { normalizeVideoBoolean, normalizeVideoResolutionValue, videoResolutionComparisonKey } from "@/lib/video-generation-options";
import { imageSizePresets } from "@/lib/image-size-presets";
import { sanitizeVideoPriceQuote, seedancePortraitLabel, seedancePortraitModel } from "@/lib/seedance-portrait";
import { channelModelProfile, filterModelsByCapability, modelOptionName, normalizeModelOptionValue, resolveModelChannel, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

export type ModelInputSummary = {
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
    characterCount: number;
};

export type ModelRequirements = {
    capability?: ModelCapability;
    input?: ModelInputSummary;
    videoOperation?: string;
    videoSeconds?: string;
    imageSize?: string;
    options?: Record<string, unknown>;
};

export type DisplayModelGroup = {
    key: string;
    label: string;
    models: string[];
};

export type ModelReferenceLimits = {
    maxImages: number;
    maxVideos: number;
    maxAudios: number;
};

export function groupModelsByDisplayName(config: AiConfig, models: string[]): DisplayModelGroup[] {
    const groups = new Map<string, DisplayModelGroup>();
    models.forEach((model) => {
        const channel = resolveModelChannel(config, model);
        const label = configuredModelDisplayName(config, model);
        const key = `${channel.id}\u0000${label.toLocaleLowerCase()}`;
        const current = groups.get(key);
        if (current) current.models.push(model);
        else groups.set(key, { key, label, models: [model] });
    });
    return Array.from(groups.values()).map((group) => ({ ...group, models: [...group.models].sort((a, b) => Number(Boolean(seedancePortraitModel(a))) - Number(Boolean(seedancePortraitModel(b)))) }));
}

export function configuredModelDisplayName(config: AiConfig, value: string) {
    const portrait = seedancePortraitLabel(value);
    if (portrait) return portrait;
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    return channelModelProfile(channel, model)?.displayName?.trim() || model;
}

// Shared by selection and paid submission, including retries and batch jobs.
export function portraitGenerationError(config: AiConfig, model: string, resolution?: string) {
    if (!seedancePortraitModel(model)) return "";
    if (!normalizeModelOptionValue(model, config.channels)) return "真人素材版当前不可用，请刷新模型列表或重新选择模型";
    const channel = resolveModelChannel(config, model);
    const profile = channel.modelProfiles?.find((item) => item.model === modelOptionName(model));
    // 只有渠道目录下发了报价字段时才按报价核对；自带 Key 的渠道没有报价，交给上游自己判断。
    if (profile?.videoPricing === undefined) return "";
    const quote = sanitizeVideoPriceQuote(profile.videoPricing);
    if (!quote || quote.mode !== "tokens") return "真人素材版价格暂不可用，请刷新模型列表";
    if (resolution !== undefined) {
        const normalized = normalizeVideoResolutionValue(resolution);
        const key = normalized === "2160" ? "4k" : `${normalized}p`;
        if (!quote.rates[key]) return "当前分辨率价格暂不可用，请选择其他分辨率或刷新模型列表";
    }
    return "";
}

/**
 * 只有三种能力来源可以限制用户：服务端目录带版本号的声明、部署方配置的系统渠道、用户在「能力与参数」里亲手改过的值。
 * 设置页自动补出的默认能力只用来填充界面选项，不代表上游的真实上限，因此不能置灰模型或裁掉参考素材。
 */
export function hasDeclaredModelCapability(config: AiConfig, model: string, capability: "image" | "video") {
    const channel = resolveModelChannel(config, model);
    const profile = channelModelProfile(channel, modelOptionName(model));
    if (!profile?.capabilityConfig?.[capability]) return false;
    const version = capability === "image" ? profile.imageCapabilitiesVersion : profile.videoCapabilitiesVersion;
    return Boolean(version?.trim()) || channel.scope === "system" || profile.capabilitySource === "user";
}

export function modelCompatibilityError(config: AiConfig, model: string, requirements?: ModelRequirements) {
    const capability = requirements?.capability;
    if (!capability) return "";
    const input = requirements?.input;
    const visualInputCount = input ? input.imageCount + input.characterCount : 0;
    const channel = resolveModelChannel(config, model);
    const logicalCost = channel.modelProfiles?.find((item) => item.model === modelOptionName(model));
    const portraitError = capability === "video" ? portraitGenerationError(config, model) : "";
    if (portraitError) return portraitError;
    const logicalSpecs = logicalCost?.logicalCapabilityProfiles?.length ? logicalCost.logicalCapabilityProfiles : logicalCost?.logicalCapabilitySpec ? [logicalCost.logicalCapabilitySpec] : [];
    if (logicalSpecs.length) {
        const publicOptionNames = logicalCost?.logicalCapabilitySpec?.options || {};
        const logicalRequirements = {
            ...requirements,
            options: Object.fromEntries(Object.entries(requirements.options || {}).filter(([name]) => Boolean(publicOptionNames[name])).map(([name, value]) => [name, capability === "image" && name === "count" ? modelCapabilityConfigFor(config, model).image?.fixedOutputs || value : value])),
        };
        const errors = logicalSpecs.map((spec) => logicalModelCompatibilityError(spec, logicalRequirements, visualInputCount));
        return errors.some((error) => !error) ? "" : errors[0] || "当前输入不受支持";
    }

    if (capability === "image") {
        const hasDeclaredImageCapability = hasDeclaredModelCapability(config, model, "image");
        const image = modelCapabilityConfigFor(config, model).image!;
        // 尺寸兼容不依赖输入摘要：无输入时（如画布重试/工具链）也要按尺寸过滤组内模型。
        if (hasDeclaredImageCapability && requirements.imageSize && !image.size.allowCustom && !image.size.values.includes(requirements.imageSize)) return "不支持当前尺寸";
        if (!input) return "";
        if (input.videoCount > 0) return "图片模型不支持参考视频";
        if (input.audioCount > 0) return "图片模型不支持参考音频";
        if (hasDeclaredImageCapability && visualInputCount > image.references.maxImages) return `最多支持 ${image.references.maxImages} 张参考图`;
        return "";
    }

    if (capability === "video") {
        const capabilityConfig = modelCapabilityConfigFor(config, model);
        if (!hasDeclaredModelCapability(config, model, "video")) return "";
        const profile = capabilityConfig.video!;
        if (requirements.videoOperation !== "draft_to_final" && requirements.videoSeconds && !videoDurationAllowed(profile, Number(requirements.videoSeconds))) return "不支持当前视频时长";
        if (!input) return "";
        const operation = resolveVideoOperation(input, requirements.videoOperation);
        const refs = videoReferencesForOperation(profile, requirements.videoOperation || "");
        if (visualInputCount > refs.maxImages) return `最多支持 ${refs.maxImages} 张参考图`;
        if (input.videoCount > refs.maxVideos) return `最多支持 ${refs.maxVideos} 个参考视频`;
        if (input.audioCount > refs.maxAudios) return `最多支持 ${refs.maxAudios} 个参考音频`;
        if (operation !== "concat" && !profile.operations.includes(operation)) return `不支持${videoOperationLabel(operation)}`;
        return "";
    }

    if (!input) return "";

    if (capability === "text") {
        return input.audioCount > 0 ? "文本模型不支持参考音频" : "";
    }

    if (input.characterCount > 1) return "角色配音一次只能引用一个角色卡";
    return input.imageCount > 0 || input.videoCount > 0 || input.audioCount > 0 ? "音频模型只接受文本或单个角色卡输入" : "";
}

export function modelRequestOptions(config: AiConfig, capability: ModelCapability) {
    switch (capability) {
        case "image":
            return { size: config.size, quality: config.quality, transparentBackground: config.transparentBackground === "true", count: Number(config.count) };
        case "video":
            return { size: config.size, videoSeconds: Number(config.videoSeconds), vquality: config.vquality, videoGenerateAudio: config.videoGenerateAudio === "true", videoWatermark: config.videoWatermark === "true" };
        case "audio":
            return { audioVoice: config.audioVoice, audioFormat: config.audioFormat, audioSpeed: Number(config.audioSpeed), audioPitch: Number(config.audioPitch), audioVolume: Number(config.audioVolume) };
        default:
            return {};
    }
}

function logicalModelCompatibilityError(spec: NonNullable<NonNullable<AiConfig["channels"][number]["modelProfiles"]>[number]["logicalCapabilitySpec"]>, requirements: ModelRequirements, visualInputCount: number) {
    if (requirements.capability && spec.capability !== requirements.capability) return "不支持当前生成类型";
    const input = requirements.input;
    const counts: Record<string, number> = {
        text: 0,
        image: visualInputCount,
        video: input?.videoCount || 0,
        audio: input?.audioCount || 0,
    };
    for (const [kind, count] of Object.entries(counts)) {
        const constraint = spec.inputs?.[kind];
        if (!constraint && count > 0) return `不支持${kind}输入`;
        if (constraint && (count < constraint.min || count > constraint.max)) return `${kind}输入需为 ${constraint.min}-${constraint.max} 个`;
    }
    const operation = requirements.capability === "video" && input ? resolveVideoOperation(input, requirements.videoOperation) : requirements.videoOperation;
    if (operation && spec.operations?.length && !spec.operations.includes(operation)) return "不支持当前生成模式";
    // 图片创作状态也会携带全局默认视频时长；这个字段只对视频模型有意义，
    // 不能把它拼进图片逻辑模型的能力匹配，否则图片模型会被误判为“不支持当前时长”。
    const options = {
        ...requirements.options,
        ...(requirements.capability === "video" && requirements.videoSeconds ? { videoSeconds: requirements.videoSeconds } : {}),
        ...(requirements.capability === "image" && requirements.imageSize ? { size: requirements.imageSize } : {}),
    };
    for (const [name, value] of Object.entries(options)) {
        if (value === undefined || value === null || value === "") continue;
        const constraint = spec.options?.[name];
        if (!constraint || !logicalOptionMatches(name, constraint, value)) return logicalOptionError(name);
    }
    return "";
}

function logicalOptionMatches(name: string, constraint: { values?: unknown[]; min?: number; max?: number; step?: number }, value: unknown) {
    if (constraint.values?.length) {
        const requested = normalizeLogicalOptionValue(name, value);
        return constraint.values.some((candidate) => normalizeLogicalOptionValue(name, candidate) === requested);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return false;
    if (constraint.min !== undefined && numeric < constraint.min) return false;
    if (constraint.max !== undefined && numeric > constraint.max) return false;
    if (constraint.step !== undefined && constraint.min !== undefined) return Math.abs((numeric - constraint.min) / constraint.step - Math.round((numeric - constraint.min) / constraint.step)) < 1e-9;
    return true;
}

function normalizeLogicalOptionValue(name: string, value: unknown) {
    const normalized = String(value).trim().toLowerCase();
    if (name !== "vquality" && name !== "resolution") return normalized;
    return videoResolutionComparisonKey(normalized);
}

function logicalOptionError(name: string) {
    const label: Record<string, string> = {
        size: "尺寸",
        quality: "质量",
        transparentBackground: "透明背景",
        count: "输出数量",
        videoSeconds: "时长",
        vquality: "分辨率",
        videoGenerateAudio: "同步音频",
        videoWatermark: "水印设置",
        audioVoice: "音色",
        audioFormat: "音频格式",
        audioSpeed: "语速",
        audioPitch: "声调",
        audioVolume: "音量",
    };
    return `不支持当前${label[name] || name}`;
}

export function compatibleModelInGroup(config: AiConfig, models: string[], requirements?: ModelRequirements, preferred?: string) {
    const compatible = models.filter((model) => !modelCompatibilityError(config, model, requirements));
    if (!compatible.length) return "";
    if (compatible.length === 1) return compatible[0];
    return compatible.sort((left, right) => (left === preferred ? -1 : right === preferred ? 1 : 0))[0];
}

export function resolveCompatibleModel(config: AiConfig, selected: string, requirements?: ModelRequirements) {
    if (!requirements?.capability) return selected;
    // Automatic resolution keeps the saved identity. Explicit menu selection
    // may choose the usable canonical entry and refresh its parameters/quote.
    if (seedancePortraitLabel(selected)) return modelCompatibilityError(config, selected, requirements) ? "" : selected;
    const options = selectableModelsByCapability(config, requirements.capability);
    if (!options.length) return selected;
    const selectedGroup = groupModelsByDisplayName(config, options).find((group) => group.models.includes(selected));
    if (!selectedGroup) return selected;
    return compatibleModelInGroup(config, selectedGroup.models, requirements, selected);
}

// 同显示名分组的模型族：尺寸/比例/分辨率选项取组内全部模型配置的并集，
// 让用户能看到并选择任意成员支持的能力，选中后由兼容路由落到具体模型。
// 质量、透明背景等其余能力取当前选中（路由后）模型的配置，与创作页面一致。
export function mergedImageCapabilityConfig(config: AiConfig, selected: string): ImageCapabilityConfig {
    const options = selectableModelsByCapability(config, "image");
    const group = options.length ? groupModelsByDisplayName(config, options).find((item) => item.models.includes(selected)) : undefined;
    const models = group?.models.length ? group.models : [selected];
    const selectedProfile = modelCapabilityConfigFor(config, selected).image;
    const profiles = models.map((model) => modelCapabilityConfigFor(config, model).image).filter((profile): profile is ImageCapabilityConfig => Boolean(profile));
    if (profiles.length <= 1) return selectedProfile || defaultImageCapabilityConfig();
    const concreteValues = Array.from(new Set(profiles.flatMap((profile) => profile.size.values).filter((value) => value !== "*")));
    const allowCustom = profiles.some((profile) => profile.size.allowCustom || profile.size.values.includes("*"));
    const values = concreteValues.length ? concreteValues : allowCustom ? [...STANDARD_IMAGE_SIZE_VALUES] : [];
    const base = selectedProfile || profiles[0];
    const presets = profiles.some((profile) => profile.size.presets) ? [...new Map(profiles.flatMap((profile) => imageSizePresets(profile)).map((preset) => [`${preset.tier}:${preset.ratio}:${preset.size}`, preset])).values()] : undefined;
    return { ...base, size: { ...base.size, values, allowCustom, presets } };
}

// 切换模型后初始化图片参数为该模型能力默认值，避免旧参数在目标模型族不兼容导致无法切换。
export function defaultImageParamsForModel(config: AiConfig, model: string): Pick<AiConfig, "size" | "quality" | "transparentBackground"> {
    const image = modelCapabilityConfigFor(config, model).image;
    if (!image) return { size: "1:1", quality: "auto", transparentBackground: "false" };
    const sizeValues = image.size.values.filter((value) => value !== "*");
    const sizeDefault = image.size.default !== "*" && image.size.default ? image.size.default : sizeValues[0] || "1:1";
    return {
        size: sizeDefault,
        quality: image.quality.default || "auto",
        transparentBackground: String(image.transparentBackground.default ?? false),
    };
}

export function resolveMaskEditModel(config: AiConfig, requestedModel?: string) {
    const rawCandidates = [
        requestedModel,
        config.imageModel,
        ...(config.imageModels || []),
        ...selectableModelsByCapability(config, "image"),
        config.model,
        ...(config.models || []),
    ].filter((item): item is string => Boolean(item?.trim()));
    const imageCandidates = filterModelsByCapability(rawCandidates, "image", config.channels);
    return (
        imageCandidates.find((candidate) => modelCapabilityConfigFor(config, candidate).image?.references.maskSupported) ||
        imageCandidates[0] ||
        ""
    );
}

export function normalizeMaskEditQuality(quality: string | undefined, size: string | undefined, supportedValues?: string[], defaultQuality = "auto") {
    if (supportedValues && !supportedValues.length) return defaultQuality || "auto";
    const aliasToStandard: Record<string, string> = { "1k": "low", "2k": "medium", "4k": "high" };
    const aliasToTier: Record<string, string> = { low: "1k", medium: "2k", high: "4k" };
    const resolveSupported = (candidate: string | undefined) => {
        const lower = String(candidate || "").trim().toLowerCase();
        if (!lower) return "";
        if (!supportedValues?.length) return lower;
        const exact = supportedValues.find((item) => item.toLowerCase() === lower);
        if (exact) return exact;
        const mapped = aliasToStandard[lower] || aliasToTier[lower];
        if (mapped) {
            const match = supportedValues.find((item) => item.toLowerCase() === mapped);
            if (match) return match;
        }
        return "";
    };
    const value = String(quality || "").trim().toLowerCase();
    if (value && value !== "auto" && value !== "any") return resolveSupported(value) || defaultQuality || "auto";
    const match = String(size || "").trim().toLowerCase().match(/^(\d+)x(\d+)$/);
    if (!match) return resolveSupported(quality || defaultQuality) || defaultQuality || "auto";
    const pixels = Number(match[1]) * Number(match[2]);
    const tier = pixels <= 2_000_000 ? "1k" : pixels <= 4_300_000 ? "2k" : pixels <= 8_294_400 ? "4k" : "";
    return (tier && resolveSupported(tier)) || resolveSupported(quality || defaultQuality) || defaultQuality || "auto";
}

export function normalizeMaskEditSize(size: string | undefined, supportedValues: string[] | undefined, defaultSize: string, allowCustom = false) {
    const raw = String(size || "").trim();
    if (!raw) return defaultSize;
    if (!supportedValues?.length || supportedValues.includes("*")) return raw;
    const matched = supportedValues.find((item) => item.toLowerCase() === raw.toLowerCase());
    if (matched) return matched;
    if (allowCustom && /^\d+x\d+$/i.test(raw)) return raw;
    return defaultSize;
}

export function initialMaskEditConfig(config: AiConfig): AiConfig {
    const targetModel = resolveMaskEditModel(config, config.imageModel || config.model);
    const defaults = defaultImageParamsForModel(config, targetModel);
    const image = modelCapabilityConfigFor(config, targetModel).image;
    const size = normalizeMaskEditSize(config.size, image?.size.values, defaults.size, image?.size.allowCustom);
    const quality = normalizeMaskEditQuality(config.quality, config.size, image?.quality.supported ? image.quality.values : [], defaults.quality);
    return { ...config, model: targetModel, imageModel: targetModel, size, quality };
}

export type ModelGenerationDefaults = Pick<AiConfig, "size" | "quality" | "transparentBackground" | "count" | "videoSeconds" | "vquality" | "videoGenerateAudio" | "videoWatermark">;

type ModelVideoBooleanOptions = Pick<AiConfig, "videoGenerateAudio" | "videoWatermark">;

export function resolveModelGenerationDefaults(
    config: AiConfig,
    model: string,
    capability: "image" | "video" | undefined,
    explicit: Partial<ModelGenerationDefaults> = {},
    fallback: Partial<ModelGenerationDefaults> = {},
): Partial<ModelGenerationDefaults> {
    if (!capability) return {};
    const channel = resolveModelChannel(config, model);
    const profile = channel.modelProfiles?.find((item) => item.model === modelOptionName(model));
    const isManagedModel = Boolean(profile?.logicalModelId || profile?.logicalCapabilitySpec);
    // A channel model capability profile is an explicit per-model contract too.
    // The persisted global values are legacy defaults and must not override a
    // model's configured duration, ratio, or resolution on a new canvas node.
    const hasModelCapabilityProfile = Boolean(profile?.capabilityConfig);
    const source = (key: keyof ModelGenerationDefaults) => explicit[key] ?? (isManagedModel || hasModelCapabilityProfile ? undefined : fallback[key]);
    const capabilityProfile = modelCapabilityConfigFor(config, model);

    if (capability === "image" && capabilityProfile.image) {
        const normalized = normalizeImageValue(capabilityProfile.image, {
            size: source("size"),
            quality: source("quality"),
            count: source("count"),
            transparentBackground: source("transparentBackground"),
        });
        return normalized;
    }

    if (capability === "video" && capabilityProfile.video) {
        const normalized = normalizeVideoValue(capabilityProfile.video, {
            seconds: source("videoSeconds"),
            ratio: source("size"),
            resolution: source("vquality"),
        });
        return {
            videoSeconds: normalized.seconds,
            size: normalized.ratio,
            vquality: normalized.resolution.replace(/p$/i, ""),
            videoGenerateAudio: normalizeVideoBoolean(source("videoGenerateAudio")) ?? String(capabilityProfile.video.generateAudio.default),
            videoWatermark: source("videoWatermark") ?? String(capabilityProfile.video.watermark.default),
        };
    }

    return {};
}

export function resolveModelVideoBooleanOptions(config: AiConfig, model: string, explicit: Partial<ModelVideoBooleanOptions> = {}, fallback: Partial<ModelVideoBooleanOptions> = {}): ModelVideoBooleanOptions {
    const profile = modelCapabilityConfigFor(config, model).video!;
    const defaults = resolveModelGenerationDefaults(config, model, "video", explicit, fallback);
    return {
        videoGenerateAudio: profile.generateAudio.supported ? (defaults.videoGenerateAudio ?? String(profile.generateAudio.default)) : "false",
        videoWatermark: profile.watermark.supported ? (defaults.videoWatermark ?? String(profile.watermark.default)) : "false",
    };
}

export function maxModelInputCapacity(config: AiConfig, capability: "image" | "video", kind: "image" | "video" | "audio") {
    const options = selectableModelsByCapability(config, capability);
    if (!options.length) return null;
    if (options.some((model) => !hasDeclaredModelCapability(config, model, capability))) return null;
    return options.reduce((maximum, model) => {
        const profile = modelCapabilityConfigFor(config, model);
        const value =
            capability === "image" ? (kind === "image" ? profile.image!.references.maxImages : 0) : kind === "image" ? profile.video!.references.maxImages : kind === "video" ? profile.video!.references.maxVideos : profile.video!.references.maxAudios;
        return Math.max(maximum, value);
    }, 0);
}

export function modelGroupReferenceLimits(config: AiConfig, selected: string, capability: ModelCapability, requirements?: ModelRequirements): ModelReferenceLimits | undefined {
    if (capability !== "image" && capability !== "video") return undefined;
    if (selected && !hasDeclaredModelCapability(config, selected, capability)) return undefined;
    const options = selectableModelsByCapability(config, capability);
    const selectedGroup = groupModelsByDisplayName(config, options).find((group) => group.models.includes(selected));
    const groupModels = selectedGroup?.models || (selected ? [selected] : []);
    const declaredModels = groupModels.filter((model) => hasDeclaredModelCapability(config, model, capability));
    if (!declaredModels.length) return undefined;
    const compatibleModels = requirements ? declaredModels.filter((model) => !modelCompatibilityError(config, model, requirements)) : declaredModels;
    const models = compatibleModels.length ? compatibleModels : declaredModels;
    return models.reduce<ModelReferenceLimits>(
        (limits, model) => {
            const profile = modelCapabilityConfigFor(config, model);
            if (capability === "image") {
                return { ...limits, maxImages: Math.max(limits.maxImages, profile.image!.references.maxImages) };
            }
            const references = profile.video!.references;
            return {
                maxImages: Math.max(limits.maxImages, references.maxImages),
                maxVideos: Math.max(limits.maxVideos, references.maxVideos),
                maxAudios: Math.max(limits.maxAudios, references.maxAudios),
            };
        },
        { maxImages: 0, maxVideos: 0, maxAudios: 0 },
    );
}

export function inferVideoOperation(input: ModelInputSummary) {
    const visualInputCount = input.imageCount + input.characterCount;
    // 图片或角色决定图生视频主模式，音频只作为附加参考，不应把组合请求
    // 提升为全模态参考；纯音频输入才使用独立的 audio_to_video 能力。
    if (input.videoCount > 0 || visualInputCount > 2) return "reference_to_video";
    if (visualInputCount > 0) return "image_to_video";
    if (input.audioCount > 0) return "audio_to_video";
    return "text_to_video";
}

export function resolveVideoOperation(input: ModelInputSummary, storedOperation?: string) {
    if (storedOperation === "reference_to_video" && input.imageCount + input.characterCount + input.videoCount + input.audioCount > 0) return storedOperation;
    if (storedOperation === "extend" && input.videoCount > 0) return storedOperation;
    if (storedOperation && !["text_to_video", "image_to_video", "audio_to_video", "extend", "reference_to_video"].includes(storedOperation)) return storedOperation;
    return inferVideoOperation(input);
}

function videoOperationLabel(operation: string) {
    if (operation === "text_to_video") return "文生视频";
    if (operation === "image_to_video") return "图生视频";
    if (operation === "audio_to_video") return "音频生视频";
    if (operation === "reference_to_video") return "全模态参考";
    if (operation === "extend") return "视频续写";
    if (operation === "inpaint") return "视频局部修改";
    if (operation === "draft_to_final") return "样片转成片";
    return "当前生成模式";
}
