import { http } from "./request";
import type { GenerationTask } from "./task-center";

export type UpscaleModelOption = { id: string; label: string; billingMode?: string; billingSummary?: string };
export type UpscaleMode = "precision" | "generative" | "transparent" | "likeai";
export type UpscaleParams = { resourceId: string; channelId: string; mode: UpscaleMode; model: string; scale: number; outputFormat?: string; enhancementStrength?: "low" | "medium" | "high"; modelQuality?: "MQ" | "HQ" | "LQ"; resolution?: "1080p" | "1440p" | "2160p"; acceptProviderBilling?: boolean };
export type UpscaleCapability = { mediaType: "image" | "video"; mode: UpscaleMode; models: string[]; modelOptions?: UpscaleModelOption[]; scales: number[]; outputFormats: string[]; fixedScale?: number; provider?: "topaz" | "likeai" };
export type UpscaleCapabilities = { modes: UpscaleCapability[]; cloudProcessing: boolean; maxVideoDurationMs: number };
export type UpscaleEstimate = { mediaType: "image" | "video"; source: { width: number; height: number; durationMs?: number }; output: { width: number; height: number; durationMs?: number }; reservation: number; currency: "CNY"; billingMode?: string; generationSubmitted: false; cloudProcessing: boolean; priceKnown?: boolean; outputDimensionsKnown?: boolean; provider?: "likeai" | "topaz" };
export const UPSCALE_CAPABILITIES_TIMEOUT_MS = 8_000;
export const UPSCALE_ESTIMATE_TIMEOUT_MS = 120_000;
export const UPSCALE_CREATE_TIMEOUT_MS = 30_000;
export const UPSCALE_RECOVER_TIMEOUT_MS = 60_000;

export const getUpscaleCapabilities = (signal?: AbortSignal) => http.get<UpscaleCapabilities>("/media-upscale/capabilities", { timeout: UPSCALE_CAPABILITIES_TIMEOUT_MS, signal });
export const estimateUpscale = (params: UpscaleParams) => http.post<UpscaleEstimate>("/media-upscale/estimate", params, { timeout: UPSCALE_ESTIMATE_TIMEOUT_MS }).then(quote => {
    if (params.mode === "likeai" && quote.provider === "likeai" && quote.priceKnown === false && quote.reservation === 0 && quote.generationSubmitted === false) return quote;
    if (quote.currency !== "CNY" || !Number.isFinite(quote.reservation) || quote.reservation <= 0 || quote.generationSubmitted !== false) throw new Error("超分费用未能确认，请重新获取");
    return quote;
});
export function createUpscaleTask(params: UpscaleParams & { clientOperationId: string; projectId: string; nodeId: string }) {
    return http.post<GenerationTask>("/media-upscale/tasks", params, { timeout: UPSCALE_CREATE_TIMEOUT_MS }).then(task => {
        window.dispatchEvent(new CustomEvent("canvas:task-created", { detail: { task } }));
        return task;
    });
}
export function recoverUpscaleTask(taskId: string) {
    return http.post<GenerationTask>(`/media-upscale/tasks/${encodeURIComponent(taskId)}/recover`, {}, { timeout: UPSCALE_RECOVER_TIMEOUT_MS }).then(task => {
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("canvas:task-updated", { detail: { task } }));
        return task;
    });
}
export function validUpscaleScale(scale: number, fixedScale?: number) {
    return Number.isInteger(scale) && scale >= 1 && scale <= 4 && (!fixedScale || scale === fixedScale);
}
export function availableUpscaleModesForMedia(capabilities: UpscaleCapabilities | undefined, mediaType: "image" | "video") {
    return capabilities?.modes.filter(item => item.mediaType === mediaType && item.mode !== "transparent") || [];
}
export function resolveUpscaleCapabilityModel(capabilities: UpscaleCapabilities | undefined, mediaType: "image" | "video", mode: UpscaleMode, desired: string) {
    const capability = availableUpscaleModesForMedia(capabilities, mediaType).find(item => item.mode === mode);
    if (!capability) return undefined;
    const options = capability.modelOptions?.length
        ? capability.modelOptions
        : capability.models.map(item => ({ id: item, label: item }));
    const matched = options.find(opt => opt.id === desired || opt.label === desired);
    return matched ? matched.id : options[0]?.id || capability.models[0];
}
export function isUpscaleMediaSelectionAvailable(capabilities: UpscaleCapabilities | undefined, mediaType: "image" | "video", selected: { mode: UpscaleMode; model: string }) {
    return Boolean(resolveUpscaleCapabilityModel(capabilities, mediaType, selected.mode, selected.model));
}
export function normalizeUpscaleMediaSelection<T extends { mode: UpscaleMode; model: string; outputFormat?: string }>(capabilities: UpscaleCapabilities | undefined, mediaType: "image" | "video", selected: T): T {
    if (!capabilities) return selected;
    const currentModel = resolveUpscaleCapabilityModel(capabilities, mediaType, selected.mode, selected.model);
    if (currentModel) return currentModel === selected.model ? selected : { ...selected, model: currentModel };
    const fallback = availableUpscaleModesForMedia(capabilities, mediaType).find(item => Boolean(resolveUpscaleCapabilityModel(capabilities, mediaType, item.mode, "")));
    if (!fallback) return selected;
    const firstModel = resolveUpscaleCapabilityModel(capabilities, mediaType, fallback.mode, "") || "";
    return {
        ...selected,
        mode: fallback.mode,
        model: firstModel,
        ...(mediaType === "image" && fallback.outputFormats.length ? { outputFormat: selected.outputFormat && fallback.outputFormats.includes(selected.outputFormat) ? selected.outputFormat : fallback.outputFormats[0] } : {}),
    };
}
