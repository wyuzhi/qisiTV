import { isVolcengineArkVideoProtocol, type ModelProtocol } from "@/lib/model-protocols";

/** 0 means no documented local character limit; the supplier still validates. */
export const DEFAULT_VIDEO_PROMPT_MAX_CHARS = 0;

export type VideoCapabilityConfig = {
    references: {
        promptMaxChars: number;
        promptMaxUtf16Units?: number;
        minImages: number;
        maxImages: number;
        maxImageBytes: number;
        minImageWidth?: number;
        maxImageWidth?: number;
        minImageHeight?: number;
        maxImageHeight?: number;
        minImageAspect?: number;
        maxImageAspect?: number;
        minImagePixels?: number;
        maxImagePixels?: number;
        maxVideos: number;
        maxVideoBytes: number;
        maxVideoDurationSeconds: number;
        minVideoDurationSeconds?: number;
        maxVideoTotalDurationSeconds?: number;
        minVideoWidth?: number;
        maxVideoWidth?: number;
        minVideoHeight?: number;
        maxVideoHeight?: number;
        minVideoAspect?: number;
        maxVideoAspect?: number;
        minVideoPixels?: number;
        maxVideoPixels?: number;
        maxAudios: number;
        maxAudioBytes: number;
        maxAudioDurationSeconds: number;
        minAudioDurationSeconds?: number;
        maxAudioTotalDurationSeconds?: number;
    };
    duration: {
        continuous?: boolean;
        fractionalMin?: number;
        selection: "range" | "enum";
        min?: number;
        max?: number;
        step?: number;
        values?: number[];
        default: number;
    };
    durationSupported?: boolean;
    taskTypeConstraints?: boolean;
    ratios: string[];
    defaultRatio: string;
    resolutions: string[];
    defaultResolution: string;
    generateAudio: { supported: boolean; default: boolean };
    watermark: { supported: boolean; default: boolean };
    draft?: { supported: boolean; default: boolean };
    returnLastFrame?: { supported: boolean; default: boolean };
    operations: string[];
    defaultOperation: string;
    operationReferences?: Record<string, Partial<Pick<VideoCapabilityConfig["references"], "minImages" | "maxImages" | "maxVideos" | "maxAudios">>>;
};

const catalogIntBounds: Record<string, [number, number]> = {
    promptMaxChars: [0, 1_000_000],
    promptMaxUtf16Units: [0, 1_000_000],
    minImages: [0, 100],
    maxImages: [0, 100],
    maxVideos: [0, 100],
    maxAudios: [0, 100],
    maxVideoDurationSeconds: [0, Number.MAX_SAFE_INTEGER],
    minVideoDurationSeconds: [0, Number.MAX_SAFE_INTEGER],
    maxAudioDurationSeconds: [0, Number.MAX_SAFE_INTEGER],
    maxAudioTotalDurationSeconds: [0, Number.MAX_SAFE_INTEGER],
    maxVideoTotalDurationSeconds: [0, Number.MAX_SAFE_INTEGER],
    minImageWidth: [0, Number.MAX_SAFE_INTEGER],
    maxImageWidth: [0, Number.MAX_SAFE_INTEGER],
    minImageHeight: [0, Number.MAX_SAFE_INTEGER],
    maxImageHeight: [0, Number.MAX_SAFE_INTEGER],
    minVideoWidth: [0, Number.MAX_SAFE_INTEGER],
    maxVideoWidth: [0, Number.MAX_SAFE_INTEGER],
    minVideoHeight: [0, Number.MAX_SAFE_INTEGER],
    maxVideoHeight: [0, Number.MAX_SAFE_INTEGER],
};
const catalogInt64Fields = ["maxImageBytes", "maxVideoBytes", "maxAudioBytes", "minImagePixels", "maxImagePixels", "minVideoPixels", "maxVideoPixels"] as const;
const catalogFloatFields = ["minImageAspect", "maxImageAspect", "minVideoAspect", "maxVideoAspect", "minAudioDurationSeconds"] as const;

function catalogObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function catalogFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function catalogWholeNumber(value: unknown): number | null {
    const number = catalogFiniteNumber(value);
    return number !== null && Number.isInteger(number) ? number : null;
}

function catalogStringValue(value: unknown): string | null {
    return typeof value === "string" ? value.trim() : null;
}

