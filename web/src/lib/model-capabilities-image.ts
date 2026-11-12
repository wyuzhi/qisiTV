import { beefTVImageContract } from "@/lib/beeftv-image-contracts";
import type { ImageResolutionOption, ImageResolutionTier } from "@/lib/image-resolution-tiers";
import type { ModelProtocol } from "@/lib/model-protocols";
import { seedreamFamily, seedreamImageCapability } from "@/lib/seedream-image";

export type ImageSizeParameter = "none" | "size" | "aspect_ratio";

export type ImageResponseFormat = "b64_json" | "url";

/**
 * 图片接口 response_format 的开关与取值。
 * value 留空时按 b64_json 处理，让没有选过的渠道保持原有行为。
 */
export type ImageResponseFormatConfig = { supported: boolean; value?: ImageResponseFormat };

export type ImageCapabilityConfig = {
    references: {
        promptMaxChars: number;
        maxImages: number;
        maxImageBytes: number;
        maskSupported: boolean;
    };
    size: {
        parameter: ImageSizeParameter;
        values: string[];
        default: string;
        allowCustom: boolean;
        presets?: ImageResolutionOption[];
    };
    quality: {
        supported: boolean;
        values: string[];
        default: string;
    };
    transparentBackground: { supported: boolean; default: boolean };
    sequentialGeneration?: { supported: boolean; default: boolean };
    responseFormat: ImageResponseFormatConfig;
    outputFormat: { supported: boolean };
    maxOutputs: number;
    fixedOutputs?: number;
    /** Total outputs orchestrated across native fixed-size requests. */
    generationOutputs?: number[];
};

// 旧版本的“允许自定义”可能只保存了 `*`，前台需要用这组标准值恢复可选项。
export const STANDARD_IMAGE_SIZE_VALUES = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "21:9", "9:16", "1024x1024", "1536x1024", "1024x1536"] as const;

export function normalizeCapabilityString(value: unknown) {
    // Persisted channel capability profiles may contain null/undefined or
    // numeric values from older versions. Never let a malformed profile crash
    // canvas rendering through an unguarded `.trim()` call.
    const normalized = String(value ?? "").trim();
    return normalized.startsWith("string:") ? normalized.slice("string:".length) : normalized;
}

export function normalizeCapabilityStrings(values: unknown[]) {
    return Array.from(new Set(values.map(normalizeCapabilityString)));
}

// Keep explicit pixel presets for each resolution tier so the settings panel can
// switch between 1K, 2K and 4K without silently converting the requested ratio.
const defaultImageSizes = [
    "auto",
    "1:1",
    "3:2",
    "2:3",
    "4:3",
    "3:4",
    "16:9",
    "21:9",
    "9:16",
    "1024x1024",
    "1360x1024",
    "1024x1360",
    "1536x1024",
    "1024x1536",
    "1024x1280",
    "1280x1024",
    "2048x880",
    "1824x1024",
    "1024x1824",
    "2048x2048",
    "2304x1728",
    "1728x2304",
    "2496x1664",
    "1664x2496",
    "1792x2240",
    "2240x1792",
    "3136x1344",
    "2752x1536",
    "1536x2752",
    "2880x2880",
    "3264x2448",
    "2448x3264",
    "3504x2336",
    "2336x3504",
    "2560x3200",
    "3200x2560",
    "3808x1632",
    "3840x2160",
    "2160x3840",
];

function isMossImageModel(model: string) {
    const name = String(model ?? "").trim().toLowerCase().split("/").pop() || "";
    return name.startsWith("moss-image");
}

function mossImageCapability(): ImageCapabilityConfig {
    return {
        references: { promptMaxChars: 4000, maxImages: 0, maxImageBytes: 0, maskSupported: false },
        size: {
            parameter: "size",
            values: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "1024x1024", "1024x768", "768x1024", "1360x1024", "1024x1360", "1280x720", "720x1280", "1536x1024", "1024x1536", "1824x1024", "1024x1824", "2048x2048"],
            default: "1:1",
            allowCustom: true,
        },
        quality: { supported: false, values: [], default: "auto" },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: false, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 1,
    };
}

function isExtendedGPTImageModel(protocol: ModelProtocol | undefined, model: string): boolean {
    const normalized = model.trim().toLowerCase();
    if (protocol !== "openai-image" || !normalized.startsWith("gpt-image-")) return false;
    const suffix = normalized.slice(10);
    return ["2.5", "2.5-flare", "2.5-sunburst", "2.6", "2.6-flare", "2.6-sunburst"].includes(suffix);
}

