import { type GenerationTask } from "@/services/api/task-center";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { isH3MaxFamilyModel, isH3Model, h3ResolvedReferenceOrder } from "@/lib/h3-video";
import { isSeedanceVideoConfig } from "@/lib/seedance-video";
import { modelCapabilityConfigFor, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { declaredOrOmniVideoCapability, hasDeclaredModelCapability, isBeefTVModelRoute, resolveVideoOperation } from "@/lib/model-selection";
import { resolveVideoReferenceCapabilities } from "@/lib/canvas/video-reference-mode";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type CanvasVideoEditOperation } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import {
    isInFlightGenerationTelemetryState,
    normalizeGenerationTaskProgress,
} from "@/lib/canvas/canvas-node-metadata-contract";
import { publishGenerationTaskTelemetry } from "@/stores/use-generation-task-telemetry";

export function generationTaskMetadata(task: GenerationTask): CanvasNodeMetadata {
    publishGenerationTaskTelemetry(task);
    const inFlight = isInFlightGenerationTelemetryState(task);
    const progress = inFlight ? undefined : normalizeGenerationTaskProgress(task.progress, task.status);
    return {
        taskId: task.id,
        taskType: task.type,
        taskOutcome: task.outcome,
        taskOutcomeSource: undefined,
        generationPreflightError: undefined,
        taskClientOperationId: task.clientOperationId,
        generationSubmissionState: "accepted",
        retryOf: task.retryOf,
        attemptGroupId: task.attemptGroupId,
        taskStatus: task.status,
        taskProgress: progress,
        taskStage: inFlight ? undefined : task.stage,
        taskProvider: task.provider,
        taskStartedAt: inFlight ? undefined : task.startedAt,
        taskCompletedAt: inFlight ? undefined : task.completedAt,
        taskDurationMs: inFlight
            ? undefined
            : task.startedAt && task.completedAt
              ? Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt))
              : undefined,
        taskErrorCode: task.errorCode,
        taskFailureDiagnostics: task.failureDiagnostics,
        taskProviderRequestId: inFlight ? undefined : task.providerRequestId,
        taskOfficialStatus: inFlight ? undefined : task.officialStatus,
        taskReceiptRecorded: inFlight ? undefined : task.receiptRecorded,
        taskCreatedAt: task.createdAt || task.created_at,
        taskUpdatedAt: inFlight ? undefined : (task.updatedAt || task.updated_at),
    };
}

// 失败节点再次提交前必须移除旧任务绑定，否则批次调度会把它误判为仍在处理。
export function resetGenerationTaskMetadata(metadata: CanvasNodeMetadata | undefined, status: CanvasNodeMetadata["status"] = "idle"): CanvasNodeMetadata {
    const next = {
        ...(metadata || {}),
        status,
        errorDetails: undefined,
        generationErrorCode: undefined,
        generationErrorSummary: undefined,
        generationProviderCode: undefined,
        generationPreflightError: undefined,
        failedPromptFingerprint: undefined,
        failedInputFingerprint: undefined,
    };
    delete next.taskId;
    delete next.taskType;
    delete next.taskOutcome;
    delete next.taskOutputIndex;
    delete next.generationOutputNodeIds;
    delete next.taskClientOperationId;
    delete next.generationSubmissionState;
    delete next.retryOf;
    delete next.attemptGroupId;
    delete next.taskStatus;
    delete next.taskProgress;
    delete next.taskStage;
    delete next.taskProvider;
    delete next.taskStartedAt;
    delete next.taskCompletedAt;
    delete next.taskDurationMs;
    delete next.taskErrorCode;
    delete next.taskFailureDiagnostics;
    delete next.taskProviderRequestId;
    delete next.taskOfficialStatus;
    delete next.taskReceiptRecorded;
    delete next.taskCreatedAt;
    delete next.taskUpdatedAt;
    delete next.generationFailure;
    delete next.taskOutcomeSource;
    delete next.processingLabel;
    delete next.fileUploadAttemptId;
    delete next.fileUpload;
    delete next.fileUploadProgress;
    return next;
}