function catalogStringList(value: unknown, allowEmpty: boolean): string[] | null {
    if (!Array.isArray(value)) return null;
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const text = catalogStringValue(item);
        if (text === null) return null;
        if (!text || seen.has(text)) continue;
        seen.add(text);
        result.push(text);
    }
    if (!allowEmpty && !result.length) return null;
    return result;
}

function catalogBooleanConfig(value: unknown): { supported: boolean; default: boolean } | null {
    const child = catalogObject(value);
    if (!child || typeof child.supported !== "boolean" || typeof child.default !== "boolean") return null;
    return { supported: child.supported, default: child.default };
}

function catalogNumbersFinite(value: unknown): boolean {
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(catalogNumbersFinite);
    if (value && typeof value === "object") return Object.values(value).every(catalogNumbersFinite);
    return true;
}

function catalogPresentNumber(object: Record<string, number>, key: string): number | undefined {
    return object[key];
}

function sanitizeCatalogReferences(input: Record<string, unknown>): VideoCapabilityConfig["references"] | null {
    const refs: Record<string, number> = {};
    for (const [key, bounds] of Object.entries(catalogIntBounds)) {
        if (!(key in input)) continue;
        const value = catalogWholeNumber(input[key]);
        if (value === null || value < bounds[0] || value > bounds[1]) return null;
        refs[key] = value;
    }
    for (const key of catalogInt64Fields) {
        if (!(key in input)) continue;
        const value = catalogWholeNumber(input[key]);
        if (value === null || value < 0) return null;
        refs[key] = value;
    }
    for (const key of catalogFloatFields) {
        if (!(key in input)) continue;
        const value = catalogFiniteNumber(input[key]);
        if (value === null || value < 0) return null;
        refs[key] = value;
    }
    const minImages = catalogPresentNumber(refs, "minImages");
    const maxImages = catalogPresentNumber(refs, "maxImages");
    if (minImages !== undefined && maxImages !== undefined && minImages > maxImages) return null;
    const minVideo = catalogPresentNumber(refs, "minVideoDurationSeconds");
    const maxVideo = catalogPresentNumber(refs, "maxVideoDurationSeconds");
    if (minVideo !== undefined && maxVideo !== undefined && maxVideo > 0 && minVideo > maxVideo) return null;
    const minAudio = catalogPresentNumber(refs, "minAudioDurationSeconds");
    const maxAudio = catalogPresentNumber(refs, "maxAudioDurationSeconds");
    if (minAudio !== undefined && maxAudio !== undefined && maxAudio > 0 && minAudio > maxAudio) return null;
    return refs as VideoCapabilityConfig["references"];
}

function sanitizeCatalogDuration(input: Record<string, unknown>): VideoCapabilityConfig["duration"] | null {
    const selection = catalogStringValue(input.selection);
    const defaultValue = catalogWholeNumber(input.default);
    if ((selection !== "range" && selection !== "enum") || defaultValue === null) return null;
    if (selection === "range") {
        if (input.continuous===true) {
            const min=Number(input.min),max=Number(input.max),step=Number(input.step),fractionalMin=Number(input.fractionalMin ?? input.min);
            if (![min,max,step,fractionalMin].every(Number.isFinite) || fractionalMin<.92 || fractionalMin>min || max<min || max>3600 || step<=0 || defaultValue<min || defaultValue>max) return null;
            return {selection,min,max,step,fractionalMin,default:defaultValue,continuous:true};
        }
        const min = catalogWholeNumber(input.min);
        const max = catalogWholeNumber(input.max);
        const step = catalogWholeNumber(input.step);
        if (min === null || max === null || step === null) return null;
        if (min < 1 || max < min || max > 3600 || step < 1 || defaultValue < min || defaultValue > max || (defaultValue - min) % step !== 0) return null;
        return { selection, min, max, step, default: defaultValue };
    }
    if (!Array.isArray(input.values) || !input.values.length || input.values.length > 100) return null;
    const values: number[] = [];
    const seen = new Set<number>();
    for (const raw of input.values) {
        const value = catalogWholeNumber(raw);
        if (value === null || (value < 1 && value !== -1) || value > 3600 || seen.has(value)) return null;
        seen.add(value);
        values.push(value);
    }
    if (!seen.has(defaultValue)) return null;
    return { selection, values, default: defaultValue };
}

