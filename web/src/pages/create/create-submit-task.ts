import type { App } from "antd";

import type { createReferenceLinkResolver } from "@/components/generation-reference-links";
import { explainGenerationError } from "@/lib/generation-error";
import { normalizeImageValue, normalizeVideoValue, type ImageCapabilityConfig, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { declaredOrOmniVideoCapability, isBeefTVModelRoute, resolveVideoOperation } from "@/lib/model-selection";
import type { GenerationTask } from "@/services/api/task-center";
import type { AiConfig } from "@/stores/use-config-store";
import type { NewAsset } from "@/stores/use-asset-store";
import {
    creationAttachmentFromAudio,
    creationAttachmentFromDocument,
    creationAttachmentFromImage,
    creationAttachmentFromVideo,
    creationAudioAsset,
    creationFileAccepted,
    creationImageAsset,
    creationVideoAsset,
    isCreationAudioFile,
    isCreationVideoFile,
    splitCreationAttachments,
    type CreationAttachment,
} from "./creation-assets";
import { expandCreationPrompt, selectedCreationReferences, type CreationReference } from "./creation-references";
import { modeLabels, type CreationConversation, type CreationMessage, type CreationMode, type CreationRetryContext } from "./creation-types";
import { completedCreationGenerationTask, newMessage } from "./creation-conversations";

export const loadCreationRuntime = () => import("./creation-runtime");

type MessageToast = ReturnType<typeof App.useApp>["message"];
type ReferenceLinkResolver = ReturnType<typeof createReferenceLinkResolver>;

export async function uploadCreationAsset(file: File): Promise<{ asset?: NewAsset; attachment: CreationAttachment }> {
    const { uploadImage, uploadMediaFile } = await loadCreationRuntime();
    if (isCreationVideoFile(file)) {
        const uploaded = await uploadMediaFile(file, "create-upload");
        return {
            asset: creationVideoAsset({ title: file.name, uploaded, metadata: { source: "create-upload", fileName: file.name } }),
            attachment: creationAttachmentFromVideo(file, uploaded),
        };
    }
    if (isCreationAudioFile(file)) {
        const uploaded = await uploadMediaFile(file, "audio");
        return {
            asset: creationAudioAsset({ title: file.name, uploaded, metadata: { source: "create-upload", fileName: file.name } }),
            attachment: creationAttachmentFromAudio(file, uploaded),
        };
    }
    if (!file.type.startsWith("image/")) {
        const uploaded = await uploadMediaFile(file, "create-upload");
        return { attachment: creationAttachmentFromDocument(file, uploaded) };
    }
    const uploaded = await uploadImage(file);
    return {
        asset: creationImageAsset({ title: file.name, uploaded, metadata: { source: "create-upload", fileName: file.name } }),
        attachment: creationAttachmentFromImage(file, uploaded),
    };
}

export async function uploadCreationLibraryFiles(
    mode: CreationMode,
    files: FileList | File[],
    addAsset: (asset: NewAsset) => string,
    toast: Pick<MessageToast, "success" | "error">,
    uploadAsset: typeof uploadCreationAsset = uploadCreationAsset,
): Promise<string[]> {
    const next = Array.from(files).filter((file) => creationFileAccepted(mode, file));
    if (!next.length) return [];
    const settled = await Promise.allSettled(next.map(async (file) => {
        const { asset } = await uploadAsset(file);
        return asset ? addAsset(asset) : "";
    }));
    const assetIds = settled.flatMap((entry) => entry.status === "fulfilled" && entry.value ? [entry.value] : []);
    const failed = settled.filter((entry) => entry.status === "rejected");
    if (assetIds.length) toast.success(`${assetIds.length} 个素材已上传到素材库并自动选中`);
    if (failed.length) toast.error(`${failed.length} 个素材上传失败，请重试`);
    return assetIds;
}

export function bindGenerationTaskToMessage(item: CreationMessage, task: GenerationTask): CreationMessage {
    return {
        ...item,
        taskOutcome: task.outcome,
        taskFailureDiagnostics: task.failureDiagnostics ?? item.taskFailureDiagnostics,
        generationStage: task.stage,
        generationOperation: task.operation,
        generationErrorCode: task.errorCode,
        taskIds: Array.from(new Set([...(item.taskIds || []), task.id])),
        clientOperationId: task.clientOperationId,
        retryOf: task.retryOf,
        attemptGroupId: task.attemptGroupId,
    };
}

export function applyGenerationFailureToMessage(
    item: CreationMessage,
    error: unknown,
    boundTasks: ReadonlyMap<string, GenerationTask>,
    fallbackOperation: string,
    createdAt: string,
): CreationMessage {
    const failedTask = Array.from(boundTasks.values()).find((task) => task.errorCode || task.failureDiagnostics || task.outcome);
    const explained = explainGenerationError(failedTask?.errorCode && error instanceof Error ? { code: failedTask.errorCode, message: error.message } : error);
    return {
        ...item,
        status: "error",
        error: explained.message,
        generationErrorSummary: explained.summary,
        generationProviderCode: explained.providerCode,
        taskFailureDiagnostics: failedTask?.failureDiagnostics,
        taskOutcome: failedTask?.outcome ?? item.taskOutcome,
        generationErrorCode: item.generationErrorCode || failedTask?.errorCode || (explained.category === "unknown" ? undefined : explained.errorCode),
        generationOperation: item.generationOperation || fallbackOperation,
        createdAt,
        content: "生成失败",
    };
}

interface ExecuteCreateSubmitParams {
    promptText: string;
    busy: boolean;
    activeConversation?: CreationConversation;
    selectedModel: string;
    mode: CreationMode;
    config: AiConfig;
    attachments: CreationAttachment[];
    mentionReferences: CreationReference[];
    ratio: string;
    seconds: string;
    quality: string;
    videoQuality: string;
    count: string;
    textStreaming: boolean;
    textThinking: boolean;
    imageProfile: ImageCapabilityConfig;
    videoProfile: VideoCapabilityConfig;
    retryContext?: CreationRetryContext;
    retryLockKey?: string;
    retryPreparingSet: Set<string>;
    activeGenerationTaskIdsSet: Set<string>;
    abortRef: { current: AbortController | null };
    followLatestMessageRef: { current: boolean };
    toast: MessageToast;
    resolveReferenceLinks: ReferenceLinkResolver;
    setBusy: (busy: boolean) => void;
    setComposerNotice: (notice: string) => void;
    setPrompt: (value: string) => void;
    setAttachments: (value: CreationAttachment[]) => void;
    setDraftReferences: (value: CreationReference[]) => void;
    setReferenceNotice: (value: string) => void;
    updateActive: (updater: (conversation: CreationConversation) => CreationConversation) => void;
    updateConversationMessage: (conversationId: string, id: string, updater: (item: CreationMessage) => CreationMessage) => Promise<void>;
    applyCanonicalConversation: (conversationId: string, document: CreationConversation) => void;
}

export async function executeCreateSubmit(params: ExecuteCreateSubmitParams) {
    const {
        promptText,
        busy,
        activeConversation,
        selectedModel,
        mode,
        config,
        attachments,
        mentionReferences,
        ratio,
        seconds,
        quality,
        videoQuality,
        count,
        textStreaming,
        textThinking,
        imageProfile,
        videoProfile,
        retryContext,
        retryLockKey,
        retryPreparingSet,
        activeGenerationTaskIdsSet,
        abortRef,
        followLatestMessageRef,
        toast,
        resolveReferenceLinks,
        setBusy,
        setComposerNotice,
        setPrompt,
        setAttachments,
        setDraftReferences,
        setReferenceNotice,
        updateActive,
        updateConversationMessage,
        applyCanonicalConversation,
    } = params;

    const releaseRetryLock = () => {
        if (retryLockKey) retryPreparingSet.delete(retryLockKey);
    };
    const text = promptText.trim();
    if (!text || busy || !activeConversation) {
        releaseRetryLock();
        return;
    }
    if (!selectedModel) {
        toast.warning(`请先在设置中配置${modeLabels[mode]}模型`);
        releaseRetryLock();
        return;
    }

    const { referenceImages, referenceVideos, referenceAudios } = splitCreationAttachments(attachments);
    const settings = { ratio, seconds, quality, videoQuality, count };
    const references = selectedCreationReferences(text, mentionReferences);
    const videoOperation = resolveVideoOperation(
        { textCount: text ? 1 : 0, imageCount: referenceImages.length, videoCount: referenceVideos.length, audioCount: referenceAudios.length, characterCount: 0 },
        undefined,
        declaredOrOmniVideoCapability(config, selectedModel),
        selectedModel,
        isBeefTVModelRoute(selectedModel, config),
    );
    const skillReferences = references.flatMap((reference) => (reference.skill ? [reference.skill] : []));
    const runtime = await loadCreationRuntime();
    let skillExecution: Awaited<ReturnType<typeof runtime.skillRuntime.prepare>>;
    try {
        skillExecution = await runtime.skillRuntime.prepare({
            profile: "creation",
            prompt: expandCreationPrompt(text, references, attachments),
            skills: skillReferences,
            selectedSkillIds: skillReferences.map((skill) => skill.skillId),
        });
    } catch (error) {
        toast.error(error instanceof Error ? error.message : "技能上下文加载失败");
        releaseRetryLock();
        return;
    }

    const expandedPrompt = skillExecution.prompt;
    const referenceMetadata = skillExecution.metadata;
    followLatestMessageRef.current = true;
    setComposerNotice("");
    const userMessage = newMessage("user", text, { mode, model: selectedModel, attachments, references, settings });
    const assistantMessage = newMessage("assistant", "", { mode, model: selectedModel, status: mode === "text" && textStreaming ? "streaming" : "pending", settings, ...retryContext });
    const originConversationId = activeConversation.id;
    const updateOriginAssistant = (updater: (item: CreationMessage) => CreationMessage) => updateConversationMessage(originConversationId, assistantMessage.id, updater);
    const boundTaskIds = new Set<string>();
    const boundTaskIdsByBatchIndex = new Map<number, string>();
    const boundTasks = new Map<string, GenerationTask>();
    const controller = new AbortController();

    const bindTask = (task: GenerationTask) => {
        if (typeof task.clientContext?.batchIndex === "number") boundTaskIdsByBatchIndex.set(task.clientContext.batchIndex, task.id);
        boundTaskIds.add(task.id);
        activeGenerationTaskIdsSet.add(task.id);
        boundTasks.set(task.id, task);
        updateOriginAssistant((item) => bindGenerationTaskToMessage(item, task));
        if (abortRef.current === controller) {
            abortRef.current = null;
            setBusy(false);
        }
    };

    updateActive((conversation) => ({
        ...conversation,
        title: conversation.messages.length ? conversation.title : text.slice(0, 24),
        updatedAt: new Date().toISOString(),
        messages: [...conversation.messages, userMessage, assistantMessage],
    }));
    setPrompt("");
    setAttachments([]);
    setDraftReferences([]);
    setReferenceNotice("");
    setBusy(true);

    const requestLifecycle = runtime.beginGenerationConsumer(controller.signal);
    abortRef.current = controller;
    const normalizedImage = mode === "image" ? normalizeImageValue(imageProfile, { size: ratio, quality, count }) : undefined;
    const normalizedVideo = mode === "video" ? normalizeVideoValue(videoProfile, { seconds, ratio, resolution: videoQuality }) : undefined;
    const requestConfig = {
        ...config,
        model: selectedModel,
        imageModel: selectedModel,
        videoModel: selectedModel,
        textModel: selectedModel,
        ...(mode === "image"
            ? { size: normalizedImage?.size || ratio, quality: normalizedImage?.quality || quality, count: normalizedImage?.count || count, videoSeconds: config.videoSeconds }
            : mode === "video"
              ? { size: normalizedVideo?.ratio ?? ratio, videoSeconds: normalizedVideo?.seconds || seconds, vquality: (normalizedVideo?.resolution ?? videoQuality).replace(/p$/i, "") }
              : {}),
    };

    try {
        if (mode === "text") {
            const result = await runtime.runGenerationOperationOnce(retryContext?.clientOperationId, () => runtime.runBackendGenerationTask({
                resolveReferenceLinks,
                mode: "text",
                prompt: expandedPrompt,
                config: requestConfig,
                referenceImages,
                referenceVideos,
                referenceAudios,
                textHistory: (activeConversation.messages || []).filter((item) => item.content.trim()).map((item) => ({ role: item.role, content: item.content })),
                signal: requestLifecycle.signal,
                metadata: { source: "create-page", conversationId: activeConversation.id, messageId: assistantMessage.id, ...referenceMetadata },
                onTaskUpdate: bindTask,
                streamText: textStreaming,
                enableThinking: textThinking,
                onTextDelta: textStreaming ? (value) => updateOriginAssistant((item) => ({ ...item, content: value })) : undefined,
                ...retryContext,
            }));
            if (!result.text?.trim()) throw new Error("后端任务没有返回文本");
            const textTaskId = Array.from(boundTaskIds)[0];
            if (textTaskId) {
                await runtime.consumeGenerationTaskMessage({
                    ...(boundTasks.get(textTaskId) || {
                        id: textTaskId,
                        type: "text",
                        status: "succeeded",
                        prompt: expandedPrompt,
                        attempts: 1,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    }),
                    id: textTaskId,
                    type: boundTasks.get(textTaskId)?.type || "text",
                    status: "succeeded",
                    clientContext: { conversationId: originConversationId, messageId: assistantMessage.id },
                }, assistantMessage.id, async ({ conversation, bindingStatus }) => {
                    if (bindingStatus === "deleted") return;
                    if (conversation) applyCanonicalConversation(originConversationId, conversation as CreationConversation);
                }, { signal: requestLifecycle.signal, materialize: async (task) => task });
            } else {
                updateOriginAssistant((item) => ({ ...item, content: result.text || "", reasoning: result.reasoning }));
            }
        } else if (mode === "image") {
            const taskCount = imageProfile.fixedOutputs ? Number(normalizedImage!.count) / imageProfile.fixedOutputs : Math.max(1, Math.min(imageProfile.maxOutputs, Math.floor(Number(count) || 1)));
            const settled = await runtime.runGenerationOperationOnce(retryContext?.clientOperationId, () => runtime.runBackendGenerationTaskBatch({
                resolveReferenceLinks,
                mode: "image",
                prompt: expandedPrompt,
                config: { ...requestConfig, count: String(imageProfile.fixedOutputs || 1) },
                referenceImages,
                signal: requestLifecycle.signal,
                metadata: { source: "create-page", conversationId: activeConversation.id, messageId: assistantMessage.id, ...referenceMetadata },
                onTaskUpdate: bindTask,
                count: taskCount,
                ...retryContext,
            }));
            if (requestLifecycle.signal.aborted) throw new DOMException("Aborted", "AbortError");
            const boundTaskIdList = Array.from(boundTaskIds);
            const generatedImages = settled.flatMap((entry, batchIndex) => {
                if (entry.status !== "fulfilled") return [];
                return (entry.value.images || []).map((image, resultIndex) => ({
                    image,
                    resultImages: entry.value.images || [],
                    taskId: boundTaskIdsByBatchIndex.get(batchIndex) || boundTaskIdList[batchIndex],
                    batchIndex,
                    resultIndex,
                }));
            });
            const taskFailures = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
            const imageTasks = imageProfile.fixedOutputs ? generatedImages.filter((item) => item.resultIndex === 0) : generatedImages;
            const storedImages = await Promise.allSettled(imageTasks.map(async ({ image, resultImages, taskId, batchIndex }) => {
                if (!taskId) throw new Error("生成任务缺少稳定任务标识");
                const task = completedCreationGenerationTask(runtime, { taskId, task: boundTasks.get(taskId), mode: "image", prompt: expandedPrompt, result: { mode: "image", images: imageProfile.fixedOutputs ? resultImages : [image] }, conversationId: activeConversation.id, messageId: assistantMessage.id, batchIndex, batchCount: taskCount });
                const materialized = await runtime.consumeGenerationTaskMessage(task, assistantMessage.id, async ({ conversation, bindingStatus }) => {
                    if (bindingStatus === "deleted") return;
                    if (conversation) applyCanonicalConversation(originConversationId, conversation as CreationConversation);
                }, { signal: requestLifecycle.signal });
                const urls = runtime.generationTaskMaterializedUrls(materialized);
                if (!urls[0]) throw new Error("图片结果资源不可用");
                return imageProfile.fixedOutputs ? urls : [urls[0]];
            }));
            const resultUrls = storedImages.flatMap((entry) => entry.status === "fulfilled" ? entry.value : []);
            const resourceFailures = storedImages.filter((entry) => entry.status === "rejected");
            const failedCount = taskFailures.length + resourceFailures.length;
            if (!resultUrls.length) {
                const reason = taskFailures[0]?.reason || resourceFailures[0]?.reason;
                throw reason instanceof Error ? reason : new Error("后端任务没有返回图片");
            }
            if (failedCount) toast.warning(`${resultUrls.length} 张图片已生成，${failedCount} 批生成或保存失败`);
            updateOriginAssistant((item) => ({ ...item, content: failedCount ? `${resultUrls.length} 张图片已生成，${failedCount} 张失败` : "图片已生成" }));
        } else {
            const result = await runtime.runGenerationOperationOnce(retryContext?.clientOperationId, () => runtime.runBackendGenerationTask({
                resolveReferenceLinks,
                mode: "video",
                prompt: expandedPrompt,
                config: requestConfig,
                referenceImages,
                referenceVideos,
                referenceAudios,
                signal: requestLifecycle.signal,
                metadata: { source: "create-page", conversationId: activeConversation.id, messageId: assistantMessage.id, videoEditOperation: videoOperation, ...referenceMetadata },
                onTaskUpdate: bindTask,
                ...retryContext,
            }));
            if (!result.video?.dataUrl) throw new Error("后端任务没有返回视频");
            const taskId = Array.from(boundTaskIds)[0];
            if (!taskId) throw new Error("生成任务缺少稳定任务标识");
            const task = completedCreationGenerationTask(runtime, { taskId, task: boundTasks.get(taskId), mode: "video", prompt: expandedPrompt, result, conversationId: activeConversation.id, messageId: assistantMessage.id });
            const materialized = await runtime.consumeGenerationTaskMessage(task, assistantMessage.id, async ({ conversation, bindingStatus }) => {
                if (bindingStatus === "deleted") return;
                if (conversation) applyCanonicalConversation(originConversationId, conversation as CreationConversation);
            }, { signal: requestLifecycle.signal });
            if (!runtime.generationTaskMaterializedUrls(materialized)[0]) throw new Error("视频结果资源不可用");
        }
        updateOriginAssistant((item) => ({ ...item, status: "done" }));
    } catch (error) {
        if (runtime.isGenerationTaskCancelled(error, requestLifecycle.signal)) {
            updateOriginAssistant((item) => ({ ...item, status: "cancelled", content: "已停止" }));
            return;
        }
        updateOriginAssistant((item) => applyGenerationFailureToMessage(item, error, boundTasks, mode === "video" ? videoOperation : mode, assistantMessage.createdAt));
    } finally {
        for (const taskId of boundTaskIds) activeGenerationTaskIdsSet.delete(taskId);
        requestLifecycle.release();
        releaseRetryLock();
        if (abortRef.current === controller) {
            abortRef.current = null;
            setBusy(false);
        }
    }
}
