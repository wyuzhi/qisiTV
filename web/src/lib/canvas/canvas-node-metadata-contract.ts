import { GENERATION_RESULT_FETCH_STAGE } from "@/lib/generation-delivery-progress";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export const INTERRUPTED_FILE_UPLOAD_MESSAGE = "上传已中断，请重新选择文件上传";

export const GENERATION_MEDIA_RESULT_KEYS = ["content", "storageKey", "assetId"] as const;

export const TRANSIENT_TASK_TELEMETRY_KEYS = [
    "taskProgress",
    "taskStage",
    "taskUpdatedAt",
    "taskDurationMs",
    "taskStartedAt",
    "taskProviderRequestId",
    "taskOfficialStatus",
    "taskReceiptRecorded",
] as const satisfies ReadonlyArray<keyof CanvasNodeMetadata>;

export const GENERATION_TASK_LIFECYCLE_METADATA_KEYS = [
    "taskType",
    "taskOutcome",
    "taskClientOperationId",
    "taskClientOperationInput",
    "taskClientOperationTerminal",
    "generationSubmissionState",
    "retryOf",
    "attemptGroupId",
    "taskProvider",
    "taskStatus",
    "taskProgress",
    "taskStage",
    "taskCreatedAt",
    "taskStartedAt",
    "taskCompletedAt",
    "taskDurationMs",
    "taskErrorCode",
    "taskProviderRequestId",
    "taskOfficialStatus",
    "taskReceiptRecorded",
    "taskUpdatedAt",
    "generationEffectKeys",
] as const;

export const GENERATION_ERROR_METADATA_KEYS = [
    "errorDetails",
    "generationErrorCode",
    "generationErrorSummary",
    "generationProviderCode",
    "taskFailureDiagnostics",
    "generationFailure",
    "generationPreflightError",
    "taskOutcomeSource",
    "resourceReloadAvailable",
    "failedPromptFingerprint",
    "failedInputFingerprint",
    "processingLabel",
] as const;

// 模型切换或本地文件替换时统一失效的节点级模型参数（分辨率/宽高比/时长/质量/音色等）。
export const NODE_MODEL_GENERATION_PARAMS = [
    "size",
    "quality",
    "transparentBackground",
    "seedreamMode",
    "seedreamMaxImages",
    "seedreamOutputFormat",
    "seedreamOptimize",
    "seedreamWatermark",
    "count",
    "seconds",
    "vquality",
    "generateAudio",
    "watermark",
    "draft",
    "returnLastFrame",
    "videoH3Options",
    "videoReferenceOrder",
    "audioVoice",
    "audioFormat",
    "audioSpeed",
    "audioPitch",
    "audioVolume",
    "audioInstructions",
] as const satisfies ReadonlyArray<keyof CanvasNodeMetadata>;

export const UPLOAD_SETTLEMENT_METADATA_KEYS = [
    "fileUpload",
    "fileUploadProgress",
    "fileUploadAttemptId",
    "errorDetails",
    "content",
    "storageKey",
    "assetId",
    "status",
    "bytes",
    "mimeType",
    "naturalWidth",
    "naturalHeight",
    "durationMs",
    "hasAudio",
    "videoPreview",
    "outputParameterWarning",
    "nodeRole",
    "resultOrigin",
] as const satisfies ReadonlyArray<keyof CanvasNodeMetadata>;

export const UPLOAD_REPLACEMENT_RESET_KEYS = [
    "taskId",
    "taskOutputIndex",
    "generationOutputNodeIds",
    "agentGenerationContinuation",
    "sessionId",
    ...GENERATION_TASK_LIFECYCLE_METADATA_KEYS,
    ...GENERATION_ERROR_METADATA_KEYS,
    "model",
    "workflowProvider",
    "textCount",
    "arkPrivateAssetUpload",
    ...NODE_MODEL_GENERATION_PARAMS,
    "references",
    "generationMode",
    "generationType",
    "generationResultPlacement",
    "lastGenerationRequestFingerprint",
    "videoDraftTaskId",
    "videoEditOperation",
    "lastFrameUrl",
    "lastFrameStorageKey",
    "freeResize",
    "isBatchRoot",
    "batchRootId",
    "batchChildIds",
    "batchFailedCount",
    "batchUsesReferenceImages",
    "generatedFromNodeId",
    "generatedFromProcessingNodeId",
    "pluginNodeId",
    "copiedFromNodeId",
    "versionOfNodeId",
    "primaryImageId",
    "imageBatchExpanded",
    "imageHistory",
    "imageHistoryRemovedIds",
    "richText",
    "composerContent",
    "previewContent",
    "mediaOperationError",
    "audioExtractSourceNodeId",
    "audioExtractStartMs",
    "audioExtractEndMs",
    "videoTrimSourceNodeId",
    "videoTrimStartMs",
    "videoTrimEndMs",
    "videoTrimSource",
    "videoCrop",
    "videoCropSourceNodeId",
    "videoSegmentSourceNodeId",
    "videoSegmentStartMs",
    "videoSegmentEndMs",
    "videoSegmentIndex",
    "videoSegmentAction",
    "videoAudioSourceNodeId",
    "videoFrameSourceNodeId",
    "videoFrameTimeMs",
    "videoSubtitleEraseSourceNodeId",
    "videoRetakeSourceNodeId",
    "videoRetakeCount",
    "videoRetakeMax",
    "videoRetakeSegments",
    "videoRetakeReferenceMode",
    "videoRetakeWebSearch",
    "videoRetakeAutoValidate",
    "videoRetakeAutoLink",
    "videoMergeSourceNodeIds",
    "depthSourceNodeId",
    "importSource",
    "emotionEdit",
    "portraitTexture",
    "cameraControl",
] as const satisfies ReadonlyArray<keyof CanvasNodeMetadata | (typeof GENERATION_ERROR_METADATA_KEYS)[number]>;