export function sanitizeServerVideoCapability(value: unknown): VideoCapabilityConfig | null {
    const object = catalogObject(value);
    if (!object || !catalogNumbersFinite(object)) return null;
    const references = catalogObject(object.references);
    const duration = catalogObject(object.duration);
    const generateAudio = catalogBooleanConfig(object.generateAudio);
    const watermark = catalogBooleanConfig(object.watermark);
    const ratios = catalogStringList(object.ratios, true);
    const resolutions = catalogStringList(object.resolutions, true);
    const operations = catalogStringList(object.operations, false);
    const defaultRatio = catalogStringValue(object.defaultRatio);
    const defaultResolution = catalogStringValue(object.defaultResolution);
    const defaultOperation = catalogStringValue(object.defaultOperation);
    if (!references || !duration || !generateAudio || !watermark || !ratios || !resolutions || !operations || defaultRatio === null || defaultResolution === null || !defaultOperation || !operations.includes(defaultOperation)) return null;
    if (ratios.length ? !defaultRatio || !ratios.includes(defaultRatio) : defaultRatio !== "") return null;
    if (resolutions.length ? !defaultResolution || !resolutions.includes(defaultResolution) : defaultResolution !== "") return null;
    const normalizedDuration = sanitizeCatalogDuration(duration);
    const normalizedRefs = sanitizeCatalogReferences(references);
    if (!normalizedDuration || !normalizedRefs) return null;
    const video: VideoCapabilityConfig = {
        references: normalizedRefs,
        duration: normalizedDuration,
        ratios,
        defaultRatio,
        resolutions,
        defaultResolution,
        generateAudio,
        watermark,
        operations,
        defaultOperation,
    };
    if ("operationReferences" in object) {
        const byOperation = catalogObject(object.operationReferences);
        if (!byOperation) return null;
        video.operationReferences = {};
        for (const [operation, raw] of Object.entries(byOperation)) {
            const limits = catalogObject(raw);
            if (!limits || !operations.includes(operation)) return null;
            const counts: NonNullable<VideoCapabilityConfig["operationReferences"]>[string] = {};
            for (const key of ["minImages", "maxImages", "maxVideos", "maxAudios"] as const) {
                if (!(key in limits)) continue;
                const count = limits[key];
                if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 100) return null;
                counts[key] = count;
            }
            if ((counts.minImages ?? normalizedRefs.minImages ?? 0) > (counts.maxImages ?? normalizedRefs.maxImages ?? 0)) return null;
            video.operationReferences[operation] = counts;
        }
    }
    if ("durationSupported" in object) {
        if (typeof object.durationSupported !== "boolean") return null;
        video.durationSupported = object.durationSupported;
    }
    if ("taskTypeConstraints" in object) {
        if (typeof object.taskTypeConstraints !== "boolean") return null;
        video.taskTypeConstraints = object.taskTypeConstraints;
    }
    if ("draft" in object) {
        const draft = catalogBooleanConfig(object.draft);
        if (!draft) return null;
        video.draft = draft;
        if (draft.supported && !video.operations.includes("draft_to_final")) {
            video.operations.push("draft_to_final");
        }
    }
    if ("returnLastFrame" in object) {
        const returnLastFrame = catalogBooleanConfig(object.returnLastFrame);
        if (!returnLastFrame) return null;
        video.returnLastFrame = returnLastFrame;
    }
    return video;
}

export function videoSupportsTaskTypeConstraints(video?: VideoCapabilityConfig | null): boolean {
    if (!video) return false;
    if (typeof video.taskTypeConstraints === "boolean") return video.taskTypeConstraints;
    return Boolean(video.operations?.includes("inpaint") || video.operations?.includes("extend"));
}

export function versionedVideoCapability(value: unknown, version: string | undefined): VideoCapabilityConfig | null {
    if (!version?.trim()) return null;
    const video = sanitizeServerVideoCapability(value);
    if (!video || ![video.references.maxImages, video.references.maxVideos, video.references.maxAudios].every(Number.isInteger)) return null;
    return video;
}

export function videoReferencesForOperation(profile: VideoCapabilityConfig, operation: string): VideoCapabilityConfig["references"] {
    return { ...profile.references, ...profile.operationReferences?.[operation] };
}

