import { ApiError } from "@/services/api/request";
import {
    extractResourceVideoFrames,
    ownedResourceIdFromMediaRef,
    resourceFileUrl,
    resourceStorageKey,
    separateResourceVideoAudio,
    type ExtractedVideoFrameFailure,
    type ExtractResourceVideoFramesRequest,
    type RemoteResource,
} from "@/services/api/resources";
import { canvasNodeDiagnosticContext } from "@/services/diagnostics/canvas-media-diagnostics";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import type { UploadedFile } from "@/services/file-storage";
import type { UploadedImage } from "@/services/image-storage";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import type { CanvasNodeData } from "@/types/canvas";

export type BackendDerivedVideoFrames = {
    frames: Array<{ timeMs: number; image: UploadedImage }>;
    failures?: ExtractedVideoFrameFailure[];
    durationMs?: number;
};

export type BackendDerivedSeparatedAudio = {
    audio: UploadedFile;
    mutedVideo: UploadedFile;
    durationMs?: number;
};

export type VideoDeriveCallOptions = {
    idempotencyKey?: string;
    signal?: AbortSignal;
    canvasId?: string;
};

export function canDeriveNodeViaBackend(node: CanvasNodeData): boolean {
    if (usesBrowserLocalResourceStore()) return false;
    return Boolean(ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content));
}

export function shouldFallbackToBrowserMediaTools(error: unknown): boolean {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    if (error instanceof ApiError) {
        if (
            error.reason === "unavailable"
            || error.status === 503
            || error.status === 404
            || error.status === 405
            || error.status === 501
        ) {
            return true;
        }
        return error.status === undefined;
    }
    return false;
}

function recordBackendFallbackDiagnostic(node: CanvasNodeData, operation: "frames" | "separate-audio", error: unknown, canvasId?: string) {
    const reason = error instanceof ApiError
        ? `${error.status ?? "network"}:${error.reason || error.message}`
        : error instanceof Error
            ? error.message
            : "unavailable";
    recordDiagnosticEvent({
        ...canvasNodeDiagnosticContext(node),
        canvasId,
        category: "action",
        level: "warning",
        code: "canvas_video_derive_backend_fallback",
        message: `后端原生媒体处理不可用（${operation}: ${reason}），已切换至浏览器端回退`,
    });
}

function remoteResourceToUploadedImage(resource: RemoteResource): UploadedImage {
    return {
        url: resource.publicUrl || resourceFileUrl(resource.id),
        storageKey: resourceStorageKey(resource.id),
        width: resource.width || 1024,
        height: resource.height || 1024,
        bytes: resource.size || 0,
        mimeType: resource.mimeType || "image/png",
    };
}

function remoteResourceToUploadedFile(resource: RemoteResource, fallbackDurationMs?: number, hasAudio?: boolean): UploadedFile {
    return {
        url: resource.publicUrl || resourceFileUrl(resource.id),
        storageKey: resourceStorageKey(resource.id),
        bytes: resource.size || 0,
        mimeType: resource.mimeType || "application/octet-stream",
        width: resource.width,
        height: resource.height,
        durationMs: resource.durationMs || fallbackDurationMs,
        hasAudio,
    };
}

export async function deriveNodeVideoFramesViaBackend(
    node: CanvasNodeData,
    request: ExtractResourceVideoFramesRequest,
    options?: VideoDeriveCallOptions,
): Promise<BackendDerivedVideoFrames | null> {
    if (!canDeriveNodeViaBackend(node)) return null;
    const resourceId = ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content);
    if (!resourceId) return null;
    try {
        const response = await extractResourceVideoFrames(resourceId, request, options);
        if (!response.frames?.length) return null;
        return {
            frames: response.frames.map((item) => ({
                timeMs: item.timeMs,
                image: remoteResourceToUploadedImage(item.resource),
            })),
            failures: response.failures,
            durationMs: response.durationMs,
        };
    } catch (error) {
        if (shouldFallbackToBrowserMediaTools(error)) {
            recordBackendFallbackDiagnostic(node, "frames", error, options?.canvasId);
            return null;
        }
        throw error;
    }
}

export async function deriveNodeSeparatedAudioViaBackend(
    node: CanvasNodeData,
    options?: VideoDeriveCallOptions,
): Promise<BackendDerivedSeparatedAudio | null> {
    if (!canDeriveNodeViaBackend(node)) return null;
    const resourceId = ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content);
    if (!resourceId) return null;
    try {
        const response = await separateResourceVideoAudio(resourceId, options);
        const durationMs = response.durationMs || response.mutedVideo.durationMs || response.audio.durationMs || node.metadata?.durationMs;
        return {
            audio: remoteResourceToUploadedFile(response.audio, durationMs, true),
            mutedVideo: remoteResourceToUploadedFile(response.mutedVideo, durationMs, false),
            durationMs,
        };
    } catch (error) {
        if (shouldFallbackToBrowserMediaTools(error)) {
            recordBackendFallbackDiagnostic(node, "separate-audio", error, options?.canvasId);
            return null;
        }
        throw error;
    }
}