export const GENERATION_BIND_METADATA_KEYS = [
    ...GENERATION_MEDIA_RESULT_KEYS,
    "imageHistory",
    "mimeType",
    "bytes",
    "naturalWidth",
    "naturalHeight",
    "durationMs",
    "nodeRole",
    "resultOrigin",
    "status",
    ...GENERATION_TASK_LIFECYCLE_METADATA_KEYS,
] as const;

export function equalSerializedValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

export function normalizeGenerationTaskProgress(progress: number | undefined, status: string | undefined): number | undefined {
    if (typeof progress === "number" && Number.isFinite(progress)) {
        return Math.max(0, Math.min(100, Math.round(progress)));
    }
    if (status === "queued") return 0;
    if (status === "succeeded") return 100;
    return undefined;
}

export function isInFlightGenerationTelemetryState(input: {
    status?: string;
    stage?: string;
    outcome?: { phase?: string } | null;
}): boolean {
    if (input.status !== "queued" && input.status !== "running") return false;
    if (
        input.stage === "submission_unknown" ||
        input.stage === GENERATION_RESULT_FETCH_STAGE ||
        input.stage === "正在取回结果"
    ) {
        return false;
    }
    const phase = input.outcome && typeof input.outcome === "object" ? input.outcome.phase : undefined;
    if (phase === "fetching" || phase === "retrievable" || phase === "ready" || phase === "failed") {
        return false;
    }
    return true;
}

export function isTerminalGenerationTaskTelemetry(input: {
    status?: string;
    outcome?: { phase?: string } | null;
}): boolean {
    if (
        input.status === "succeeded" ||
        input.status === "failed" ||
        input.status === "cancelled" ||
        input.status === "text_replay"
    ) {
        return true;
    }
    const phase = input.outcome && typeof input.outcome === "object" ? input.outcome.phase : undefined;
    return phase === "ready" || phase === "failed" || phase === "retrievable";
}