export function defaultVideoCapabilityConfig(protocol?: ModelProtocol, model = ""): VideoCapabilityConfig {
    const video: VideoCapabilityConfig = {
        references: {
            promptMaxChars: DEFAULT_VIDEO_PROMPT_MAX_CHARS,
            minImages: 0,
            maxImages: 9,
            maxImageBytes: 30 * 1024 * 1024,
            maxVideos: 0,
            maxVideoBytes: 0,
            maxVideoDurationSeconds: 0,
            maxAudios: 0,
            maxAudioBytes: 0,
            maxAudioDurationSeconds: 0,
        },
        duration: { selection: "range", min: 1, max: 15, step: 1, default: 6 },
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
        defaultRatio: "16:9",
        resolutions: ["480p", "720p", "1080p", "1440p", "2160p"],
        defaultResolution: "720p",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video"],
        defaultOperation: "text_to_video",
    };
    if (protocol === "full-video") {
        const is25 = model.endsWith("2.5");
        video.references.maxImages = is25 ? 30 : 9;
        video.references.maxVideos = is25 ? 10 : 3;
        video.references.maxAudios = is25 ? 10 : 3;
        video.references.maxVideoBytes = 100_000_000;
        video.references.maxAudioBytes = 100_000_000;
        video.references.minVideoDurationSeconds = 2;
        video.references.minAudioDurationSeconds = 2;
        video.references.maxVideoDurationSeconds = is25 ? 30 : 15;
        video.references.maxAudioDurationSeconds = is25 ? 30 : 15;
        video.duration = { selection: "range", min: 4, max: is25 ? 30 : 15, step: 1, default: 5 };
        video.resolutions = is25 ? ["480p", "720p"] : ["480p", "720p", "1080p"];
        video.defaultResolution = "480p";
        video.operations = ["text_to_video", "image_to_video", "reference_to_video"];
    }
    if (protocol === "volcengine-jimeng-video") {
        video.duration = { selection: "enum", values: [5, 10], default: 5 };
        video.resolutions = ["720p"];
    }
    if (protocol === "gemini-veo") {
        video.duration = { selection: "enum", values: [4, 6, 8], default: 6 };
        video.resolutions = ["720p", "1080p"];
    }
    if (protocol === "volcengine-ark-video" || protocol === "volcengine-ark-agent-plan-video" || protocol === "newapi-channel-1" || protocol === "newapi-channel-2" || protocol === "video-generations-json") {
        video.references.maxVideos = 3;
        video.references.maxAudios = 3;
        video.references.maxVideoBytes = 200 * 1024 * 1024;
        video.references.maxAudioBytes = 15 * 1024 * 1024;
        video.references.maxVideoDurationSeconds = 15;
        video.references.maxAudioDurationSeconds = 15;
        video.generateAudio = { supported: true, default: true };
    }
    if (protocol === "volcengine-ark-video" || protocol === "volcengine-ark-agent-plan-video") {
        video.references.minVideoDurationSeconds = 2;
        video.references.minAudioDurationSeconds = 2;
    }
    if (protocol === "volcengine-ark-video" || protocol === "volcengine-ark-agent-plan-video" || protocol === "newapi-channel-1") video.resolutions = ["480p", "720p", "1080p"];
    if (protocol === "volcengine-ark-video" || protocol === "volcengine-ark-agent-plan-video") {
        video.watermark = { supported: true, default: false };
        video.operations.push("reference_to_video");
        if (/^dreamina-seedance-2-0-(?:fast|mini)(?:-|$)/.test(model.toLowerCase().split("/").pop() || "")) video.resolutions = ["480p", "720p"];
    }
    if (protocol === "newapi-channel-2") {
        if (/^wan3(?:\.0)?(?:-video)?$/i.test(model.trim())) {
            video.references.maxImages = 1;
            video.references.maxVideos = 0;
            video.references.maxAudios = 0;
        } else {
            // APIMart 的 Seedance 2.0 Video Generations 协议支持参考视频/音频，
            // 但不是火山方舟 Agent Plan，因此单独声明全模态参考能力。
            video.operations.push("reference_to_video");
        }
    }
    if (protocol === "video-generations-json") {
        video.duration.default = 5;
        video.resolutions = isSeedance25Model(model) ? ["480p", "720p", "1080p"] : ["720p", "1080p"];
        video.watermark = { supported: true, default: false };
        video.operations.push("reference_to_video");
    }
    if (protocol === "novita-video") {
        video.references.maxImages = 1;
        video.references.maxImageBytes = 10 * 1024 * 1024;
        video.duration = { selection: "enum", values: [5, 10], default: 5 };
        video.ratios = ["16:9", "9:16", "1:1"];
        video.resolutions = ["1080p"];
        video.defaultResolution = "1080p";
    }
    if (protocol === "minimax-video") {
        video.references.maxImages = 9;
        video.references.maxImageBytes = 30 * 1024 * 1024;
        video.references.maxVideos = 3;
        video.references.maxVideoBytes = 50 * 1024 * 1024;
        video.references.maxVideoDurationSeconds = 15;
        video.references.maxAudios = 3;
        video.references.maxAudioBytes = 15 * 1024 * 1024;
        video.references.maxAudioDurationSeconds = 15;
        video.duration = { selection: "enum", values: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], default: 5 };
        video.ratios = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
        video.resolutions = ["768P", "2K"];
        video.defaultResolution = "768P";
        video.watermark = { supported: true, default: false };
        video.operations.push("reference_to_video");
    }
    if (
        protocol === "agnes-video" &&
        ["agnes-video-2.5", "agnes-video-2.5-flash"].includes(
            String(model ?? "")
                .trim()
                .toLowerCase(),
        )
    ) {
        const flash =
            String(model ?? "")
                .trim()
                .toLowerCase() === "agnes-video-2.5-flash";
        video.references.maxImages = flash ? 5 : 9;
        video.references.maxVideos = flash ? 0 : 3;
        video.references.maxAudios = 3;
        video.duration = { selection: "range", min: 4, max: 12, step: 1, default: 5 };
        video.ratios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
        video.defaultRatio = "16:9";
        video.resolutions = flash ? ["720P"] : ["720P", "960P", "2K"];
        video.defaultResolution = "720P";
        video.operations.push("reference_to_video", "audio_to_video");
    }
    if (isSeedance2Family(protocol, model)) {
        if (protocol === "newapi") video.generateAudio = { supported: true, default: true };
        video.returnLastFrame = { supported: true, default: false };
        video.references = overlayOfficialSeedance2References(video.references, isSeedance25Model(model));
        video.operations = Array.from(new Set([...video.operations, "reference_to_video", ...(isSeedance25Model(model) ? (["audio_to_video", "inpaint", "extend"] as const) : [])]));
        if (isSeedance2FastOrMiniModel(model)) {
            const filtered = video.resolutions.filter((value) => ["480p", "720p"].includes(value.trim().toLowerCase()));
            video.resolutions = filtered.length ? filtered : ["480p", "720p"];
            if (!video.resolutions.some((value) => value.trim().toLowerCase() === video.defaultResolution.trim().toLowerCase())) {
                video.defaultResolution = video.resolutions.find((value) => value.trim().toLowerCase() === "720p") || video.resolutions[0] || "720p";
            }
        }
        if (isSeedance25Model(model)) {
            if (!video.ratios.includes("adaptive")) video.ratios = [...video.ratios, "adaptive"];
            if (video.resolutions.some((value) => value.toLowerCase() === "480p")) {
                video.draft = { supported: true, default: false };
                if (!video.operations.includes("draft_to_final")) {
                    video.operations.push("draft_to_final");
                }
            }
        }
        if (isSeedance25Model(model) && video.duration.selection === "range" && (video.duration.max || 0) < 30) {
            video.duration = { ...video.duration, max: 30 };
        }
    }
    if (isVolcengineArkVideoProtocol(protocol) && (/^dreamina-seedance-2[.-](?:0|5)(?:-|$)/.test(model.trim().toLowerCase().split("/").pop() || "") || isSeedance25Model(model))) {
        video.duration = { ...video.duration, selection: "enum", min: 4, values: [-1, ...Array.from({ length: (video.duration.max || 15) - 3 }, (_, index) => index + 4)] };
        if (!video.ratios.includes("adaptive")) video.ratios = [...video.ratios, "adaptive"];
        if (isSeedance25Model(model)) video.operations = Array.from(new Set([...video.operations, "inpaint", "extend"]));
    }
    return video;
}