export function clearInPlaceMediaOutputMetadata(metadata: CanvasNodeMetadata | undefined, status: CanvasNodeMetadata["status"] = "loading"): CanvasNodeMetadata {
    const next = resetGenerationTaskMetadata(metadata, status);
    delete next.depthSourceNodeId;
    delete next.content;
    delete next.storageKey;
    delete next.assetId;
    delete next.previewContent;
    delete next.videoPreview;
    delete next.naturalWidth;
    delete next.naturalHeight;
    delete next.durationMs;
    delete next.hasAudio;
    delete next.bytes;
    delete next.mimeType;
    delete next.generationEffectKeys;
    delete next.outputParameterWarning;
    return next;
}

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        workflowProvider: "model",
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        transparentBackground: config.transparentBackground,
        seedreamMode: config.seedreamMode,
        seedreamMaxImages: config.seedreamMaxImages,
        seedreamOutputFormat: config.seedreamOutputFormat,
        seedreamOptimize: config.seedreamOptimize,
        seedreamWatermark: config.seedreamWatermark,
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function nodeReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type === CanvasNodeType.MediaConversion) {
        // 转换结果只在成功物化后作为生成参考；运行中、跳过和失败状态都不能透传旧结果。
        const conversion = node.metadata?.mediaConversion;
        const storageKey = conversion?.resultStorageKey || node.metadata?.storageKey;
        if (conversion?.status !== "completed" || !storageKey) return null;
        return {
            id: node.id,
            name: node.title || `conversion-${node.id}.png`,
            type: node.metadata?.mimeType || "image/png",
            dataUrl: node.metadata?.content || "",
            storageKey,
        };
    }
    if (node.type !== CanvasNodeType.Image || (!node.metadata?.content && !node.metadata?.storageKey)) return null;
    return {
        id: node.id,
        name: `reference-${node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content || "",
        storageKey: node.metadata.storageKey,
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        workflowProvider: "model",
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioPitch: config.audioPitch,
        audioVolume: config.audioVolume,
        audioInstructions: config.audioInstructions,
    };
}

function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export async function resolveStoredReferenceImages(references?: string[]) {
    if (!references?.length) return [];
    const imageReferences = references.filter(isStoredImageReference);
    const images = await Promise.all(
        imageReferences.map(async (url, index) => {
            const storageKey = url.startsWith("image:") || resourceIdFromStorageKey(url) ? url : undefined;
            const dataUrl = storageKey ? await resolveImageUrl(storageKey, "") : url;
            if (!dataUrl) return null;
            return {
                id: `${index}`,
                name: `reference-${index + 1}.png`,
                type: imageMimeType(dataUrl),
                dataUrl,
                url: /^https?:\/\//i.test(dataUrl) ? dataUrl : undefined,
                storageKey,
            };
        }),
    );
    return images.every(Boolean) ? (images as ReferenceImage[]) : null;
}

function isStoredImageReference(url: string) {
    return resourceIdFromStorageKey(url) || url.startsWith("image:") || url.startsWith("data:image/") || /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(url);
}

function imageMimeType(url: string) {
    return url.match(/^data:(image\/[^;,]+)/)?.[1] || "image/png";
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

function isIndirectReferenceImage(image: ReferenceImage) {
    return Boolean(image.sourceNodeId) || image.id.startsWith("character-reference-") || image.id.startsWith("asset:");
}

function resolveVideoEditOperation(
    node: CanvasNodeData | undefined,
    context: {
        referenceImages: ReferenceImage[];
        referenceVideos: ReferenceVideo[];
        referenceAudios: ReferenceAudio[];
        characterReferences?: Array<unknown>;
    } | undefined,
    effectiveModel: string,
    videoProfile?: VideoCapabilityConfig | null,
    isBeefTVRoute?: boolean,
): CanvasVideoEditOperation {
    const storedOperation = node?.metadata?.videoEditOperation;
    const referenceImages = context?.referenceImages || [];
    const indirectCount = referenceImages.filter(isIndirectReferenceImage).length;
    const characterCount = indirectCount || (context?.characterReferences?.length ?? 0);
    const input = {
        textCount: 0,
        imageCount: referenceImages.length - indirectCount,
        videoCount: context?.referenceVideos.length || 0,
        audioCount: context?.referenceAudios.length || 0,
        characterCount,
    };
    return resolveVideoOperation(input, storedOperation, videoProfile, effectiveModel, isBeefTVRoute) as CanvasVideoEditOperation;
}

export function resolveVideoGenerationEditOperation(
    node: CanvasNodeData | undefined,
    context?: {
        referenceImages: ReferenceImage[];
        referenceVideos: ReferenceVideo[];
        referenceAudios: ReferenceAudio[];
        characterReferences?: Array<unknown>;
    },
    config?: AiConfig,
): CanvasVideoEditOperation {
    const metadata = node?.metadata;
    const draftTaskId = metadata?.videoDraftTaskId?.trim() || undefined;
    if (draftTaskId) return "draft_to_final";
    const effectiveModel = config?.model || metadata?.model || "";
    const safeConfig = config && Array.isArray(config.channels) && config.channels.length ? (config as AiConfig) : undefined;
    const isBeefTVRoute = isBeefTVModelRoute(effectiveModel, config);
    const declared = safeConfig ? hasDeclaredModelCapability(safeConfig, effectiveModel, "video") : false;
    const fullVideoProfile = safeConfig && effectiveModel ? modelCapabilityConfigFor(safeConfig, effectiveModel).video : undefined;
    const videoProfile = declaredOrOmniVideoCapability(config, effectiveModel);
    const { middleFrameSupport } = resolveVideoReferenceCapabilities(effectiveModel, fullVideoProfile, declared, isBeefTVRoute);
    const hasMiddleFrame = middleFrameSupport === "supported" && Boolean(metadata?.videoMiddleFrameNodeId);
    const resolvedOperation = resolveVideoEditOperation(node, context, effectiveModel, videoProfile, isBeefTVRoute);
    return hasMiddleFrame && Boolean(videoProfile?.operations.includes("reference_to_video"))
        ? "reference_to_video"
        : resolvedOperation;
}

export function buildVideoGenerationMetadata(
    node: CanvasNodeData | undefined,
    context?: {
        referenceImages: ReferenceImage[];
        referenceVideos: ReferenceVideo[];
        referenceAudios: ReferenceAudio[];
        characterReferences?: Array<unknown>;
    },
    config?: AiConfig,
): CanvasNodeMetadata {
    const metadata = node?.metadata;
    const referenceImageIds = new Set((context?.referenceImages || []).map((image) => image.id));
    const draftTaskId = metadata?.videoDraftTaskId?.trim() || undefined;
    const effectiveModel = config?.model || metadata?.model || "";
    const safeConfig = config && Array.isArray(config.channels) && config.channels.length ? (config as AiConfig) : undefined;
    const isBeefTVRoute = isBeefTVModelRoute(effectiveModel, config);
    const declared = safeConfig ? hasDeclaredModelCapability(safeConfig, effectiveModel, "video") : false;
    const fullVideoProfile = safeConfig && effectiveModel ? modelCapabilityConfigFor(safeConfig, effectiveModel).video : undefined;
    const videoProfile = declaredOrOmniVideoCapability(config, effectiveModel);
    const { maxFrameImages, endFrameSupported, maxFrameAudios, middleFrameSupport } = resolveVideoReferenceCapabilities(effectiveModel, fullVideoProfile, declared, isBeefTVRoute);
    const videoEditOperation = resolveVideoGenerationEditOperation(node, context, config);
    const storedOperation = metadata?.videoEditOperation;
    // 非中间帧能力声明模型的全模态参考生成不消费首尾帧/中间帧槽位；未知的自定义渠道仅在模式被自动提升时清理残留帧槽位。
    const ignoreFrameSelection =
        videoEditOperation === "draft_to_final" ||
        (videoEditOperation === "reference_to_video" &&
            (middleFrameSupport === "unsupported" || (middleFrameSupport === "opaque" && storedOperation !== "reference_to_video")));
    const clearMiddleFrame = ignoreFrameSelection || middleFrameSupport === "unsupported";
    const connectedImages = context?.referenceImages || [];
    const h3 = isH3Model(effectiveModel);
    const allDirectImageNodes =
        connectedImages.length > 0 &&
        connectedImages.length <= maxFrameImages &&
        connectedImages.every((image) => !isIndirectReferenceImage(image));
    const supportsReferenceVideo = !videoProfile || videoProfile.operations.includes("reference_to_video");
    const nonFrameMediaAttached = !h3 && supportsReferenceVideo && ((context?.referenceVideos.length || 0) > 0 || (context?.referenceAudios.length || 0) > maxFrameAudios || connectedImages.some(isIndirectReferenceImage));
    const storedStartFrame = !h3 && (nonFrameMediaAttached || (metadata?.videoStartFrameNodeId && !referenceImageIds.has(metadata.videoStartFrameNodeId)))
        ? undefined
        : metadata?.videoStartFrameNodeId;
    const storedEndFrame = !endFrameSupported || (!h3 && (nonFrameMediaAttached || (metadata?.videoEndFrameNodeId && !referenceImageIds.has(metadata.videoEndFrameNodeId))))
        ? undefined
        : metadata?.videoEndFrameNodeId;
    const defaultFrames =
        !ignoreFrameSelection &&
        videoEditOperation === "image_to_video" &&
        !storedStartFrame &&
        !storedEndFrame &&
        (context?.referenceVideos.length || 0) === 0 &&
        (context?.referenceAudios.length || 0) <= maxFrameAudios &&
        allDirectImageNodes;
    const startFrame = ignoreFrameSelection
        ? undefined
        : defaultFrames
          ? connectedImages[0]?.id
          : requireConnectedVideoFrame(storedStartFrame, "首帧", referenceImageIds);
    const endFrame = ignoreFrameSelection
        ? undefined
        : defaultFrames && endFrameSupported && connectedImages.length === 2
          ? connectedImages[1]?.id
          : requireConnectedVideoFrame(storedEndFrame, "尾帧", referenceImageIds);
    const middleFrame = clearMiddleFrame || !metadata?.videoMiddleFrameNodeId ? undefined : requireConnectedVideoFrame(metadata.videoMiddleFrameNodeId, "中间帧", referenceImageIds);
    return {
        ...(config ? { workflowProvider: "model" as const } : {}),
        videoEditOperation,
        videoDraftTaskId: draftTaskId,
        returnLastFrame: metadata?.returnLastFrame ?? config?.videoReturnLastFrame,
        videoCameraMoveId: metadata?.videoCameraMoveId,
        videoCameraMovePrompt: metadata?.videoCameraMovePrompt,
        videoStartFrameNodeId: startFrame,
        videoEndFrameNodeId: endFrame,
        videoMiddleFrameNodeId: middleFrame,
        videoMiddleFrameTime: clearMiddleFrame ? undefined : metadata?.videoMiddleFrameTime,
        videoH3Options: h3 ? metadata?.videoH3Options : undefined,
        videoReferenceOrder: isH3MaxFamilyModel(effectiveModel)
            ? h3ResolvedReferenceOrder(metadata?.videoReferenceOrder, [...(context?.referenceImages || []), ...(context?.referenceVideos || []), ...(context?.referenceAudios || [])])
            : undefined,
    };
}

function requireConnectedVideoFrame(frameNodeId: string | undefined, label: string, referenceImageIds: Set<string>) {
    if (!frameNodeId) return undefined;
    if (referenceImageIds.has(frameNodeId)) return frameNodeId;
    throw new Error(`已配置的${label}参考图未连接或不可用，请重新选择后再生成`);
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    return resolveStoredReferenceImages(metadata.references);
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const content = node.metadata?.content;
            const videoPreview =
                node.type === CanvasNodeType.Video && node.metadata?.videoPreview?.storageKey
                    ? { ...node.metadata.videoPreview, content: await resolveImageUrl(node.metadata.videoPreview.storageKey, node.metadata.videoPreview.content, { cacheMiss: true }) }
                    : node.metadata?.videoPreview;
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveMediaUrl(node.metadata.storageKey, content), videoPreview } };
            if (videoPreview !== node.metadata?.videoPreview) return { ...node, metadata: { ...node.metadata, videoPreview } };
            if (node.type === CanvasNodeType.Image && node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveImageUrl(node.metadata.storageKey, content, { cacheMiss: true }) } };
            if (node.type !== CanvasNodeType.Image || !content) return node;
            if (!content.startsWith("data:image/")) return node;
            return { ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadImage(content)) } };
        }),
    );
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export { buildGenerationConfig, resolveCanvasGenerationModel } from "./canvas-generation-config";

export function supportsVideoReferenceAudio(config: AiConfig) {
    const interfaceType = resolveModelRequestConfig(config, config.model).interfaceType;
    return interfaceType === "newapi-channel-1" || interfaceType === "newapi-channel-2" || isSeedanceVideoConfig(config);
}