export function isNonEmptyMediaRef(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

export function hasSettledNodeMedia(
    metadata: CanvasNodeMetadata | undefined,
    options?: { requireSuccess?: boolean },
): boolean {
    if (!metadata || (!isNonEmptyMediaRef(metadata.content) && !isNonEmptyMediaRef(metadata.storageKey))) {
        return false;
    }
    if (options?.requireSuccess) {
        return metadata.status === "success";
    }
    return !metadata.fileUpload && metadata.status !== "loading" && metadata.status !== "error";
}

// 替换上传进行中会把 status 置为 undefined；只有 status=success 且已有媒体引用时，才说明上传已真正完成。
export function hasSettledFileUploadMedia(metadata: CanvasNodeMetadata | undefined): boolean {
    return hasSettledNodeMedia(metadata, { requireSuccess: true });
}

export function hasConfirmedGeneratedMediaEvidence(metadata: CanvasNodeMetadata | undefined): boolean {
    return Boolean(metadata?.generationEffectKeys?.length) || Boolean(metadata?.assetId?.startsWith("generation_"));
}

export function hasStaleSettledFileUploadFlag(metadata: CanvasNodeMetadata | undefined): boolean {
    if (!metadata?.fileUpload || !hasSettledFileUploadMedia(metadata)) return false;
    return metadata.fileUpload === "uploading"
        || (metadata.fileUpload === "error" && metadata.errorDetails === INTERRUPTED_FILE_UPLOAD_MESSAGE);
}

export function isFileUploadOverlayActive(metadata: CanvasNodeMetadata | undefined): boolean {
    return Boolean(metadata?.fileUpload) && !hasStaleSettledFileUploadFlag(metadata);
}

export function isFileUploadInProgress(metadata: CanvasNodeMetadata | undefined): boolean {
    return metadata?.fileUpload === "uploading" && !hasStaleSettledFileUploadFlag(metadata);
}

export function clearReplacedGenerationTaskMetadata(
    metadata: CanvasNodeMetadata | undefined,
    options?: { clearBatchLinkage?: boolean },
): CanvasNodeMetadata {
    const next: Record<string, unknown> = { ...((metadata || {}) as Record<string, unknown>) };
    delete next.taskId;
    delete next.taskOutputIndex;
    delete next.generationOutputNodeIds;
    delete next.agentGenerationContinuation;
    delete next.sessionId;
    if (options?.clearBatchLinkage !== false) {
        delete next.isBatchRoot;
        delete next.batchRootId;
        delete next.batchChildIds;
        delete next.batchFailedCount;
        delete next.batchUsesReferenceImages;
    }
    for (const key of GENERATION_TASK_LIFECYCLE_METADATA_KEYS) {
        delete next[key];
    }
    for (const key of GENERATION_ERROR_METADATA_KEYS) {
        delete next[key];
    }
    for (const key of Object.keys(next)) {
        if (next[key] === undefined) delete next[key];
    }
    return next as CanvasNodeMetadata;
}

const REPLACED_GENERATION_IDENTITY_KEYS = [
    "taskId",
    "taskOutputIndex",
    "generationOutputNodeIds",
    "agentGenerationContinuation",
    "sessionId",
] as const;

function hasStaleGenerationTaskMetadata(metadata: CanvasNodeMetadata): boolean {
    const record = metadata as Record<string, unknown>;
    for (const key of REPLACED_GENERATION_IDENTITY_KEYS) {
        if (record[key] !== undefined) return true;
    }
    for (const key of GENERATION_TASK_LIFECYCLE_METADATA_KEYS) {
        if (record[key] !== undefined) return true;
    }
    for (const key of GENERATION_ERROR_METADATA_KEYS) {
        if (key === "errorDetails" && metadata.status === "error") continue;
        if (record[key] !== undefined) return true;
    }
    return false;
}

export function stripStaleFileUploadMetadata(node: CanvasNodeData): CanvasNodeData;
export function stripStaleFileUploadMetadata(node: CanvasNodeData | undefined): CanvasNodeData | undefined;
export function stripStaleFileUploadMetadata(node: CanvasNodeData | undefined): CanvasNodeData | undefined {
    const rawMeta = node?.metadata;
    if (!rawMeta) return node;
    const hasStaleUploadFlag = hasStaleSettledFileUploadFlag(rawMeta);
    const origin = rawMeta.resultOrigin || (rawMeta.fileUploadAttemptId ? "upload" : undefined);
    const isSettledNonGenerationOrigin = (origin === "upload" || origin === "library" || origin === "imported")
        && rawMeta.status !== "loading"
        && !isFileUploadOverlayActive(rawMeta);
    const hasStaleNonGenTask = isSettledNonGenerationOrigin && hasStaleGenerationTaskMetadata(rawMeta);
    if (!hasStaleUploadFlag && !hasStaleNonGenTask) return node;

    const shouldStripGenerationTask = hasStaleNonGenTask
        || (hasStaleUploadFlag && (!origin || origin === "upload" || origin === "library" || origin === "imported"));
    const preserveErrorDetails = !hasStaleUploadFlag && rawMeta.status === "error" ? rawMeta.errorDetails : undefined;
    const baseMeta = shouldStripGenerationTask
        ? clearReplacedGenerationTaskMetadata(rawMeta, { clearBatchLinkage: !origin || origin === "upload" })
        : rawMeta;
    const metadata: Record<string, unknown> = { ...(baseMeta as Record<string, unknown>) };
    if (hasStaleUploadFlag) {
        delete metadata.fileUpload;
        delete metadata.fileUploadProgress;
        if (!origin || origin === "upload" || metadata.errorDetails === INTERRUPTED_FILE_UPLOAD_MESSAGE) {
            delete metadata.errorDetails;
        }
    } else if (preserveErrorDetails !== undefined) {
        metadata.errorDetails = preserveErrorDetails;
    }
    return { ...node, metadata: metadata as CanvasNodeMetadata };
}

export function interruptFileUpload(node: CanvasNodeData): CanvasNodeData {
    const cleaned = stripStaleFileUploadMetadata(node);
    if (cleaned !== node) return cleaned;
    if (node.metadata?.fileUpload !== "uploading") return node;
    return {
        ...node,
        metadata: {
            ...clearReplacedGenerationTaskMetadata(node.metadata),
            fileUpload: "error",
            fileUploadProgress: undefined,
            errorDetails: INTERRUPTED_FILE_UPLOAD_MESSAGE,
        },
    };
}
