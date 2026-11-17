import {
    clearReplacedGenerationTaskMetadata,
    GENERATION_ERROR_METADATA_KEYS,
    hasSettledFileUploadMedia,
    hasStaleSettledFileUploadFlag,
    INTERRUPTED_FILE_UPLOAD_MESSAGE,
    interruptFileUpload,
    isFileUploadInProgress,
    isFileUploadOverlayActive,
    isNonEmptyMediaRef,
    stripStaleFileUploadMetadata,
    UPLOAD_REPLACEMENT_RESET_KEYS,
} from "@/lib/canvas/canvas-node-metadata-contract";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { isCanvasMediaNode, mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "@/types/canvas";

export {
    clearReplacedGenerationTaskMetadata,
    hasSettledFileUploadMedia,
    hasStaleSettledFileUploadFlag,
    INTERRUPTED_FILE_UPLOAD_MESSAGE,
    interruptFileUpload,
    isFileUploadInProgress,
    isFileUploadOverlayActive,
    stripStaleFileUploadMetadata,
};

export const CANVAS_UPLOAD_ACCEPT = "image/*,video/*,.mp4,.mov,.m4v,.mkv,.webm,.avi,audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,text/plain,text/markdown,.txt,.md,.markdown,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export function isTextUploadFile(file: Pick<File, "name" | "type">) {
    return /\.(txt|md|markdown)$/i.test(file.name) || file.type === "text/plain" || file.type === "text/markdown";
}
export function uploadNodeType(file: Pick<File, "name" | "type">) {
    if (file.type.startsWith("image/")) return CanvasNodeType.Image;
    if (file.type.startsWith("video/") || /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file.name)) return CanvasNodeType.Video;
    if (file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(file.name)) return CanvasNodeType.Audio;
    if (isTextUploadFile(file)) return CanvasNodeType.Text;
    return null;
}
export function uploadPercent(loaded: number, total: number): number | undefined {
    if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return undefined;
    return Math.round(Math.min(1, Math.max(0, loaded / total)) * 100);
}
export function uploadVeilOpacity(percent = 0) {
    return 1 - Math.min(100, Math.max(0, percent)) / 100 * 0.9;
}