export function upgradeGPTImageCapability(profile: ImageCapabilityConfig, protocol: ModelProtocol | undefined, model: string): ImageCapabilityConfig {
    if (isMossImageModel(model)) return mossImageCapability();
    const seedream = seedreamImageCapability(model);
    if (seedream && protocol !== "likeai-image") return seedream;
    if (protocol !== "openai-image" || (model.trim().toLowerCase() !== "gpt-image-2" && !isExtendedGPTImageModel(protocol, model))) return profile;
    if (!Array.isArray(profile.quality?.values) || !Array.isArray(profile.size?.values)) return profile;
    const defaults = defaultImageCapabilityConfig(protocol, model);
    const legacyQuality = profile.quality.supported && profile.quality.default === "auto" && profile.quality.values.length === 4 && ["auto", "low", "medium", "high"].every((value) => profile.quality.values.includes(value));
    const quality = legacyQuality && (model.trim().toLowerCase() === "gpt-image-2" || defaults.quality.values.includes("xhigh"))
        ? { ...profile.quality, values: [...defaults.quality.values], default: defaults.quality.default } : profile.quality;
    const fixSize = (value: string) => value === "2048x878" ? "2048x880" : value;
    return { ...profile, quality, size: { ...profile.size, values: profile.size.values.map(fixSize), default: fixSize(profile.size.default),
        ...(Array.isArray(profile.size.presets) ? { presets: profile.size.presets.map((preset) => preset.size === "2048x878" ? { ...preset, size: "2048x880", height: 880 } : preset) } : {}) } };
}

