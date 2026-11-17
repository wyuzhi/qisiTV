import { http } from "./request";
import type { GenerationTask } from "./task-center";

export type SmartEraseType = "subtitle" | "watermark" | "privacy";
export type SubtitleEraseMethod = "auto" | "custom";
export type SubtitleEraseModel = "standard" | "area" | "mega";
export type WatermarkEraseModel = "advanced" | "basic";
export type PrivacyProtectModel = "blur" | "mosaic";
export type PrivacyTarget = "face" | "plate";
export type SubtitleEraseFormat = "srt" | "vtt";

export const SMART_ERASE_MODE_SPECS: Record<
    SmartEraseType,
    {
        label: string;
        processingLabel: string;
        operation: string;
        promptForTitle: (title: string) => string;
    }
> = {
    subtitle: {
        label: "去字幕",
        processingLabel: "正在消除视频字幕",
        operation: "media.video.subtitle_erase",
        promptForTitle: (title) => `从「${title}」消除画面字幕`,
    },
    watermark: {
        label: "去水印",
        processingLabel: "正在消除视频水印",
        operation: "media.video.watermark_erase",
        promptForTitle: (title) => `从「${title}」消除画面水印`,
    },
    privacy: {
        label: "隐私打码",
        processingLabel: "正在进行隐私打码",
        operation: "media.video.privacy_protect",
        promptForTitle: (title) => `对「${title}」进行隐私打码`,
    },
};

export const SMART_ERASE_TASK_OPERATIONS: readonly string[] = [
    SMART_ERASE_MODE_SPECS.subtitle.operation,
    SMART_ERASE_MODE_SPECS.watermark.operation,
    SMART_ERASE_MODE_SPECS.privacy.operation,
];

export type SubtitleEraseRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type SubtitleEraseParams = {
    resourceId: string;
    channelId: string;
    eraseType?: SmartEraseType;
    eraseMethod?: SubtitleEraseMethod;
    subtitleModel?: SubtitleEraseModel;
    watermarkModel?: WatermarkEraseModel;
    privacyModel?: PrivacyProtectModel;
    privacyTargets?: PrivacyTarget[];
    region?: SubtitleEraseRegion;
    ocrExtract?: boolean;
    subtitleLang?: string;
    subtitleFormat?: SubtitleEraseFormat;
    translate?: boolean;
    translateDstLang?: string;
    subtitleEmbedId?: number;
    useOriginalPos?: boolean;
    useOriginalSize?: boolean;
};

export type SmartEraseCapabilityMatrix = {
    availableModels?: string[];
    eraseTypes?: SmartEraseType[];
    eraseMethods?: SubtitleEraseMethod[];
    subtitleModels?: SubtitleEraseModel[];
    watermarkModels?: WatermarkEraseModel[];
    privacyModels?: PrivacyProtectModel[];
    privacyTargets?: PrivacyTarget[];
    subtitleLangs?: string[];
    subtitleFormats?: SubtitleEraseFormat[];
    translateDstLangs?: string[];
    ratesCnyPerMinute?: Record<string, Record<string, number>>;
};

export type SubtitleEraseCapabilities = SmartEraseCapabilityMatrix & {
    model: string;
    eraseMethods: SubtitleEraseMethod[];
    subtitleModels: SubtitleEraseModel[];
    maxVideoDurationMs: number;
    cloudProcessing: boolean;
    available: boolean;
    capabilitiesLoaded?: boolean;
    billingMode?: string;
    billingSummary?: string;
    billing?: Record<string, unknown>;
    smartErase?: SmartEraseCapabilityMatrix;
};

const DEFAULT_TRANSLATE_LANGS = [
    "zh", "en", "ja", "ko", "fr", "es", "it", "de",
    "tr", "ru", "pt", "vi", "id", "ms", "th", "ar", "hi",
];

export type SmartEraseControlState = {
    eraseType: SmartEraseType;
    eraseMethod: SubtitleEraseMethod;
    subtitleModel: SubtitleEraseModel;
    watermarkModel: WatermarkEraseModel;
    privacyModel: PrivacyProtectModel;
    privacyTargets: PrivacyTarget[];
    ocrExtract: boolean;
    subtitleLang: string;
    subtitleFormat: SubtitleEraseFormat;
    translate: boolean;
    translateDstLang: string;
    embedAdvancedOpen: boolean;
    subtitleEmbedId: number | null;
    useOriginalPos: boolean;
    useOriginalSize: boolean;
};