// 官方文档写的下限只收紧、不放宽，所以旧安装里存下来的 1 秒输出、1.8 秒音频也会被改到文档值；
// 管理员已经配得更严的数值保持不变。
export function alignDocumentedVideoRouteLimits(video: VideoCapabilityConfig | undefined, protocol: ModelProtocol | undefined, modelName: string, channel?: { id?: string; baseUrl?: string }) {
    if (!video) return;
    if (
        protocol === "newapi-channel-2" &&
        /^wan3(?:\.0)?(?:-video)?$/i.test(modelName.trim()) &&
        video.operations.includes("reference_to_video") &&
        video.references.maxImages === 9 &&
        video.references.maxVideos === 3 &&
        video.references.maxAudios === 3
    ) {
        video.operations = video.operations.filter((item) => item !== "reference_to_video");
        if (!video.operations.includes(video.defaultOperation)) video.defaultOperation = video.operations[0] || "text_to_video";
        video.references.maxImages = 1;
        video.references.maxVideos = 0;
        video.references.maxAudios = 0;
        return;
    }
    if (!isSeedance2Family(protocol, modelName)) return;
    let host = "";
    try { host = new URL(channel?.baseUrl || "").hostname.toLowerCase(); } catch { /* no public URL */ }
    const materialHost = ["beeftv.app", "whatstoken.ai", "www.whatstoken.ai"].includes(host) || channel?.id === "beeftv";
    if ((isVolcengineArkVideoProtocol(protocol) || materialHost) && video.references.minVideoPixels === 409600 && video.references.maxVideoPixels === 8295044) video.references.minVideoPixels = 407696;
    // 输出时长下限官方 4 秒：区间、连续（fractionalMin）和枚举三种配置都要收紧，枚举里的 -1（自动）保留。
    video.duration = tightenDocumentedOutputDuration(video.duration);
    if ((video.references.minAudioDurationSeconds || 0) < 2) video.references.minAudioDurationSeconds = 2;
}