export function defaultImageCapabilityConfig(protocol?: ModelProtocol, model = ""): ImageCapabilityConfig {
    if (isMossImageModel(model)) return mossImageCapability();
    const seedream = seedreamImageCapability(model);
    if (seedream && protocol !== "likeai-image") return seedream;
    const image: ImageCapabilityConfig = {
        references: { promptMaxChars: 32000, maxImages: 16, maxImageBytes: 30 * 1024 * 1024, maskSupported: true },
        size: { parameter: "size", values: [...defaultImageSizes], default: "1:1", allowCustom: true },
        quality: { supported: true, values: ["auto", "low", "medium", "high"], default: "auto" },
        transparentBackground: { supported: true, default: false },
        responseFormat: { supported: true },
        outputFormat: { supported: true },
        maxOutputs: 15,
    };
    if (isExtendedGPTImageModel(protocol, model)) {
        image.quality.values = ["auto", "low", "medium", "high", "xhigh", "max"];
    }
    if (protocol === "openai-image" && model.trim().toLowerCase() === "gpt-image-2") {
        image.quality = { supported: true, values: ["low", "medium", "high"], default: "low" };
    }
    const contract = protocol === "openai-image" ? beefTVImageContract(model) : undefined;
    if (contract) {
        const presets = "presets" in contract ? contract.presets as ImageResolutionOption[] : undefined;
        return {
            references: { promptMaxChars: contract.promptMaxChars, maxImages: contract.maxImages, maxImageBytes: contract.maxImageBytes, maskSupported: false },
            size: { parameter: "size", values: [...new Set([...Object.keys(contract.sizes), ...(contract.fixedOutputs ? Object.values(contract.sizes) : []), ...(presets?.flatMap((preset) => [preset.ratio, preset.size]) || [])])], default: "1:1", allowCustom: contract.minSide !== contract.maxSide, ...(presets ? { presets } : {}) },
            quality: { supported: false, values: [], default: "auto" },
            transparentBackground: { supported: false, default: false },
            responseFormat: { supported: Boolean(contract.fixedOutputs) }, outputFormat: { supported: false }, maxOutputs: contract.fixedOutputs || 1, fixedOutputs: contract.fixedOutputs, generationOutputs: "generationOutputs" in contract ? contract.generationOutputs as number[] : undefined,
        };
    }
    if (protocol === "grok-image") {
        image.references.maxImages = 1;
        image.references.maskSupported = false;
        // grok2api / xAI Imagine：size→aspect_ratio，quality→resolution(1k/2k)。
        image.size = {
            parameter: "aspect_ratio",
            values: ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"],
            default: "1:1",
            allowCustom: false,
        };
        image.quality = { supported: true, values: ["1k", "2k"], default: "2k" };
        image.transparentBackground = { supported: false, default: false };
        image.responseFormat = { supported: true };
        image.outputFormat = { supported: false };
        image.maxOutputs = 1;
    } else if (protocol === "volcengine-ark-image" || protocol === "volcengine-ark-agent-plan-image") {
        image.references.maskSupported = false;
        image.quality.supported = false;
        image.transparentBackground.supported = false;
        image.responseFormat.supported = false;
        image.outputFormat.supported = false;
    }
    if (protocol === "volcengine-jimeng-image") {
        image.references.maxImages = 14;
        image.references.maskSupported = false;
        image.quality.supported = false;
        image.transparentBackground.supported = false;
        image.responseFormat.supported = false;
        image.outputFormat.supported = false;
    }
    if (protocol === "gemini-image") {
        image.references.maskSupported = false;
        // Gemini Images uses imageConfig.aspectRatio, not the OpenAI-style pixel size field.
        image.size = {
            parameter: "aspect_ratio",
            values: ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
            default: "1:1",
            allowCustom: false,
        };
        image.transparentBackground = { supported: false, default: false };
        image.responseFormat = { supported: false };
        image.outputFormat = { supported: false };
        image.maxOutputs = 4;
    }
    if (protocol === "agnes-image") {
        // Agnes 图像：size 必填，取 1K/2K/3K/4K 档位或 WxH 精确尺寸，画面比例走独立的 ratio 字段；
        // 参考图放 extra_body.image，支持多图合成，但没有蒙版端点。
        image.references.maxImages = 9;
        image.references.maskSupported = false;
        image.size = {
            parameter: "aspect_ratio",
            values: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"],
            default: "1:1",
            allowCustom: false,
        };
        // 官方档位是 1K/2K/3K/4K，统一层只提供 1k/2k/4k 三档；3K 保留在协议映射里但不在界面露出。
        image.quality = { supported: true, values: ["1k", "2k", "4k"], default: "2k" };
        image.transparentBackground = { supported: false, default: false };
        // 顶层 response_format 是官方明确的错误写法，输出格式只能在 extra_body 内声明。
        image.responseFormat = { supported: false };
        image.outputFormat = { supported: false };
        // 该端点不接受 n，单次请求固定返回一张图片。
        image.maxOutputs = 1;
    }
    if (
        protocol !== "grok-image" &&
        String(model ?? "")
            .trim()
            .toLowerCase()
            .startsWith("grok-imagine-image")
    ) {
        image.references.maxImages = 0;
        image.references.maskSupported = false;
        image.size = {
            parameter: "aspect_ratio",
            values: ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"],
            default: "1:1",
            allowCustom: false,
        };
        image.quality = { supported: true, values: ["1k", "2k"], default: "2k" };
        image.transparentBackground = { supported: false, default: false };
        image.responseFormat = { supported: true };
        image.outputFormat = { supported: false };
        image.maxOutputs = 1;
    }
    if (protocol === "likeai-image") {
        image.references.maskSupported = false;
        image.size = { parameter: "aspect_ratio", values: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"], default: "1:1", allowCustom: true };
        image.quality = { supported: true, values: ["1080p", "1440p", "2160p"], default: ["doubao_seedream_4_5", "doubao_seedream_5_lite", "doubao_seedream_5_pro"].includes(model) ? "1440p" : "1080p" };
        if (model === "doubao_seedream_5_pro") image.quality.values = ["720p", "1080p", "1440p"];
        image.transparentBackground.supported = image.responseFormat.supported = image.outputFormat.supported = false;
        image.maxOutputs = 1;
        if (model === "huoshan_image_super_resolution") {
            image.references.maxImages = 1;
            image.quality = { supported: false, values: [], default: "" };
            image.size = { parameter: "aspect_ratio", values: [], default: "", allowCustom: false };
        }
    }
    return image;
}

/** 图片接口实际要发送的 response_format：未开启返回 null，没选过取值时按 b64_json。 */
export function resolveImageResponseFormat(profile: ImageCapabilityConfig | undefined): ImageResponseFormat | null {
    if (!profile?.responseFormat?.supported) return null;
    return profile.responseFormat.value === "url" ? "url" : "b64_json";
}

/**
 * 能力编辑器里是否允许选择 response_format 的取值。
 * 只有走通用 OpenAI 兼容图片请求的渠道会按配置发出这个参数：
 * 本体自营的 BeefTV 图片契约固定接受内联 base64，grok / seedream / 火山等协议各自写死请求体，
 * 给出选项却发不出去，等于又造一个「设置了不生效」。
 */
export function imageResponseFormatSelectable(protocol: ModelProtocol | undefined, model: string) {
    if (protocol !== "openai-image" || beefTVImageContract(model)) return false;
    // Seedream 走专用请求体，单图分支写死 b64_json，选了 url 也发不出去。
    return !seedreamFamily(model);
}

export function mergeConfiguredImageCapability(fallbackImage: ImageCapabilityConfig, configuredImage: ImageCapabilityConfig | undefined): ImageCapabilityConfig {
    if (!configuredImage) return fallbackImage;
    const configuredSize = configuredImage.size;
    const configuredValues = configuredSize?.values?.map(normalizeCapabilityString);
    const allowCustom = Boolean(configuredSize?.allowCustom || configuredValues?.includes("*"));
    const concreteValues = configuredValues?.filter((value) => value !== "*") || [];
    const values = !configuredValues ? fallbackImage.size.values : concreteValues.length || !allowCustom ? concreteValues : [...STANDARD_IMAGE_SIZE_VALUES];
    const configuredDefault = configuredSize?.default ? normalizeCapabilityString(configuredSize.default) : undefined;
    const defaultValue = configuredDefault && configuredDefault !== "*" && values.includes(configuredDefault) ? configuredDefault : values.find((value) => value !== "*") || fallbackImage.size.default;
    return {
        ...fallbackImage,
        ...configuredImage,
        size: {
            ...fallbackImage.size,
            ...configuredSize,
            values,
            default: defaultValue,
            allowCustom,
        },
    };
}

export function sanitizeServerImageCapability(value: unknown): ImageCapabilityConfig | null {
    if (!value || typeof value !== "object") return null;
    const image = value as ImageCapabilityConfig;
    if (!image.references || !image.size || !image.quality || !image.transparentBackground || !image.responseFormat || !image.outputFormat) return null;
    if (image.sequentialGeneration !== undefined && (!image.sequentialGeneration || typeof image.sequentialGeneration.supported !== "boolean" || typeof image.sequentialGeneration.default !== "boolean")) return null;
    if (![image.references.promptMaxChars, image.references.maxImages, image.references.maxImageBytes].every((item) => Number.isInteger(item) && item >= 0) || !Number.isInteger(image.maxOutputs) || image.maxOutputs < 1) return null;
    if (!["none", "size", "aspect_ratio"].includes(image.size.parameter) || !Array.isArray(image.size.values) || !Array.isArray(image.quality.values)) return null;
    if (image.size.parameter !== "none" && (!image.size.default || (!image.size.allowCustom && !image.size.values.includes(image.size.default)))) return null;
    if (image.quality.supported && !image.quality.values.includes(image.quality.default)) return null;
    return structuredClone(image);
}

export function normalizeImageValue(profile: ImageCapabilityConfig, value: { size?: string; quality?: string; count?: string; transparentBackground?: string }) {
    const size = normalizeImageSizeSetting(profile, value.size);
    const requestedQuality = String(value.quality || "")
        .trim()
        .toLowerCase();
    // 比例协议的固定分辨率预设没有独立 quality 字段时，UI 仍需把当前比例对应的
    // 预设档位带入请求。仅在 quality 未声明支持时启用，避免与 auto/low/medium/high
    // 这组真实图片质量语义混用。
    const presetTier = !profile.quality.supported ? imagePresetTierForSelection(profile, size) : undefined;
    const quality = profile.fixedOutputs && profile.size.presets?.length ? "auto" : profile.quality.supported
        ? requestedQuality === "auto" || requestedQuality === "any"
            ? profile.quality.values.includes("auto") ? "auto" : profile.quality.default
            : value.quality && profile.quality.values.includes(value.quality)
              ? value.quality
              : profile.quality.default || "auto"
        : requestedQuality === "1k" || requestedQuality === "2k" || requestedQuality === "4k"
          ? requestedQuality
          : presetTier || profile.quality.default || "auto";
    const requestedCount = Math.floor(Math.abs(Number(value.count)) || 1);
    const count = String(profile.fixedOutputs ? (profile.generationOutputs?.includes(requestedCount) ? requestedCount : profile.fixedOutputs) : Math.max(1, Math.min(profile.maxOutputs, requestedCount)));
    const transparentBackground = profile.transparentBackground.supported && value.transparentBackground === "true" ? "true" : "false";
    return { size, quality, count, transparentBackground };
}

function imagePresetTierForSelection(profile: ImageCapabilityConfig, size: string): ImageResolutionTier | undefined {
    if (profile.size.parameter !== "aspect_ratio" || !size || size === "auto") return undefined;
    return profile.size.presets?.find((preset) => preset.ratio === size)?.tier;
}

export function normalizeImageSizeSetting(profile: ImageCapabilityConfig, value?: string) {
    if (profile.size.parameter === "none") return "auto";
    const candidate = value?.trim() || profile.size.default;
    if (profile.size.allowCustom || profile.size.values.includes(candidate)) return candidate;
    return profile.size.default || profile.size.values[0] || "auto";
}

export function imageSizeRequest(profile: ImageCapabilityConfig, value?: string) {
    const parameter = profile.size.parameter;
    if (parameter === "none") return undefined;
    const normalized = normalizeImageSizeSetting(profile, value);
    if (!normalized || normalized === "auto") return undefined;
    return { parameter, value: normalized };
}