export type ResolvedSmartEraseCapabilities = {
    available: boolean;
    availableModels: string[];
    eraseTypes: SmartEraseType[];
    eraseMethods: SubtitleEraseMethod[];
    subtitleModels: SubtitleEraseModel[];
    watermarkModels: WatermarkEraseModel[];
    privacyModels: PrivacyProtectModel[];
    privacyTargets: PrivacyTarget[];
    subtitleLangs: string[];
    subtitleFormats: SubtitleEraseFormat[];
    translateDstLangs: string[];
    isSelectionAvailable: (eraseType: SmartEraseType, subtitleModel: SubtitleEraseModel) => boolean;
    isControlStateAvailable: (state: SmartEraseControlState) => boolean;
};

export function resolveSmartEraseCapabilityOptions(capabilities: SubtitleEraseCapabilities | null): ResolvedSmartEraseCapabilities {
    const nested = capabilities?.smartErase;
    const availableModels = capabilities?.availableModels?.length
        ? capabilities.availableModels
        : nested?.availableModels?.length
          ? nested.availableModels
          : [];
    const hasSubList = Boolean(
        capabilities?.subtitleModels?.length ||
            nested?.subtitleModels?.length ||
            capabilities?.subtitleLangs?.length ||
            nested?.subtitleLangs?.length ||
            capabilities?.subtitleFormats?.length ||
            nested?.subtitleFormats?.length ||
            capabilities?.translateDstLangs?.length ||
            nested?.translateDstLangs?.length,
    );
    const hasWmList = Boolean(capabilities?.watermarkModels?.length || nested?.watermarkModels?.length);
    const hasPrivList = Boolean(
        capabilities?.privacyModels?.length ||
            nested?.privacyModels?.length ||
            capabilities?.privacyTargets?.length ||
            nested?.privacyTargets?.length,
    );
    const inferredPartialTypes: SmartEraseType[] =
        hasSubList || hasWmList || hasPrivList
            ? [
                  ...(hasSubList ? (["subtitle"] as const) : []),
                  ...(hasWmList ? (["watermark"] as const) : []),
                  ...(hasPrivList ? (["privacy"] as const) : []),
              ]
            : capabilities?.model === "video-watermark-erase"
              ? ["watermark"]
              : capabilities?.model === "video-privacy-protect"
                ? ["privacy"]
                : ["subtitle"];

    const rawEraseTypes = capabilities?.eraseTypes?.length
        ? capabilities.eraseTypes
        : nested?.eraseTypes?.length
          ? nested.eraseTypes
          : !capabilities || availableModels.length > 0
            ? (["subtitle", "watermark", "privacy"] as SmartEraseType[])
            : inferredPartialTypes;
    const modelFilteredEraseTypes = availableModels.length
        ? rawEraseTypes.filter((type) => {
              if (type === "watermark") return availableModels.includes("video-watermark-erase");
              if (type === "privacy") return availableModels.includes("video-privacy-protect");
              return availableModels.includes("video-subtitle-erase") || availableModels.includes("video-subtitle-erase-mega");
          })
        : rawEraseTypes;
    const eraseMethods = capabilities?.eraseMethods?.length
        ? capabilities.eraseMethods
        : nested?.eraseMethods?.length
          ? nested.eraseMethods
          : (["auto", "custom"] as SubtitleEraseMethod[]);
    const rawSubtitleModels = capabilities?.subtitleModels?.length
        ? capabilities.subtitleModels
        : nested?.subtitleModels?.length
          ? nested.subtitleModels
          : (["standard", "area", "mega"] as SubtitleEraseModel[]);
    const subtitleModels = rawSubtitleModels.filter((model) => {
        if (model === "mega" && !eraseMethods.includes("auto")) return false;
        if (!availableModels.length) return true;
        return model === "mega"
            ? availableModels.includes("video-subtitle-erase-mega")
            : availableModels.includes("video-subtitle-erase");
    });
    const eraseTypes =
        subtitleModels.length === 0
            ? modelFilteredEraseTypes.filter((type) => type !== "subtitle")
            : modelFilteredEraseTypes;
    const watermarkModels = capabilities?.watermarkModels?.length
        ? capabilities.watermarkModels
        : nested?.watermarkModels?.length
          ? nested.watermarkModels
          : (["advanced", "basic"] as WatermarkEraseModel[]);
    const privacyModels = capabilities?.privacyModels?.length
        ? capabilities.privacyModels
        : nested?.privacyModels?.length
          ? nested.privacyModels
          : (["blur", "mosaic"] as PrivacyProtectModel[]);
    const privacyTargets = capabilities?.privacyTargets?.length
        ? capabilities.privacyTargets
        : nested?.privacyTargets?.length
          ? nested.privacyTargets
          : (["face", "plate"] as PrivacyTarget[]);
    const subtitleLangs = capabilities?.subtitleLangs?.length
        ? capabilities.subtitleLangs
        : nested?.subtitleLangs?.length
          ? nested.subtitleLangs
          : ["zh_en", "multi"];
    const subtitleFormats = capabilities?.subtitleFormats?.length
        ? capabilities.subtitleFormats
        : nested?.subtitleFormats?.length
          ? nested.subtitleFormats
          : (["srt", "vtt"] as SubtitleEraseFormat[]);
    const translateDstLangs = capabilities?.translateDstLangs?.length
        ? capabilities.translateDstLangs
        : nested?.translateDstLangs?.length
          ? nested.translateDstLangs
          : DEFAULT_TRANSLATE_LANGS;

    const baseAvailable = capabilities ? capabilities.available !== false && eraseTypes.length > 0 : true;
    const resolvedEraseTypes: SmartEraseType[] = eraseTypes.length ? eraseTypes : ["subtitle"];
    const resolvedSubtitleModels: SubtitleEraseModel[] = subtitleModels.length ? subtitleModels : ["standard"];

    const isSelectionAvailable = (eraseType: SmartEraseType, subtitleModel: SubtitleEraseModel): boolean => {
        if (!capabilities) return true;
        if (!baseAvailable) return false;
        if (eraseTypes.length === 0 || !eraseTypes.includes(eraseType)) return false;
        if (eraseType === "subtitle" && subtitleModel === "mega" && !eraseMethods.includes("auto")) return false;
        if (eraseType === "subtitle" && (subtitleModels.length === 0 || !subtitleModels.includes(subtitleModel))) return false;
        if (availableModels.length > 0) {
            const targetModel =
                eraseType === "watermark"
                    ? "video-watermark-erase"
                    : eraseType === "privacy"
                      ? "video-privacy-protect"
                      : subtitleModel === "mega"
                        ? "video-subtitle-erase-mega"
                        : "video-subtitle-erase";
            return availableModels.includes(targetModel);
        }
        return true;
    };

    const isControlStateAvailable = (state: SmartEraseControlState): boolean => {
        if (!isSelectionAvailable(state.eraseType, state.subtitleModel)) return false;
        if (!capabilities) return true;
        if (state.eraseType === "watermark") {
            return eraseMethods.includes(state.eraseMethod) && watermarkModels.includes(state.watermarkModel);
        }
        if (state.eraseType === "privacy") {
            return (
                privacyModels.includes(state.privacyModel) &&
                state.privacyTargets.length > 0 &&
                state.privacyTargets.every((item) => privacyTargets.includes(item))
            );
        }
        const effectiveMethod = state.subtitleModel === "mega" ? "auto" : state.eraseMethod;
        if (!eraseMethods.includes(effectiveMethod)) return false;
        if (state.subtitleModel !== "mega" && effectiveMethod === "auto" && (state.ocrExtract || state.translate)) {
            if (!subtitleLangs.includes(state.subtitleLang) || !subtitleFormats.includes(state.subtitleFormat)) return false;
            if (state.translate && !translateDstLangs.includes(state.translateDstLang)) return false;
        }
        return true;
    };

    return {
        available: baseAvailable,
        availableModels,
        eraseTypes: resolvedEraseTypes,
        eraseMethods,
        subtitleModels: resolvedSubtitleModels,
        watermarkModels,
        privacyModels,
        privacyTargets,
        subtitleLangs,
        subtitleFormats,
        translateDstLangs,
        isSelectionAvailable,
        isControlStateAvailable,
    };
}