export function isSeedance2Family(protocol: ModelProtocol | undefined, modelName: string) {
    return Boolean((!protocol || ["openai", "openai-videos", "newapi", "newapi-channel-1", "newapi-channel-2", "video-generations-json", "seedance-videos-compatible", "full-video", "volcengine-ark-video", "volcengine-ark-agent-plan-video"].includes(protocol)) && String(modelName).toLowerCase().includes("seedance-2"));
}

export function isSeedance25Model(modelName: string) {
    const base = String(modelName).trim().toLowerCase().split("/").pop() || "";
    return /^seedance-2\.5(?:-|$)/.test(base) || /^(?:doubao|dreamina)-seedance-2[.-]5(?:-|$)/.test(base);
}

export function isSeedance2FastOrMiniModel(modelName: string) {
    const base = String(modelName).trim().toLowerCase().split("/").pop() || "";
    return /^(?:(?:doubao|dreamina)-)?seedance-2[.-]0-(?:fast|mini)(?:-|$)/.test(base);
}

// 输出时长下限官方 4 秒：区间、连续（fractionalMin）和枚举三种已保存配置都要收紧，
// 枚举里的 -1（自动）保留，管理员配得更严的数值（比如枚举只剩 [5,10]）不受影响。
export function tightenDocumentedOutputDuration(duration: VideoCapabilityConfig["duration"]): VideoCapabilityConfig["duration"] {
    const minimum = 4;
    if (duration.selection === "enum") {
        const values = (duration.values || []).filter((value) => value === -1 || value >= minimum);
        // 过滤后没有合法时长时保留空列表：这份配置没有可提交的时长，提交校验会拒绝，
        // 而不是退回原来的低于 4 秒的值。
        const kept = values.length ? (values.includes(duration.default) ? duration.default : values.find((value) => value !== -1) ?? values[0]) : duration.default;
        return { ...duration, values, default: kept };
    }
    const min = Math.max(minimum, duration.min || 0);
    const fractionalMin = duration.continuous && duration.fractionalMin && duration.fractionalMin < minimum ? minimum : duration.fractionalMin;
    const fallback = Math.max(minimum, duration.default);
    if (min === duration.min && fractionalMin === duration.fractionalMin && fallback === duration.default) return duration;
    return { ...duration, min, ...(duration.continuous ? { fractionalMin } : {}), default: fallback };
}

