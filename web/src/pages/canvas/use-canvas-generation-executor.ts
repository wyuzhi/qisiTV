import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { createClientId } from "@/lib/client-id";
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";

import { compileNodeGenerationReferences, buildNodeGenerationContext, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { buildVideoGenerationMetadata, isGenerationCanceled, MISSING_GENERATION_TASK_IDENTITY_DETAILS } from "@/lib/canvas/canvas-project-generation";
import { buildConfirmedGenerationConfig } from "./canvas-assistant-proposal-execution";
import type { ConfirmedGenerationInputs } from "./canvas-assistant-proposal-snapshot";
import { canReleaseCanvasGenerationSource, canvasGenerationPromptMetadata, canvasGenerationRequestFingerprint, runCanvasGenerationSubmissionOnce } from "@/lib/canvas/canvas-generation-submission";
import { resolvedCanvasGenerationRequirements } from "@/lib/canvas/canvas-generation-config";
import { isGenerationTaskCapacityError } from "@/lib/canvas/canvas-generation-batch";
import { buildPortraitTexturePrompt } from "@/lib/canvas/canvas-portrait-texture";
import { buildCameraPrompt } from "@/lib/canvas/camera-prompt-library";
import { buildTextRewritePrompt } from "@/lib/prompts";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { generationErrorMessage } from "@/lib/generation-error";
import { navigateToSettings } from "@/lib/settings-navigation";
import { modelGroupReferenceLimits, modelRequestOptions, type ModelRequirements } from "@/lib/model-selection";
import { referencedAssetIdsInPrompt } from "@/lib/canvas/canvas-resource-references";
import type { Skill } from "@/services/api/skills";
import { skillRuntime } from "@/services/skill-runtime";
import { loadWorkspaceAssetsForUse } from "@/services/workspace-asset-read";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { findGenerationTaskByOperation, queryGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { useConfigStore, useEffectiveConfig, resolveModelRequestConfig } from "@/stores/use-config-store";
import { seedanceReferenceRatioWarning } from "@/lib/seedance-channel-warning";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

import { executeImageGeneration } from "./canvas-image-generation-executor";
import { executeAudioGeneration, executeVideoGeneration } from "./canvas-media-generation-executors";
import { executeTextGeneration } from "./canvas-text-generation-executor";
import { canvasGenerationFailureMetadata, canvasImagePendingResultMessage } from "./canvas-generation-failure";
import { canvasNodeHasPendingOutcomeResult, isNodeRegenerateBlocked, isNodeRegenerateConfirm, readNodeTaskOutcome, taskOutcomeCopy } from "@/lib/task-outcome";
import { createReferenceLinkResolver } from "@/components/generation-reference-links";
import { emitPluginEvent } from "@/lib/plugins/plugin-events";
import { runGenerationBeforeSubmitHooks } from "@/lib/plugins/slot-registry";
import { confirmCanvasGeneration, waitForCanvasPreparation } from "./canvas-generation-preflight";
import { startOperation } from "@/stores/use-operation-progress";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";

type UseCanvasGenerationExecutorOptions = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    domainProjectId?: string;
    addedSkills: Skill[];
    assets: Asset[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
    applyGenerationTaskResult: (targetNodeId: string, task: GenerationTask) => Promise<void>;
};

const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export type CanvasNodeGenerationOptions = {
    confirmedModelKey?: string;
    confirmedInputs?: ConfirmedGenerationInputs;
    /** 一次确认的稳定身份。重复提交必须复用，服务端据此回读原任务。 */
    clientOperationId?: string;
    controller?: AbortController;
    waitForTaskCapacity?: boolean;
    context?: { conversationId?: string; messageId?: string };
    retryContext?: { retryOf: string; attemptGroupId: string; clientOperationId: string };
    onTaskUpdate?: (task: GenerationTask) => void;
    onSubmissionPlan?: (manifest: import("@/services/api/assistant-continuation").AssistantSubmissionManifest) => Promise<void>;
    skipDuplicateConfirmation?: boolean;
};

export function useCanvasGenerationExecutor({
    pageUi,
    projectId,
    domainProjectId,
    addedSkills,
    assets,
    nodesRef,
    connectionsRef,
    setNodes,
    setConnections,
    setRunningNodeId,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
    applyGenerationTaskResult,
}: UseCanvasGenerationExecutorOptions) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const submissionLocksRef = useRef(new Map<string, Promise<unknown>>());
    const confirmDuplicateSubmission = useCallback(
        (signal: AbortSignal) =>
            confirmCanvasGeneration((callbacks) => modal.confirm({
                    title: "再次生成相同内容？",
                    content: "当前节点已使用相同提示词、模型、参数和参考素材提交过任务。再次生成会新建任务，并可能再次消耗积分。",
                    okText: "仍然生成",
                    cancelText: "取消",
                    centered: true,
                    ...callbacks,
                }), signal),
        [modal],
    );

    return useCallback(
        (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, options?: CanvasNodeGenerationOptions) =>
            runCanvasGenerationSubmissionOnce(
                submissionLocksRef.current,
                nodeId,
                async (releaseSubmission) => {
                    let stage = "validation";
                    const attemptId = createClientId();
                    let preparing = false;
                    let preparationProgress: ReturnType<typeof startOperation> | undefined;
                    let sourceReleased = false;
                    let selectedModel = options?.confirmedModelKey || "";
                    let refSummary = "";
                    const startedAt = performance.now();
                    const diagnostic = (code: string, level: "info" | "warning" | "error" = "info", detail = "") => {
                        const meta = [ `mode=${mode}`, selectedModel ? `model=${selectedModel}` : "", refSummary, detail ].filter(Boolean).join(" ");
                        recordDiagnosticEvent({
                            category: "action", level, code, reason: stage, canvasId: projectId, requestId: attemptId,
                            message: meta ? `画布生成提交：${code} (${meta})` : `画布生成提交：${code}`, durationMs: Math.round(performance.now() - startedAt),
                        });
                    };
                    diagnostic("generation_submit_started");
                    const controller = options?.controller ?? new AbortController();
                    const preparationMessageKey = `canvas-generation-preparation-${attemptId}`;
                    const setPreflightNotice = (errText: string) => {
                        setNodes((current) => current.map((node) => node.id === nodeId
                            ? { ...node, metadata: { ...node.metadata, generationPreflightError: errText } }
                            : node));
                    };
                    const reportError = (error: unknown) => {
                        if (controller.signal.aborted || isGenerationCanceled(error)) return;
                        const errText = generationErrorMessage(error);
                        diagnostic(error instanceof Error && error.name === "CanvasPreparationTimeoutError" ? "generation_preflight_timeout" : "generation_preflight_failed", "error", errText);
                        if (["validation", "references", "skills", "parameters"].includes(stage)) {
                            setPreflightNotice(errText);
                        }
                        message.error(errText);
                    };
                    try {
                        controller.signal.throwIfAborted();
                        const frozen = structuredClone(options?.confirmedInputs ?? { nodes: nodesRef.current, connections: connectionsRef.current, config: effectiveConfig, assets, skills: addedSkills });
                        const inputNodes = frozen.nodes;
                        const inputConnections = frozen.connections;
                        const inputConfig = frozen.config;
                        let inputAssets = frozen.assets;
                        const inputSkills = frozen.skills;
                        const sourceNode = inputNodes.find((node) => node.id === nodeId);
                        const pendingSubmissions = nodesRef.current.filter((node) => (node.id === nodeId || node.metadata?.generatedFromNodeId === nodeId) && ["submitting", "unknown"].includes(node.metadata?.generationSubmissionState || ""));
                        if (pendingSubmissions.length) {
                            startGenerationRequest(nodeId, nodeId, nodeId, controller);
                            for (const target of pendingSubmissions) {
                                const taskId = target.metadata?.taskId;
                                const operationId = target.metadata?.taskClientOperationId;
                                if (!taskId && !operationId?.trim()) throw new Error(MISSING_GENERATION_TASK_IDENTITY_DETAILS);
                                const task = taskId
                                    ? await queryGenerationTask(taskId, { signal: controller.signal })
                                    : await findGenerationTaskByOperation(operationId!, projectId, controller.signal);
                                controller.signal.throwIfAborted();
                                if (!task) {
                                    const warningText = "尚未查到上次提交的任务，请稍后再查询，暂勿重新生成";
                                    setPreflightNotice(warningText);
                                    message.warning(warningText);
                                    continue;
                                }
                                if (task.projectId && task.projectId !== projectId) throw new Error("生成任务不属于当前画布");
                                bindGenerationTask(target.id, task);
                                const completed = await waitForGenerationTask(task.id, { signal: controller.signal, initialTask: task, onTaskUpdate: (update) => bindGenerationTask(target.id, update) });
                                controller.signal.throwIfAborted();
                                await applyGenerationTaskResult(target.id, completed);
                            }
                            return;
                        }
                        const liveNode = nodesRef.current.find((node) => node.id === nodeId);
                        const guardNode = liveNode ?? sourceNode;
                        if (mode === "image" && (canvasNodeHasPendingOutcomeResult(guardNode, nodesRef.current) || canvasNodeHasPendingOutcomeResult(sourceNode, inputNodes))) {
                            diagnostic("generation_pending_result", "warning");
                            const pendingText = canvasImagePendingResultMessage(guardNode, nodesRef.current);
                            setPreflightNotice(pendingText);
                            message.warning(pendingText);
                            return;
                        }
                        if (isCanvasNodeGenerating(liveNode)) {
                            diagnostic("generation_task_active", "warning");
                            message.info("该节点的生成任务仍在进行中，请等待完成后再生成");
                            return;
                        }
                        if (isNodeRegenerateBlocked(guardNode?.metadata) || isNodeRegenerateBlocked(sourceNode?.metadata)) {
                            diagnostic("generation_retry_blocked", "warning");
                            const blockedMeta = isNodeRegenerateBlocked(guardNode?.metadata) ? guardNode?.metadata : sourceNode?.metadata;
                            const blockedText = blockedMeta?.errorDetails || taskOutcomeCopy(readNodeTaskOutcome(blockedMeta)).message;
                            setPreflightNotice(blockedText);
                            message.warning(blockedText);
                            return;
                        }
                        if (sourceNode?.type === CanvasNodeType.Video && sourceNode.metadata?.videoEditOperation === "concat") {
                            diagnostic("generation_concat_source", "warning");
                            const concatText = "合并成片节点不直接重新生成，请重新选择源视频合并";
                            setPreflightNotice(concatText);
                            message.info(concatText);
                            return;
                        }
                        let generationConfig: ReturnType<typeof buildConfirmedGenerationConfig>;
                        try {
                            generationConfig = buildConfirmedGenerationConfig(inputConfig, sourceNode, mode, undefined, options?.confirmedModelKey);
                            selectedModel = generationConfig.model;
                        } catch (error) {
                            reportError(error);
                            return;
                        }
                        const hasLiveBatchChildren =
                            sourceNode?.type === CanvasNodeType.Image && (sourceNode.metadata?.batchChildIds || []).some((childId) => inputNodes.some((node) => node.id === childId && node.metadata?.batchRootId === sourceNode.id));
                        const hasStaleImageBatchState =
                            mode === "image" && sourceNode?.type === CanvasNodeType.Image && !sourceNode.metadata?.content && Boolean(sourceNode.metadata?.isBatchRoot || sourceNode.metadata?.batchChildIds?.length) && !hasLiveBatchChildren;
                        if (hasStaleImageBatchState) {
                            setNodes((current) =>
                                current.map((node) => {
                                    if (node.id !== sourceNode.id) return node;
                                    const metadata = { ...node.metadata };
                                    delete metadata.isBatchRoot;
                                    delete metadata.batchChildIds;
                                    delete metadata.primaryImageId;
                                    delete metadata.imageBatchExpanded;
                                    delete metadata.batchUsesReferenceImages;
                                    return { ...node, metadata };
                                }),
                            );
                        }
                        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                            diagnostic("generation_config_missing", "warning");
                            navigateToSettings({ continueCreation: true });
                            return;
                        }

                        const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
                        const editingTextNode = mode === "text" && Boolean(sourceTextContent);
                        let generationPrompt = mode === "image" && sourceNode?.metadata?.portraitTexture ? buildPortraitTexturePrompt(prompt, sourceNode.metadata.portraitTexture) : prompt;
                        if (mode === "image" && sourceNode?.metadata?.cameraControl?.enabled) {
                            const cameraControl = sourceNode.metadata.cameraControl;
                            const cameraPrompt = buildCameraPrompt({ cameraId: cameraControl.camera, lensId: cameraControl.lens, focalLengthMm: cameraControl.focalLength, apertureF: cameraControl.aperture });
                            generationPrompt = `${generationPrompt}\n${cameraPrompt}`;
                        }
                        const isPreparingEmptyImage = mode === "image" && sourceNode?.type === CanvasNodeType.Image && !sourceNode.metadata?.content;

                        let rawGenerationContext: Awaited<ReturnType<typeof hydrateNodeGenerationContext>>;
                        startGenerationRequest(nodeId, nodeId, nodeId, controller);
                        preparing = true;
                        setRunningNodeId(nodeId);
                        if (mode === "video") preparationProgress = startOperation("准备视频素材", { target: { projectId, nodeId }, detail: "正在准备参考素材" });
                        else message.loading({ key: preparationMessageKey, content: "正在准备参考素材…", duration: 0 });
                        stage = "references";
                        setNodes((current) => current.map((node) => node.id === nodeId && node.metadata?.generationPreflightError
                            ? { ...node, metadata: { ...node.metadata, generationPreflightError: undefined } }
                            : node));
                        diagnostic("generation_preflight_stage");
                        // 视频协议只保留输入框文本（显式 @文本 引用仍会展开为真实内容）。
                        const promptOnly = mode === "video";
                        try {
                            // 素材库列表按需加载，显式引用不能仅凭是否出现在列表中判断失效。
                            const missingAssetIds = referencedAssetIdsInPrompt(generationPrompt).filter((id) => !inputAssets.some((asset) => asset.id === id));
                            if (missingAssetIds.length) {
                                await waitForCanvasPreparation(() => loadWorkspaceAssetsForUse(missingAssetIds), controller.signal);
                                const loaded = useAssetStore.getState().assets.filter((asset) => missingAssetIds.includes(asset.id));
                                inputAssets = [...inputAssets, ...structuredClone(loaded)];
                            }
                            const baseContext = buildNodeGenerationContext(
                                nodeId,
                                inputNodes,
                                inputConnections,
                                editingTextNode ? buildTextRewritePrompt(sourceTextContent, prompt) : generationPrompt,
                                inputAssets,
                                promptOnly,
                                { preserveMediaBindings: mode === "video" },
                            );
                            const requirements = generationModelRequirements(mode, baseContext, sourceNode, generationConfig, true);
                            if (requirements?.input) {
                                const { imageCount = 0, videoCount = 0, audioCount = 0, characterCount = 0 } = requirements.input;
                                refSummary = `refs=i:${imageCount},v:${videoCount},a:${audioCount},c:${characterCount}`;
                            }
                            generationConfig = buildConfirmedGenerationConfig(inputConfig, sourceNode, mode, requirements, options?.confirmedModelKey);
                            selectedModel = generationConfig.model;
                            const referenceLimits = modelGroupReferenceLimits(inputConfig, generationConfig.model, mode, requirements);
                            rawGenerationContext = await waitForCanvasPreparation(() => hydrateNodeGenerationContext(baseContext, projectId, domainProjectId, mode, mode === "video" && Boolean(referenceLimits?.maxAudios), !promptOnly && mode !== "audio", referenceLimits), controller.signal);
                            const hydratedRequirements = generationModelRequirements(mode, rawGenerationContext, sourceNode, generationConfig);
                            if (hydratedRequirements?.input) {
                                const { imageCount = 0, videoCount = 0, audioCount = 0, characterCount = 0 } = hydratedRequirements.input;
                                refSummary = `refs=i:${imageCount},v:${videoCount},a:${audioCount},c:${characterCount}`;
                            }
                            generationConfig = buildConfirmedGenerationConfig(inputConfig, sourceNode, mode, hydratedRequirements, options?.confirmedModelKey);
                            selectedModel = generationConfig.model;
                        } catch (error) {
                            reportError(error);
                            return;
                        }

                        let skillExecution: Awaited<ReturnType<typeof skillRuntime.prepare<"canvas">>>;
                        stage = "skills";
                        diagnostic("generation_preflight_stage");
                        try {
                            skillExecution = await waitForCanvasPreparation(() => skillRuntime.prepare({ profile: "canvas", prompt: rawGenerationContext.prompt, skills: inputSkills }), controller.signal);
                        } catch (error) {
                            reportError(error);
                            return;
                        }
                        let effectivePrompt = skillExecution.prompt.trim();
                        if (mode === "video") {
                            rawGenerationContext = compileNodeGenerationReferences({ ...rawGenerationContext, prompt: effectivePrompt }, generationConfig, buildVideoGenerationMetadata(sourceNode, rawGenerationContext, generationConfig).videoEditOperation);
                            effectivePrompt = rawGenerationContext.prompt;
                        }
                        stage = "parameters";
                        let styleMetadata: Record<string, unknown> = {};
                        if (mode === "image" || mode === "video" || mode === "audio") {
                            const hookResult = await runGenerationBeforeSubmitHooks({
                                nodeId,
                                nodeType: mode,
                                prompt: effectivePrompt,
                                model: generationConfig.model,
                                params: { size: generationConfig.size, quality: generationConfig.quality },
                                referenceImages: rawGenerationContext.referenceImages.map((item) => item.url || item.dataUrl || "").filter(Boolean),
                                metadata: sourceNode?.metadata as Record<string, unknown> | undefined,
                            });
                            effectivePrompt = hookResult.prompt;
                            if (hookResult.notifications.length > 0) {
                                for (const note of hookResult.notifications) {
                                    message.info(note);
                                }
                                styleMetadata = {
                                    ...styleMetadata,
                                    ...hookResult.metadata,
                                    pluginAdjustedBy: hookResult.adjustedByPlugins.map((item) => item.pluginName),
                                };
                            }
                        }
                        if (mode === "image") {
                            try {
                                const styleRuntime = resolveCanvasStyleExecution(inputNodes, sourceNode, effectivePrompt, generationConfig, mode);
                                if (styleRuntime) {
                                    effectivePrompt = styleRuntime.prompt;
                                    styleMetadata = { styleProfileJson: styleRuntime.profileJson, styleExecutionPlan: styleRuntime.plan };
                                }
                            } catch (error) {
                                reportError(error);
                                return;
                            }
                        }
                        const generationContext = { ...rawGenerationContext, prompt: effectivePrompt };
                        if (isNodeRegenerateConfirm(sourceNode?.metadata) && modal?.confirm) {
                            const copy = taskOutcomeCopy(readNodeTaskOutcome(sourceNode?.metadata));
                            stage = "duplicate_confirmation";
                            diagnostic("generation_confirmation_waiting");
                            const confirmed = await confirmCanvasGeneration(
                                (callbacks) =>
                                    modal.confirm({
                                        title: copy.confirmTitle || "确认重新生成？",
                                        content: copy.confirmContent || copy.message,
                                        okText: "确认重新生成",
                                        cancelText: "取消",
                                        centered: true,
                                        ...callbacks,
                                    }),
                                controller.signal,
                            );
                            if (!confirmed) {
                                diagnostic("generation_confirmation_cancelled");
                                return;
                            }
                        }
                        if (mode === "audio" && generationContext.characterReferences.length) {
                            if (generationContext.characterReferences.length !== 1) {
                                reportError(new Error("角色配音一次只能引用一个角色卡"));
                                return;
                            }
                            const voice = generationContext.resolvedCharacterVoices[0];
                            const hasReferenceMedia = generationContext.referenceImages.length > 0 || generationContext.referenceAudios.length > 0;
                            if (!voice && !hasReferenceMedia) {
                                reportError(new Error("角色尚未绑定可用声音，无法创建角色配音任务"));
                                return;
                            }
                            if (voice) {
                                generationConfig = { ...generationConfig, audioVoice: voice.voiceKey || generationConfig.audioVoice, audioInstructions: [voice.instructions, generationConfig.audioInstructions].filter(Boolean).join("；") };
                            }
                        }
                        if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                            reportError(new Error("请输入生成内容"));
                            return;
                        }

                        const requestFingerprint = canvasGenerationRequestFingerprint({
                            nodeId,
                            mode,
                            prompt: effectivePrompt,
                            model: generationConfig.model,
                            options: modelRequestOptions(generationConfig, mode),
                            operation: sourceNode?.metadata?.videoEditOperation,
                            audioInstructions: generationConfig.audioInstructions,
                            promptTemplateOperation: sourceNode?.metadata?.promptTemplateOperation,
                            promptTemplateVariables: sourceNode?.metadata?.promptTemplateVariables,
                            context: generationContext,
                        });
                        const duplicateConfirmationRequired = !options?.skipDuplicateConfirmation && !options?.retryContext && sourceNode?.metadata?.lastGenerationRequestFingerprint === requestFingerprint;
                        message.destroy(preparationMessageKey);
                        stage = "duplicate_confirmation";
                        if (duplicateConfirmationRequired) {
                            diagnostic("generation_confirmation_waiting");
                            if (!(await confirmDuplicateSubmission(controller.signal))) {
                                diagnostic("generation_confirmation_cancelled");
                                return;
                            }
                        }

                        const ratioWarning = mode === "video" ? seedanceReferenceRatioWarning({
                            ...resolveModelRequestConfig(generationConfig, generationConfig.model),
                            videoCount: generationContext.referenceVideos.length,
                            ratio: generationConfig.size,
                            operation: sourceNode?.metadata?.videoEditOperation,
                        }) : undefined;
                        if (ratioWarning) {
                            stage = "ratio_confirmation";
                            diagnostic("generation_confirmation_waiting");
                            const accepted = await confirmCanvasGeneration((callbacks) => modal.confirm({ ...ratioWarning, centered: true, ...callbacks }), controller.signal);
                            if (!accepted) {
                                diagnostic("generation_confirmation_cancelled");
                                return;
                            }
                        }

                        controller.signal.throwIfAborted();
                        stage = "dispatch";
                        preparationProgress?.dismiss();
                        diagnostic("generation_dispatch_started");
                        if (isPreparingEmptyImage) {
                            setNodes((current) =>
                                current.map((node) =>
                                    node.id === nodeId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  prompt,
                                                  composerContent: prompt,
                                                  status: NODE_STATUS_LOADING,
                                                  taskStage: "正在准备生成任务",
                                                  taskProgress: 0,
                                                  taskCreatedAt: new Date().toISOString(),
                                                  errorDetails: undefined,
                                                  generationErrorCode: undefined,
                                                  generationErrorSummary: undefined,
                                                  generationProviderCode: undefined,
                                                  taskFailureDiagnostics: undefined,
                                                  taskOutcome: undefined,
                                                  failedPromptFingerprint: undefined,
                                                  failedInputFingerprint: undefined,
                                              },
                                          }
                                        : node,
                                ),
                            );
                        }

                        // 已有内容节点只是本次生成的来源；任务状态归新目标所有，不能覆盖已成功结果。
                        const markSourceStatus = !sourceNode?.metadata?.content && !editingTextNode;
                        const hasPreviousResult = Boolean(sourceNode?.metadata?.content || sourceNode?.metadata?.storageKey);
                        const statusPrompt = sourceNode?.type === CanvasNodeType.Config ? effectivePrompt : prompt;
                        if (markSourceStatus)
                            setNodes((current) =>
                                current.map((node) =>
                                    node.id === nodeId
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, ...canvasGenerationPromptMetadata(prompt, statusPrompt), status: NODE_STATUS_LOADING, errorDetails: undefined, generationErrorCode: undefined, generationErrorSummary: undefined, generationProviderCode: undefined, taskFailureDiagnostics: undefined, taskOutcome: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined },
                                          }
                                        : node,
                                ),
                            );

                        let pendingNodeIds: string[] = [];
                        const boundTaskIds = new Set<string>();
                        const execution = {
                            pageUi,
                            projectId,
                            nodesRef,
                            nodeId,
                            sourceNode,
                            // 收费输入保持确认时的快照；目标节点写回必须使用当前画布。
                            // 另一目标可能已在重复生成确认等待期间完成，不能把整图回滚到旧结果。
                            canvasNodes: nodesRef.current,
                            canvasConnections: connectionsRef.current,
                            prompt,
                            effectivePrompt,
                            generationConfig,
                            generationContext,
                            controller,
                            editingTextNode,
                            styleMetadata,
                            skillMetadata: skillExecution.metadata,
                            taskContext: options?.context,
                            retryContext: options?.retryContext,
                            onSubmissionPlan: options?.onSubmissionPlan,
                                clientOperationId:
                                    options?.clientOperationId ||
                                    options?.retryContext?.clientOperationId ||
                                    (sourceNode?.metadata?.taskClientOperationId && !sourceNode?.metadata?.taskId ? sourceNode.metadata.taskClientOperationId : undefined) ||
                                    `canvas:${createClientId()}`,
                            setNodes,
                            setConnections,
                            startGenerationRequest,
                            finishGenerationRequest,
                            bindGenerationTask: (targetNodeId: string, task: GenerationTask) => {
                                const firstBinding = boundTaskIds.size === 0;
                                if (!boundTaskIds.has(task.id)) {
                                    boundTaskIds.add(task.id);
                                    recordDiagnosticEvent({ category: "task", level: "info", code: "generation_submission_bound", message: "画布提交已关联生成任务", requestId: attemptId, canvasId: projectId, taskId: task.id, canvasBinding: { source: "client", nodeId: targetNodeId, clientOperationId: task.clientOperationId } });
                                    emitPluginEvent("generation.submitted", { nodeId: targetNodeId, nodeType: mode, model: generationConfig.model, prompt: effectivePrompt, taskId: task.id });
                                }
                                bindGenerationTask(targetNodeId, task);
                                if (!sourceReleased && !controller.signal.aborted && canReleaseCanvasGenerationSource(nodeId, targetNodeId, task)) {
                                    sourceReleased = true;
                                    preparing = false;
                                    finishGenerationRequest(nodeId, controller);
                                    setRunningNodeId((current) => current === nodeId ? null : current);
                                    releaseSubmission();
                                }
                                if (firstBinding) setNodes((current) => {
                                    const source = current.find((node) => node.id === nodeId);
                                    if (!source || source.metadata?.lastGenerationRequestFingerprint === requestFingerprint) return current;
                                    return current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, lastGenerationRequestFingerprint: requestFingerprint } } : node));
                                });
                                options?.onTaskUpdate?.(task);
                            },
                            applyGenerationTaskResult,
                            showError: (content: string) => message.error(content),
                            resolveReferenceLinks: createReferenceLinkResolver(modal),
                            registerPendingNodeIds: (nodeIds: string[]) => {
                                pendingNodeIds = nodeIds;
                            },
                        };

                        try {
                            if (mode === "image") await executeImageGeneration(execution);
                            else if (mode === "video") await executeVideoGeneration(execution);
                            else if (mode === "audio") await executeAudioGeneration(execution);
                            else await executeTextGeneration(execution);
                            emitPluginEvent("generation.completed", { nodeId, nodeType: mode });
                        } catch (error) {
                            if (isGenerationCanceled(error)) return;
                            const failure = canvasGenerationFailureMetadata(error, { ...generationContext, mode });
                            emitPluginEvent("generation.failed", { nodeId, nodeType: mode, error: failure.errorDetails });
                            if (options?.waitForTaskCapacity && isGenerationTaskCapacityError(error)) {
                                setNodes((current) =>
                                    current.map((node) => {
                                        if (node.id !== nodeId && !pendingNodeIds.includes(node.id)) return node;
                                        const metadata = { ...(node.metadata || {}), status: NODE_STATUS_IDLE, errorDetails: undefined };
                                        delete metadata.taskId;
                                        delete metadata.taskStatus;
                                        delete metadata.taskProgress;
                                        delete metadata.taskStage;
                                        delete metadata.taskCreatedAt;
                                        delete metadata.taskUpdatedAt;
                                        delete metadata.taskStartedAt;
                                        delete metadata.taskCompletedAt;
                                        delete metadata.taskDurationMs;
                                        return { ...node, metadata };
                                    }),
                                );
                                return;
                            }
                            message.error(failure.errorDetails);
                            setNodes((current) =>
                                current.map((node) => {
                                    if (node.id !== nodeId && !pendingNodeIds.includes(node.id)) return node;
                                    if (node.id === nodeId && !pendingNodeIds.includes(node.id)) {
                                        if (sourceReleased) return node;
                                        if (hasPreviousResult) {
                                            return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined, generationErrorCode: undefined, generationErrorSummary: undefined, generationProviderCode: undefined, taskFailureDiagnostics: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined } };
                                        }
                                        if (!markSourceStatus) return node;
                                    }
                                    return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, ...failure } };
                                }),
                            );
                        }
                    } catch (error) {
                        reportError(error);
                    } finally {
                        diagnostic(controller.signal.aborted ? "generation_submission_aborted" : "generation_submission_finished");
                        message.destroy(preparationMessageKey);
                        finishGenerationRequest(nodeId, controller);
                        preparationProgress?.dismiss();
                        if (preparing) setRunningNodeId((current) => current === nodeId ? null : current);
                    }
                },
                () => {
                    recordDiagnosticEvent({ category: "action", level: "warning", code: "generation_duplicate_click", canvasId: projectId, message: "该节点已有生成请求正在提交或执行" });
                    message.info({ key: `canvas-generation-submission-${nodeId}`, content: "该节点已有生成请求正在提交或执行，请勿重复点击" });
                },
            ),
        [
            addedSkills,
            applyGenerationTaskResult,
            bindGenerationTask,
            confirmDuplicateSubmission,
            domainProjectId,
            effectiveConfig,
            finishGenerationRequest,
            isAiConfigReady,
            message,
            modal,
            nodesRef,
            connectionsRef,
            projectId,
            setConnections,
            setNodes,
            setRunningNodeId,
            startGenerationRequest,
        ],
    );
}


function generationModelRequirements(
    mode: CanvasNodeGenerationMode,
    input: Pick<Awaited<ReturnType<typeof hydrateNodeGenerationContext>>, "textCount" | "imageCount" | "videoCount" | "audioCount" | "characterReferences">,
    sourceNode: CanvasNodeData | undefined,
    config: ReturnType<typeof useEffectiveConfig>,
    includeCharacterMinimum = false,
): ModelRequirements {
    return resolvedCanvasGenerationRequirements(config, sourceNode, mode, {
            textCount: input.textCount,
            imageCount: input.imageCount,
            videoCount: input.videoCount,
            audioCount: input.audioCount,
            characterCount: includeCharacterMinimum ? input.characterReferences.length : 0,
    });
}