export function reconcileSmartEraseControlState(
    prev: SmartEraseControlState,
    resolved: ResolvedSmartEraseCapabilities,
): SmartEraseControlState {
    const eraseType = resolved.eraseTypes.includes(prev.eraseType) ? prev.eraseType : resolved.eraseTypes[0];
    const subtitleModel = resolved.subtitleModels.includes(prev.subtitleModel)
        ? prev.subtitleModel
        : resolved.subtitleModels[0];
    const rawEraseMethod = resolved.eraseMethods.includes(prev.eraseMethod)
        ? prev.eraseMethod
        : resolved.eraseMethods[0] || "auto";
    const eraseMethod = eraseType === "subtitle" && subtitleModel === "mega" ? "auto" : rawEraseMethod;
    const watermarkModel = resolved.watermarkModels.includes(prev.watermarkModel)
        ? prev.watermarkModel
        : resolved.watermarkModels[0] || "advanced";
    const privacyModel = resolved.privacyModels.includes(prev.privacyModel)
        ? prev.privacyModel
        : resolved.privacyModels[0] || "blur";
    const filteredTargets = prev.privacyTargets.filter((item) => resolved.privacyTargets.includes(item));
    const privacyTargets = filteredTargets.length > 0 ? filteredTargets : [...resolved.privacyTargets];
    const subtitleLang = resolved.subtitleLangs.includes(prev.subtitleLang)
        ? prev.subtitleLang
        : resolved.subtitleLangs[0] || "zh_en";
    const subtitleFormat = resolved.subtitleFormats.includes(prev.subtitleFormat)
        ? prev.subtitleFormat
        : resolved.subtitleFormats[0] || "srt";
    const translateDstLang = resolved.translateDstLangs.includes(prev.translateDstLang)
        ? prev.translateDstLang
        : resolved.translateDstLangs[0] || "en";
    const allowSubtitleExtras = eraseType !== "subtitle" || (subtitleModel !== "mega" && eraseMethod === "auto");
    const ocrExtract = allowSubtitleExtras ? prev.ocrExtract : false;
    const translate = allowSubtitleExtras ? prev.translate : false;

    const sameTargets =
        privacyTargets.length === prev.privacyTargets.length &&
        privacyTargets.every((item, idx) => item === prev.privacyTargets[idx]);
    if (
        eraseType === prev.eraseType &&
        subtitleModel === prev.subtitleModel &&
        eraseMethod === prev.eraseMethod &&
        watermarkModel === prev.watermarkModel &&
        privacyModel === prev.privacyModel &&
        sameTargets &&
        subtitleLang === prev.subtitleLang &&
        subtitleFormat === prev.subtitleFormat &&
        translateDstLang === prev.translateDstLang &&
        ocrExtract === prev.ocrExtract &&
        translate === prev.translate
    ) {
        return prev;
    }
    return {
        ...prev,
        eraseType,
        subtitleModel,
        eraseMethod,
        watermarkModel,
        privacyModel,
        privacyTargets,
        subtitleLang,
        subtitleFormat,
        translateDstLang,
        ocrExtract,
        translate,
    };
}