function overlayOfficialSeedance2References(base: VideoCapabilityConfig["references"], is25: boolean): VideoCapabilityConfig["references"] {
    return {
        ...base,
        maxImages: is25 ? 30 : 9,
        maxVideos: is25 ? 10 : 3,
        maxVideoBytes: 200 * 1024 * 1024,
        maxVideoDurationSeconds: is25 ? 30 : 15,
        minVideoDurationSeconds: 2,
        maxVideoTotalDurationSeconds: is25 ? 30 : 15,
        maxAudios: is25 ? 10 : 3,
        maxAudioBytes: 15 * 1024 * 1024,
        maxAudioDurationSeconds: is25 ? 30 : 15,
        minAudioDurationSeconds: 2,
        maxAudioTotalDurationSeconds: is25 ? 30 : 15,
        maxImageBytes: base.maxImageBytes || 30 * 1024 * 1024,
        minImageWidth: 300,
        maxImageWidth: 6000,
        minImageHeight: 300,
        maxImageHeight: 6000,
        minImageAspect: 0.4,
        maxImageAspect: 2.5,
        minVideoWidth: 300,
        maxVideoWidth: 6000,
        minVideoHeight: 300,
        maxVideoHeight: 6000,
        minVideoAspect: 0.4,
        maxVideoAspect: 2.5,
        minVideoPixels: 409600,
        maxVideoPixels: 8295044,
    };
}

export function normalizeVideoValue(profile: VideoCapabilityConfig, value: { seconds?: string; ratio?: string; resolution?: string }) {
    const duration = profile.duration.selection === "enum" ? ((profile.duration.values || []).includes(Number(value.seconds)) ? Number(value.seconds) : profile.duration.default) : normalizeRangeDuration(profile, Number(value.seconds));
    const ratio = resolveVideoRatioValue(profile, value.ratio);
    // 前端状态历史上保存过 `720`，而能力配置和供应商通常使用 `720p`；统一按能力中的原始值返回，避免被误判为不支持。
    const resolution = resolveVideoResolutionValue(profile, value.resolution, value.ratio);
    return { seconds: String(duration), ratio, resolution };
}

export function resolveVideoRatioValue(profile: VideoCapabilityConfig, value: string | undefined) {
    return profile.ratios.includes(value || "") ? value! : profile.defaultRatio || profile.ratios[0] || "";
}

export function resolveVideoResolutionValue(profile: VideoCapabilityConfig, value: string | undefined, ratio?: string) {
    return videoResolutionRequest(profile, value, ratio) || profile.defaultResolution || profile.resolutions[0] || "";
}