export function createFileUploadAttemptId(): string {
    return `upload-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createFileUploadPlaceholder(
    id: string,
    file: File,
    position: Position,
    attemptId = createFileUploadAttemptId(),
) {
    const type = uploadNodeType(file);
    if (!type) throw new Error("请选择图片、视频、音频或 TXT / Markdown 文件");
    if (type === CanvasNodeType.Image) {
        return createImageUploadPlaceholder(id, file, position, await readUploadImageSize(file), attemptId);
    }
    // 浏览器能否解码不决定能否导入；尺寸与封面由上传后的媒体信息补齐。
    const size = NODE_DEFAULT_SIZE[type];
    return {
        ...size, id, type, title: file.name,
        position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
        metadata: { fileUpload: "uploading", fileUploadAttemptId: attemptId, bytes: file.size, mimeType: file.type },
    } satisfies CanvasNodeData;
}

// 不使用 readImageMeta 的默认尺寸兜底：上传占位必须来自实际解码尺寸。
export async function readUploadImageSize(file: File): Promise<{ width: number; height: number }> {
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
        image.src = url;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("无法读取图片尺寸，请重新选择图片");
        return { width: image.naturalWidth, height: image.naturalHeight };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function createImageUploadPlaceholder(
    id: string,
    file: Pick<File, "name" | "size" | "type">,
    position: Position,
    naturalSize: { width: number; height: number },
    attemptId = createFileUploadAttemptId(),
): CanvasNodeData {
    const size = fitNodeSize(naturalSize.width, naturalSize.height);
    return {
        id, type: CanvasNodeType.Image, title: file.name,
        position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
        ...size,
        metadata: {
            fileUpload: "uploading",
            fileUploadAttemptId: attemptId,
            naturalWidth: naturalSize.width,
            naturalHeight: naturalSize.height,
            bytes: file.size,
            mimeType: file.type,
        },
    };
}

export function buildSettledUploadNodeMetadata(
    currentMetadata: CanvasNodeMetadata | undefined,
    uploadedMetadata: CanvasNodeMetadata | undefined,
    options?: { replace?: boolean; preserveFreeResize?: boolean; attemptId?: string },
): CanvasNodeMetadata {
    const next: Record<string, unknown> = {
        ...((currentMetadata || {}) as Record<string, unknown>),
        ...((uploadedMetadata || {}) as Record<string, unknown>),
    };
    if (options?.attemptId) {
        next.fileUploadAttemptId = options.attemptId;
    }
    delete next.fileUpload;
    delete next.fileUploadProgress;
    for (const key of GENERATION_ERROR_METADATA_KEYS) {
        delete next[key];
    }
    if (options?.replace) {
        delete next.assetId;
        for (const key of UPLOAD_REPLACEMENT_RESET_KEYS) {
            delete next[key];
        }
        next.imageHistoryResetAt = (currentMetadata?.imageHistoryResetAt && typeof currentMetadata.imageHistoryResetAt === "string")
            ? currentMetadata.imageHistoryResetAt
            : new Date().toISOString();
        next.freeResize = Boolean(options.preserveFreeResize);
    }
    for (const key of Object.keys(next)) {
        if (next[key] === undefined) delete next[key];
    }
    return next as CanvasNodeMetadata;
}

export function applyInitialReplacementUploadPlaceholder(
    nodes: CanvasNodeData[],
    nodeId: string,
    attemptId: string,
): CanvasNodeData[] {
    return nodes.map((item) => {
        if (item.id !== nodeId) return item;
        const baseMeta: CanvasNodeMetadata = {
            ...clearReplacedGenerationTaskMetadata(item.metadata),
            imageHistoryResetAt: new Date().toISOString(),
            fileUpload: "uploading",
            fileUploadAttemptId: attemptId,
            fileUploadProgress: undefined,
            status: undefined,
            size: undefined,
            manualSize: undefined,
            freeResize: undefined,
        };
        return {
            ...item,
            metadata: isCanvasMediaNode(item)
                ? mediaResultMetadata("upload", baseMeta)
                : { ...baseMeta, resultOrigin: "upload" },
        };
    });
}

export function applyDecodedUploadPlaceholder(
    nodes: CanvasNodeData[],
    placeholder: CanvasNodeData,
    attemptId: string,
    replaceId?: string,
): CanvasNodeData[] {
    const placeholderMetaWithAttempt: CanvasNodeMetadata = {
        ...placeholder.metadata,
        fileUploadAttemptId: attemptId,
    };
    const uploadPlaceholder = isCanvasMediaNode(placeholder)
        ? { ...placeholder, metadata: mediaResultMetadata("upload", placeholderMetaWithAttempt) }
        : { ...placeholder, metadata: { ...placeholderMetaWithAttempt, resultOrigin: "upload" as const } };
    if (!replaceId) {
        return [...nodes, uploadPlaceholder];
    }
    return nodes.map((item) => {
        if (item.id !== placeholder.id) return item;
        const keepManualResize = Boolean(item.metadata?.manualSize || item.metadata?.freeResize);
        const nextMeta: CanvasNodeMetadata = {
            ...clearReplacedGenerationTaskMetadata(item.metadata),
            fileUpload: "uploading",
            fileUploadAttemptId: attemptId,
            fileUploadProgress: undefined,
            status: undefined,
            size: undefined,
            ...(keepManualResize ? {} : { manualSize: undefined, freeResize: undefined }),
        };
        return {
            ...item,
            width: keepManualResize ? item.width : uploadPlaceholder.width,
            height: keepManualResize ? item.height : uploadPlaceholder.height,
            metadata: isCanvasMediaNode(item)
                ? mediaResultMetadata("upload", nextMeta)
                : { ...nextMeta, resultOrigin: "upload" },
        };
    });
}

export function buildSettledUploadedCanvasNode(
    currentNode: CanvasNodeData,
    placeholder: Pick<CanvasNodeData, "type" | "title">,
    uploadedMetadata: CanvasNodeMetadata | undefined,
    options: { replace: boolean; attemptId: string },
): CanvasNodeData {
    const videoSize = placeholder.type === CanvasNodeType.Video
        && uploadedMetadata?.naturalWidth
        && uploadedMetadata?.naturalHeight
        ? fitNodeSize(uploadedMetadata.naturalWidth, uploadedMetadata.naturalHeight)
        : null;
    const settledMetadata = buildSettledUploadNodeMetadata(currentNode.metadata, uploadedMetadata, {
        replace: options.replace,
        preserveFreeResize: Boolean(currentNode.metadata?.freeResize),
        attemptId: options.attemptId,
    });
    return {
        ...currentNode,
        type: placeholder.type,
        title: placeholder.type === CanvasNodeType.Text && placeholder.title ? placeholder.title : currentNode.title,
        ...(videoSize
            ? {
                ...videoSize,
                position: {
                    x: currentNode.position.x + (currentNode.width - videoSize.width) / 2,
                    y: currentNode.position.y + (currentNode.height - videoSize.height) / 2,
                },
            }
            : {}),
        metadata: placeholder.type === CanvasNodeType.Text
            ? { ...settledMetadata, resultOrigin: "upload" }
            : mediaResultMetadata("upload", settledMetadata),
    };
}

export function restoreFailedUploadNode(
    item: CanvasNodeData,
    original: CanvasNodeData | undefined,
    errorDetails: string,
): CanvasNodeData {
    const originalMeta = original?.metadata;
    const hasRecoverableOriginalMedia = Boolean(
        originalMeta && (
            isNonEmptyMediaRef(originalMeta.content)
            || isNonEmptyMediaRef(originalMeta.storageKey)
            || isNonEmptyMediaRef(originalMeta.previewContent)
        ),
    );
    if (!original || !hasRecoverableOriginalMedia) {
        return {
            ...item,
            metadata: {
                ...clearReplacedGenerationTaskMetadata(item.metadata),
                fileUpload: "error",
                fileUploadProgress: undefined,
                errorDetails,
            },
        };
    }
    const wasGenerationInFlight = originalMeta?.status === "loading"
        || originalMeta?.generationSubmissionState === "submitting"
        || originalMeta?.generationSubmissionState === "unknown"
        || originalMeta?.taskStatus === "queued"
        || originalMeta?.taskStatus === "running"
        || originalMeta?.taskOutcome?.phase === "running"
        || originalMeta?.taskOutcome?.phase === "fetching"
        || originalMeta?.agentGenerationContinuation?.status === "pending";
    if (!wasGenerationInFlight) {
        return {
            ...item,
            width: original.width,
            height: original.height,
            metadata: original.metadata,
        };
    }
    // 替换占位落入时已取消原生成消费者；回退到旧媒体时复用共享清理（保留原图组关联）并结算为已完成，避免留下僵尸 loading。
    const nextMeta: CanvasNodeMetadata = {
        ...clearReplacedGenerationTaskMetadata(originalMeta, { clearBatchLinkage: false }),
        status: "success",
    };
    delete nextMeta.fileUpload;
    delete nextMeta.fileUploadProgress;
    return {
        ...item,
        width: original.width,
        height: original.height,
        metadata: nextMeta,
    };
}