export type SubtitleEraseEstimate = {
    mediaType: "video";
    model?: string;
    source: { width: number; height: number; durationMs?: number };
    reservation: number;
    currency: "CNY";
    tier?: string;
    billedSeconds?: number;
    ratePerMinuteCny?: number;
    billingMode?: string;
    billingSummary?: string;
    generationSubmitted: false;
    cloudProcessing: boolean;
};

export const SUBTITLE_ERASE_CAPABILITIES_TIMEOUT_MS = 8_000;
export const SUBTITLE_ERASE_ESTIMATE_TIMEOUT_MS = 60_000;
export const SUBTITLE_ERASE_CREATE_TIMEOUT_MS = 30_000;
export const SUBTITLE_ERASE_RECOVER_TIMEOUT_MS = 60_000;

export const getVideoSubtitleEraseCapabilities = (signal?: AbortSignal) =>
    http.get<SubtitleEraseCapabilities>("/video-subtitle-erase/capabilities", { timeout: SUBTITLE_ERASE_CAPABILITIES_TIMEOUT_MS, signal });

export const estimateVideoSubtitleErase = (params: SubtitleEraseParams, signal?: AbortSignal) =>
    http.post<SubtitleEraseEstimate>("/video-subtitle-erase/estimate", params, { timeout: SUBTITLE_ERASE_ESTIMATE_TIMEOUT_MS, signal }).then((quote) => {
        if (quote.currency !== "CNY" || !Number.isFinite(quote.reservation) || quote.reservation <= 0 || quote.generationSubmitted !== false) {
            throw new Error("视频处理费用未能确认，请重新获取");
        }
        return quote;
    });

export function createVideoSubtitleEraseTask(params: SubtitleEraseParams & { clientOperationId: string; projectId: string; nodeId: string }) {
    return http.post<GenerationTask>("/video-subtitle-erase/tasks", params, { timeout: SUBTITLE_ERASE_CREATE_TIMEOUT_MS }).then((task) => {
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("canvas:task-created", { detail: { task } }));
        }
        return task;
    });
}

export function recoverVideoSubtitleEraseTask(taskId: string) {
    return http.post<GenerationTask>(`/video-subtitle-erase/tasks/${encodeURIComponent(taskId)}/recover`, {}, { timeout: SUBTITLE_ERASE_RECOVER_TIMEOUT_MS }).then((task) => {
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("canvas:task-updated", { detail: { task } }));
        }
        return task;
    });
}