export function videoResolutionRequest(profile: VideoCapabilityConfig, value: string | undefined, ratio?: string) {
    const requested = String(value || "")
        .trim()
        .toLowerCase();
    const supported = new Map(profile.resolutions.map((resolution) => [resolution.trim().toLowerCase(), resolution.trim()]));
    if (requested && requested !== "auto" && requested !== "default" && requested !== "medium" && requested !== "high") {
        const candidates = [requested];
        if (/^\d+$/.test(requested)) candidates.push(`${requested}p`);
        if (requested === "low") candidates.push("480p");
        if (requested === "2k") candidates.push("1440p");
        if (requested === "1440" || requested === "1440p") candidates.push("2k");
        if (requested === "4k") candidates.push("2160p");
        if (requested === "2160" || requested === "2160p") candidates.push("4k");
        for (const candidate of candidates) {
            const match = supported.get(candidate);
            if (match) return match;
        }
    }
    if (!profile.ratios.length) {
        const rawRatio = String(ratio || "").trim();
        const tierMap: Record<string, string[]> = {
            "480": ["480p"], "480p": ["480p"], low: ["480p"],
            "720": ["720p", "768p", "736p"], "720p": ["720p", "768p", "736p"], medium: ["720p", "768p", "736p"],
            "736": ["736p", "768p", "720p"], "736p": ["736p", "768p", "720p"],
            "768": ["768p", "736p", "720p"], "768p": ["768p", "736p", "720p"],
            "1080": ["1080p", "768p", "736p"], "1080p": ["1080p", "768p", "736p"], high: ["1080p", "768p", "736p"],
            "1440": ["1080p", "768p", "736p"], "1440p": ["1080p", "768p", "736p"], "2k": ["1080p", "768p", "736p"],
            "2160": ["1080p", "768p", "736p"], "2160p": ["1080p", "768p", "736p"], "4k": ["1080p", "768p", "736p"],
        };
        const defaultTierMatch = profile.defaultResolution.trim().toLowerCase().match(/^(\d+p)/);
        const defaultTiers = defaultTierMatch ? (tierMap[defaultTierMatch[1]] || [defaultTierMatch[1]]) : ["768p", "736p", "1080p", "480p"];
        const tiers = tierMap[requested] || (rawRatio ? defaultTiers : undefined);
        if (tiers) {
            const defaultDir = profile.defaultResolution.endsWith("横") ? "横" : profile.defaultResolution.endsWith("(1:1)") ? "(1:1)" : "竖";
            const primaryDir = rawRatio === "16:9" || rawRatio === "4:3" || rawRatio === "21:9" || rawRatio === "3:2" ? "横" : rawRatio === "1:1" ? "(1:1)" : rawRatio ? "竖" : defaultDir;
            const dirs = [primaryDir, ...["竖", "横", "(1:1)"].filter((dir) => dir !== primaryDir)];
            for (const tier of [...tiers, ...defaultTiers, "768p", "736p", "1080p", "480p"]) {
                for (const dir of dirs) {
                    const match = supported.get(`${tier}${dir}`);
                    if (match) return match;
                }
            }
        }
    }
    return undefined;
}

function normalizeRangeDuration(profile: VideoCapabilityConfig, value: number) {
    const min = profile.duration.continuous ? profile.duration.fractionalMin || profile.duration.min || .92 : profile.duration.min || 1;
    const max = profile.duration.max || min;
    const step = profile.duration.step || 1;
    const candidate = Number.isFinite(value) ? (profile.duration.continuous ? value : Math.floor(value)) : profile.duration.default;
    const clamped = Math.min(max, Math.max(min, candidate));
    if (profile.duration.continuous) return clamped;
    const maxStep = Math.max(0, Math.floor((max - min) / step));
    return min + Math.min(maxStep, Math.max(0, Math.round((clamped - min) / step))) * step;
}

// 把模型支持的输出时长写成能照着改的说法：「4–15 秒」「5、10 秒」「自动 或 4–15 秒」。
export function videoDurationRequirement(duration: VideoCapabilityConfig["duration"]): string {
    if (duration.selection === "enum") {
        const manual = (duration.values || []).filter((value) => value !== -1).map((value) => String(value));
        const parts: string[] = [];
        if ((duration.values || []).includes(-1)) parts.push("自动");
        if (manual.length) parts.push(`${manual.join("、")} 秒`);
        return parts.length ? parts.join(" 或 ") : "";
    }
    const min = duration.continuous ? duration.fractionalMin ?? duration.min ?? 1 : duration.min || 1;
    const max = duration.max || min;
    return `${min}–${max} 秒`;
}

export function videoDurationOptions(profile: VideoCapabilityConfig) {
    if (profile.duration.selection === "enum") return profile.duration.values || [];
    if (profile.duration.continuous) return [profile.duration.fractionalMin || profile.duration.min || .92, ...Array.from({ length: Math.max(1, Math.floor(profile.duration.max || 15)) }, (_, i) => i + 1)];
    const min = profile.duration.min || 1;
    const max = profile.duration.max || min;
    const step = profile.duration.step || 1;
    return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, index) => min + index * step);
}

export function videoDurationAllowed(profile: VideoCapabilityConfig, value: number) {
    if (profile.durationSupported === false) return true;
    if (value === -1) return (profile.duration.values || []).includes(-1);
    if (profile.duration.selection === "enum") return (profile.duration.values || []).includes(value);
    const min = profile.duration.continuous ? profile.duration.fractionalMin || profile.duration.min || .92 : profile.duration.min || 1;
    const max = profile.duration.max || min;
    const step = profile.duration.step || 1;
    return Number.isFinite(value) && value >= min && value <= max && (profile.duration.continuous || Math.abs((value-min)/step-Math.round((value-min)/step))<1e-7);
}
