import { http } from "./request";
import type { GenerationTask } from "./task-center";

export type SubtitleEraseMethod = "auto" | "custom";
export type SubtitleEraseModel = "standard" | "area";

export type SubtitleEraseRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type SubtitleEraseParams = {
    resourceId: string;
    channelId: string;
    eraseMethod: SubtitleEraseMethod;
    subtitleModel: SubtitleEraseModel;
    region?: SubtitleEraseRegion;
};

export type SubtitleEraseCapabilities = {
    model: string;
    eraseMethods: SubtitleEraseMethod[];
    subtitleModels: SubtitleEraseModel[];
    maxVideoDurationMs: number;
    cloudProcessing: boolean;
    available: boolean;
    billingMode?: string;
    billingSummary?: string;
    billing?: Record<string, unknown>;
};

export type SubtitleEraseEstimate = {
    mediaType: "video";
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
            throw new Error("去字幕费用未能确认，请重新获取");
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
