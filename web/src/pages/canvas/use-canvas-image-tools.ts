import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { useAppProps } from "antd/es/app/context";
import { nanoid } from "nanoid";

import type { CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import type { CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import type { CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import type { CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { buildLightingLabel, type CanvasImageLightingOptions } from "@/components/canvas/canvas-node-lighting-dialog";
import type { CanvasImageEmotionPayload } from "@/components/canvas/canvas-node-emotion-panel";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { isValidGridSplit, layoutGridSplitCells } from "@/lib/canvas/canvas-grid-split";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { findAvailableGenerationGroupPosition, imageGenerationChildPosition, imageGenerationGroupSize } from "@/lib/canvas/canvas-generation-layout";
import { canvasGenerationPromptMetadata } from "@/lib/canvas/canvas-generation-submission";
import { cancelIncompleteImageBatch } from "@/lib/canvas/canvas-image-batch-retry";
import { buildAngleLabel, buildAnglePrompt, createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { buildGenerationConfig, buildImageGenerationMetadata, nodeReferenceImage, isGenerationCanceled, runBackendCanvasGenerationTask } from "@/lib/canvas/canvas-project-generation";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { compositeEmotionImage, emotionGenerationSize, emotionProviderMask, normalizeEmotionPromptForProvider, resolveEmotionEditPlan } from "@/lib/canvas/canvas-emotion";
import { DEFAULT_PORTRAIT_TEXTURE_SETTINGS } from "@/lib/canvas/canvas-portrait-texture";
import { IMAGE_PROMPT_REVERSE, VIDEO_PROMPT_REVERSE } from "@/lib/prompts";
import { createPortraitTextureNode } from "@/lib/canvas/canvas-image-source";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { generationErrorMessage } from "@/lib/generation-error";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { defaultImageParamsForModel, normalizeMaskEditQuality, normalizeMaskEditSize, resolveMaskEditModel } from "@/lib/model-selection";
import { navigateToSettings } from "@/lib/settings-navigation";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { GenerationTask } from "@/services/api/task-center";
import { defaultConfig, resolveModelRequestConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import type { createCanvasMediaOperation } from "./canvas-media-operation";

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const NODE_STATUS_IDLE = "idle" as const;

export type UseCanvasImageToolsOptions = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
    beginMediaOperation: () => ReturnType<typeof createCanvasMediaOperation>;
    persistMediaNodes: (mediaNodes: CanvasNodeData[], mediaConnections?: CanvasConnection[], options?: { signal?: AbortSignal }) => Promise<Map<string, string>>;
    message: useAppProps["message"];
};

export function useCanvasImageTools({
    pageUi, projectId, nodesRef, setNodes, setConnections, setRunningNodeId,
    startGenerationRequest, finishGenerationRequest, bindGenerationTask, beginMediaOperation, persistMediaNodes, message,
}: UseCanvasImageToolsOptions) {
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [annotationNodeId, setAnnotationNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [lightingNodeId, setLightingNodeId] = useState<string | null>(null);
    const [emotionNodeId, setEmotionNodeId] = useState<string | null>(null);

    const clearDeletedImageNodes = useCallback((removedIds: Set<string>) => {
        const clear = (current: string | null) => (current && removedIds.has(current) ? null : current);
        setCropNodeId(clear);
        setAnnotationNodeId(clear);
        setMaskEditNodeId(clear);
        setUpscaleNodeId(clear);
        setAngleNodeId(clear);
        setLightingNodeId(clear);
        setEmotionNodeId(clear);
    }, []);

    useEffect(() => {
        setCropNodeId(null);
        setAnnotationNodeId(null);
        setMaskEditNodeId(null);
        setUpscaleNodeId(null);
        setAngleNodeId(null);
        setLightingNodeId(null);
        setEmotionNodeId(null);
    }, [projectId]);

    const resolveImageEditStyle = useCallback((node: CanvasNodeData, prompt: string, config: AiConfig) => {
        try {
            const runtime = resolveCanvasStyleExecution(nodesRef.current, node, prompt, config, "image");
            return {
                prompt: runtime?.prompt || prompt,
                metadata: runtime ? { styleProfileJson: runtime.profileJson, styleExecutionPlan: runtime.plan } : {},
            };
        } catch (error) {
            message.error(generationErrorMessage(error));
            return null;
        }
    }, [message, nodesRef]);

    const createImageReversePromptNodes = useCallback((node: CanvasNodeData) => {
        const isVideo = node.type === CanvasNodeType.Video;
        if ((node.type !== CanvasNodeType.Image && !isVideo) || (!node.metadata?.content && !node.metadata?.storageKey)) {
            message.warning(isVideo ? "视频节点为空，无法反推提示词" : "图片节点为空，无法反推提示词");
            return;
        }
        const reverseInstruction = isVideo ? VIDEO_PROMPT_REVERSE : IMAGE_PROMPT_REVERSE;
        const gap = 96;
        const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
        const resultSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
        const centerY = node.position.y + node.height / 2;
        const textNode = {
            ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: reverseInstruction, prompt: reverseInstruction, status: NODE_STATUS_SUCCESS, fontSize: 14 }),
            title: isVideo ? "视频反推提示词" : "反推提示词",
        };
        const resultNode = {
            ...createCanvasNode(CanvasNodeType.Text, { x: textNode.position.x + textNode.width + gap + resultSpec.width / 2, y: centerY }, {
                content: "", generationMode: "text", model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                count: 1, composerContent: isVideo ? "参考视频：@视频1\n任务说明：@文本1" : "参考图片：@图片1\n任务说明：@文本1",
            }),
            title: isVideo ? "视频反推提示词结果" : "反推提示词结果",
        };
        setNodes((current) => [...current, textNode, resultNode]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: resultNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: resultNode.id }]);
        pageUi.getState().setSelectedNodeIds(new Set([resultNode.id]));
        pageUi.getState().setSelectedConnectionId(null);
        pageUi.getState().setDialogNodeId(resultNode.id);
        pageUi.getState().setContextMenu(null);
    }, [pageUi, projectId, effectiveConfig.model, effectiveConfig.textModel, message, setConnections, setNodes]);

    const openPortraitTextureEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
            message.warning("图片节点为空，无法调节人物质感");
            return;
        }
        const portraitTextureSettings = { ...DEFAULT_PORTRAIT_TEXTURE_SETTINGS, ...node.metadata?.portraitTexture };
        const child = createPortraitTextureNode(node, nanoid());
        child.metadata = { ...child.metadata, portraitTexture: portraitTextureSettings };
        const { setHoveredNodeId, setToolbarNodeId, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId } = pageUi.getState();
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setNodes((current) => [...current, child]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: child.id }]);
        setSelectedNodeIds(new Set([child.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(child.id);
    }, [pageUi, projectId, message, setConnections, setNodes]);

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        if (!node.metadata?.content) return;
        try {
            const source = await operation.wait(resolveImageUrl(node.metadata.storageKey, node.metadata.content, { cacheMiss: true }));
            const cropped = await operation.wait(cropDataUrl(source, crop));
            const image = await operation.wait(uploadImage(cropped));
            const size = fitNodeSize(image.width, image.height, node.width, node.height);
            const childId = nanoid();
            const child: CanvasNodeData = { id: childId, type: CanvasNodeType.Image, title: `${node.title || "图片"} · 裁剪`, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: size.width, height: size.height, metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, generatedFromNodeId: node.id,
                workflowOperation: { id: "image.crop", version: 1, config: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, inputs: [{ nodeId: node.id, port: "image" }] },
            }) };
            const connection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
            setNodes((current) => [...current, child]);
            setConnections((current) => [...current, connection]);
            pageUi.getState().setSelectedNodeIds(new Set([childId]));
            pageUi.getState().setDialogNodeId(childId);
            setCropNodeId(null);
            await operation.wait(persistMediaNodes([child], [connection], {}));
        } catch (error) {
            if (!operation.isCurrent()) return;
            message.error(error instanceof Error ? `裁切失败：${error.message}` : "裁切失败，请重试");
        }
    }, [beginMediaOperation, pageUi, projectId, message, persistMediaNodes, setConnections, setNodes]);

    const saveAnnotatedImageNode = useCallback(async (node: CanvasNodeData, dataUrl: string) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        try {
            const image = await operation.wait(uploadImage(dataUrl));
            const size = fitNodeSize(image.width, image.height, node.width, node.height);
            const childId = nanoid();
            const child: CanvasNodeData = { id: childId, type: CanvasNodeType.Image, title: `${node.title || "图片"} · 标注`, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: size.width, height: size.height, metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, generatedFromNodeId: node.id }) };
            const connection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
            setNodes((current) => [...current, child]);
            setConnections((current) => [...current, connection]);
            pageUi.getState().setSelectedNodeIds(new Set([childId]));
            pageUi.getState().setSelectedConnectionId(null);
            pageUi.getState().setDialogNodeId(null);
            setAnnotationNodeId(null);
            await operation.wait(persistMediaNodes([child], [connection], {}));
            message.success("标注图片已保存为新节点");
        } catch (error) {
            if (operation.isCurrent()) throw error;
        }
    }, [beginMediaOperation, pageUi, projectId, message, persistMediaNodes, setConnections, setNodes]);

    const splitImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        try {
            if (!node.metadata?.content || !isValidGridSplit(params)) return;
            const source = await operation.wait(resolveImageUrl(node.metadata.storageKey, node.metadata.content, { cacheMiss: true }));
            const pieces = await operation.wait(splitDataUrl(source, params));
            const sizedPieces = await operation.wait(Promise.all(pieces.map(async (piece) => {
                const image = await operation.wait(uploadImage(piece.dataUrl));
                return { piece, image, size: fitNodeSize(image.width, image.height) };
            })));
            const positions = layoutGridSplitCells(
                { x: node.position.x + node.width + 96, y: node.position.y },
                sizedPieces.map(({ piece, size }) => ({ row: piece.row, column: piece.column, width: size.width, height: size.height })),
            );
            const childNodes = sizedPieces.map(({ piece, image, size }, index) => ({
                id: nanoid(), type: CanvasNodeType.Image, title: `${node.title || "图片"} · 宫格 ${piece.row + 1}-${piece.column + 1}`,
                position: positions[index] || { x: node.position.x + node.width + 96, y: node.position.y }, width: size.width, height: size.height,
                metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, manualSize: true, generatedFromNodeId: node.id }),
            } satisfies CanvasNodeData));
            setNodes((current) => [...current, ...childNodes]);
            setConnections((current) => [...current, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            pageUi.getState().setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            pageUi.getState().setSelectedConnectionId(null);
            pageUi.getState().setDialogNodeId(null);
            await operation.wait(persistMediaNodes(childNodes, [], {}));
            message.success(`已切分为 ${childNodes.length} 个子节点`);
        } catch (error) {
            if (operation.isCurrent()) throw error;
        }
    }, [beginMediaOperation, pageUi, projectId, message, persistMediaNodes, setConnections, setNodes]);

    const maskEditImageNode = useCallback(async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        try {
            if (!node.metadata?.content) return;
            const baseGenerationConfig = buildGenerationConfig(effectiveConfig, node, "image");
            const requestedModel = payload.generationConfig?.model || payload.generationConfig?.imageModel || baseGenerationConfig.model;
            const selectedModel = resolveMaskEditModel(
                { ...effectiveConfig, ...baseGenerationConfig, imageModel: effectiveConfig.imageModel || baseGenerationConfig.imageModel, imageModels: effectiveConfig.imageModels, models: effectiveConfig.models },
                requestedModel,
            );
            const modelDefaults = defaultImageParamsForModel(baseGenerationConfig, selectedModel);
            const selectedImageProfile = modelCapabilityConfigFor(baseGenerationConfig, selectedModel).image;
            if (!selectedImageProfile?.references.maskSupported) {
                message.error("当前图片模型不支持局部重绘蒙版，请选择支持蒙版编辑的模型");
                return;
            }
            const explicitSize = payload.generationConfig?.size;
            const rawSize = explicitSize || node.metadata?.size || modelDefaults.size;
            const generationConfig = {
                ...baseGenerationConfig,
                ...payload.generationConfig,
                model: selectedModel,
                imageModel: selectedModel,
                quality: normalizeMaskEditQuality(payload.generationConfig?.quality || node.metadata?.quality || baseGenerationConfig.quality || modelDefaults.quality, rawSize, selectedImageProfile.quality?.supported ? selectedImageProfile.quality.values : [], modelDefaults.quality),
                count: String(payload.generationConfig?.count || 1),
                // 原图像素尺寸不是模型的输出尺寸合同；非高级设置时使用模型默认尺寸，避免把节点尺寸误发给上游。
                size: normalizeMaskEditSize(rawSize, selectedImageProfile.size?.values ?? [], modelDefaults.size, Boolean(explicitSize) && Boolean(selectedImageProfile.size?.allowCustom)),
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                navigateToSettings({ continueCreation: true });
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = `只修改蒙版透明区域，其他区域保持不变。${userPrompt}`;
            const source = nodeReferenceImage(node);
            if (!source) return;
            const styleExecution = resolveImageEditStyle(node, prompt, generationConfig);
            if (!styleExecution) return;
            const { prompt: effectivePrompt, metadata: styleMetadata } = styleExecution;
            const requestedCount = Math.max(1, Number(generationConfig.count) || 1);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, requestedCount, [source]);
            setMaskEditNodeId(null);
            const rootId = nanoid();
            const childIds = requestedCount > 1 ? Array.from({ length: requestedCount }, () => nanoid()) : [];
            const targetIds = requestedCount > 1 ? childIds : [rootId];
            const imageSize = { width: node.width, height: node.height };
            const preferredPosition = { x: node.position.x + node.width + 96, y: node.position.y };
            const rootPosition = findAvailableGenerationGroupPosition(nodesRef.current, preferredPosition, imageGenerationGroupSize(imageSize, imageSize, childIds.length));
            const rootNode: CanvasNodeData = {
                id: rootId, type: CanvasNodeType.Image, title: userPrompt.slice(0, 32) || "局部编辑结果",
                position: rootPosition, width: node.width, height: node.height,
                metadata: {
                    ...canvasGenerationPromptMetadata(userPrompt, effectivePrompt), status: NODE_STATUS_LOADING,
                    isBatchRoot: requestedCount > 1, batchChildIds: requestedCount > 1 ? childIds : undefined,
                    batchFailedCount: requestedCount > 1 ? 0 : undefined,
                    imageBatchExpanded: requestedCount > 1 ? true : undefined,
                    ...generationMetadata, ...styleMetadata,
                },
            };
            const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                id, type: CanvasNodeType.Image, title: `${userPrompt.slice(0, 28) || "局部编辑结果"} · ${index + 1}`,
                position: imageGenerationChildPosition(rootNode.position, rootNode.width, imageSize, index),
                width: node.width, height: node.height,
                metadata: {
                    ...canvasGenerationPromptMetadata(userPrompt, effectivePrompt), status: NODE_STATUS_LOADING,
                    batchRootId: rootId, ...generationMetadata, ...styleMetadata,
                },
            }));
            setRunningNodeId(rootId);
            setNodes((current) => [...current, rootNode, ...childNodes]);
            setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: rootId }, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId }))]);
            pageUi.getState().setSelectedNodeIds(new Set([rootId, ...childIds]));
            pageUi.getState().setSelectedConnectionId(null);
            pageUi.getState().setDialogNodeId(rootId);
            const controller = startGenerationRequest(rootId, node.id, rootId);
            targetIds.forEach((targetId) => startGenerationRequest(targetId, node.id, rootId, controller));
            let hasSuccess = false;
            let failureCount = 0;
            let representativeError: string | undefined;
            try {
                await operation.wait(Promise.all(targetIds.map(async (targetId) => {
                    try {
                        const result = await operation.wait(runBackendCanvasGenerationTask({
                            projectId, nodeId: targetId, mode: "image", prompt: effectivePrompt,
                            config: { ...generationConfig, count: "1" }, referenceImages: [source],
                            mask: { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl },
                            signal: controller.signal, metadata: { sourceNodeId: node.id, edit: "mask", ...styleMetadata },
                            onTaskCreated: (task) => operation.run(() => bindGenerationTask(targetId, task)),
                        }));
                        const image = result.images?.find((item) => item?.dataUrl);
                        if (!image?.dataUrl) throw new Error("后端任务没有返回图片");
                        const uploaded = await operation.wait(uploadImage(image.dataUrl));
                        const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                        const currentNode = nodesRef.current.find((item) => item.id === targetId);
                        if (!currentNode) throw new Error("局部编辑节点已被删除");
                        const finalizedNode = { ...currentNode, width: size.width, height: size.height, metadata: { ...currentNode.metadata, ...imageMetadata(uploaded), prompt: effectivePrompt, ...generationMetadata } };
                        setNodes((current) => current.map((item) => {
                            if (item.id === targetId) return finalizedNode;
                            if (item.id !== rootId || requestedCount <= 1 || item.metadata?.primaryImageId) return item;
                            return { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), primaryImageId: targetId, status: NODE_STATUS_SUCCESS } };
                        }));
                        await operation.wait(persistMediaNodes([finalizedNode], [], {}));
                        hasSuccess = true;
                    } catch (error) {
                        if (!operation.isCurrent()) return;
                        if (isGenerationCanceled(error)) return;
                        failureCount += 1;
                        const details = generationErrorMessage(error);
                        representativeError = details;
                        setNodes((current) => current.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : item)));
                    } finally {
                        if (operation.isCurrent()) finishGenerationRequest(targetId, controller);
                    }
                })));
                if (controller.signal.aborted) {
                    setNodes((current) => {
                        const cancelled = cancelIncompleteImageBatch(rootId, childIds, current, []);
                        if (cancelled.removedIds.length) {
                            const removed = new Set(cancelled.removedIds);
                            setConnections((connections) => connections.filter((connection) => !removed.has(connection.fromNodeId) && !removed.has(connection.toNodeId)));
                        }
                        return cancelled.nodes.map((item) => {
                            if (item.id !== rootId || item.metadata?.content) return item;
                            return { ...item, metadata: { ...item.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } };
                        });
                    });
                    return;
                }
                if (failureCount > 0) message.error(hasSuccess ? "部分局部编辑失败" : representativeError || "局部编辑失败");
                setNodes((current) => current.map((item) => {
                    if (item.id !== rootId) return item;
                    return {
                        ...item,
                        metadata: {
                            ...item.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                            batchFailedCount: requestedCount > 1 ? failureCount : undefined,
                            ...(hasSuccess ? { errorDetails: undefined } : { errorDetails: representativeError || "局部编辑失败" }),
                        },
                    };
                }));
            } finally {
                if (operation.isCurrent()) {
                    if (requestedCount > 1) finishGenerationRequest(rootId, controller);
                    setRunningNodeId(null);
                }
            }
        } catch (error) {
            if (operation.isCurrent()) throw error;
        }
    }, [beginMediaOperation, pageUi, bindGenerationTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, nodesRef, persistMediaNodes, projectId, resolveImageEditStyle, setConnections, setNodes, setRunningNodeId, startGenerationRequest]);

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        try {
            if (!node.metadata?.content) return;
            setUpscaleNodeId(null);
            const source = await operation.wait(resolveImageUrl(node.metadata.storageKey, node.metadata.content, { cacheMiss: true }));
            const upscaled = await operation.wait(upscaleDataUrl(source, params));
            const image = await operation.wait(uploadImage(upscaled));
            const size = fitNodeSize(image.width, image.height);
            const childId = nanoid();
            const child: CanvasNodeData = { id: childId, type: CanvasNodeType.Image, title: `${node.title || "图片"} · 放大`, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: size.width, height: size.height, metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, generatedFromNodeId: node.id,
                workflowOperation: { id: "image.resize", version: 1, config: { longEdge: params.targetLongEdge, algorithm: params.algorithm }, inputs: [{ nodeId: node.id, port: "image" }] },
            }) };
            setNodes((current) => [...current, child]);
            setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            pageUi.getState().setSelectedNodeIds(new Set([childId]));
            pageUi.getState().setDialogNodeId(childId);
            await operation.wait(persistMediaNodes([child], [], {}));
        } catch (error) {
            if (operation.isCurrent()) throw error;
        }
    }, [beginMediaOperation, pageUi, projectId, persistMediaNodes, setConnections, setNodes]);

    const generateAngleNode = useCallback(async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        if (!node.metadata?.content) return;
        const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const childId = nanoid();
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const title = buildAngleLabel(params);
        const prompt = buildAnglePrompt(params);
        const source = nodeReferenceImage(node);
        if (!source) return;
        const styleExecution = resolveImageEditStyle(node, prompt, generationConfig);
        if (!styleExecution) return;
        const { prompt: effectivePrompt, metadata: styleMetadata } = styleExecution;
        const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
        setAngleNodeId(null);
        setRunningNodeId(childId);
        setNodes((current) => [...current, { id: childId, type: CanvasNodeType.Image, title, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: imageSpec.width, height: imageSpec.height, metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...generationMetadata, ...styleMetadata } }]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        pageUi.getState().setSelectedNodeIds(new Set([childId]));
        pageUi.getState().setDialogNodeId(childId);
        const controller = startGenerationRequest(childId, node.id, childId);
        try {
            const result = await operation.wait(runBackendCanvasGenerationTask({ projectId, nodeId: childId, mode: "image", prompt: effectivePrompt, config: generationConfig, referenceImages: [source], signal: controller.signal, metadata: { sourceNodeId: node.id, edit: "angle", ...styleMetadata }, onTaskCreated: (task) => operation.run(() => bindGenerationTask(childId, task)) }));
            const image = result.images?.[0];
            if (!image?.dataUrl) throw new Error("后端任务没有返回图片");
            const uploaded = await operation.wait(uploadImage(image.dataUrl));
            const size = fitNodeSize(uploaded.width, uploaded.height, imageSpec.width, imageSpec.height);
            const currentNode = nodesRef.current.find((item) => item.id === childId);
            if (!currentNode) throw new Error("视角生成节点已被删除");
            const finalizedNode = { ...currentNode, width: size.width, height: size.height, metadata: { ...currentNode.metadata, ...imageMetadata(uploaded), prompt: effectivePrompt, ...generationMetadata } };
            setNodes((current) => current.map((item) => item.id === childId ? finalizedNode : item));
            await operation.wait(persistMediaNodes([finalizedNode], [], {}));
        } catch (error) {
            if (!operation.isCurrent()) return;
            if (isGenerationCanceled(error)) return;
            const details = generationErrorMessage(error);
            setNodes((current) => current.map((item) => item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : item));
        } finally {
            if (operation.isCurrent()) {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        }
    }, [beginMediaOperation, pageUi, bindGenerationTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, nodesRef, persistMediaNodes, projectId, resolveImageEditStyle, setConnections, setNodes, setRunningNodeId, startGenerationRequest]);

    const generateLightingNode = useCallback((node: CanvasNodeData, options: CanvasImageLightingOptions, prompt: string) => {
        if (!node.metadata?.content) return;
        const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
        const childId = nanoid();
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const title = buildLightingLabel(options);
        const source = nodeReferenceImage(node);
        if (!source) return;
        const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
        setLightingNodeId(null);
        setNodes((current) => [...current, {
            id: childId, type: CanvasNodeType.Image, title, position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: imageSpec.width, height: imageSpec.height,
            metadata: { prompt, status: NODE_STATUS_IDLE, generationMode: "image", ...generationMetadata },
        }]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        pageUi.getState().setSelectedNodeIds(new Set([childId]));
        pageUi.getState().setSelectedConnectionId(null);
        pageUi.getState().setDialogNodeId(childId);
    }, [pageUi, projectId, effectiveConfig, setConnections, setLightingNodeId, setNodes]);

    const generateEmotionNode = useCallback(async (node: CanvasNodeData, payload: CanvasImageEmotionPayload) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        if (!node.metadata?.content) return;
        const baseConfig = buildGenerationConfig(effectiveConfig, node, "image");
        const providerSize = emotionGenerationSize(payload.editRegion);
        const generationConfig = { ...baseConfig, count: "1", size: providerSize, quality: !baseConfig.quality || baseConfig.quality === "auto" ? "high" : baseConfig.quality };
        if (!isAiConfigReady(generationConfig, generationConfig.model)) { navigateToSettings({ continueCreation: true }); return; }
        if (resolveModelRequestConfig(generationConfig, generationConfig.model).interfaceType !== "openai-image") {
            message.error("表情编辑需要支持多参考图编辑的 OpenAI Images 渠道");
            return;
        }
        const imageProfile = modelCapabilityConfigFor(generationConfig, generationConfig.model).image!;
        const editPlan = resolveEmotionEditPlan(imageProfile.references.maskSupported);
        const source = nodeReferenceImage(node);
        if (!source) return;
        const editReference = { id: `${node.id}-${payload.presetId}-edit-region`, name: "emotion-edit-region.png", type: "image/png", dataUrl: payload.sourceDataUrl };
        const characterReference = { id: `${node.id}-${payload.presetId}-character`, name: `${payload.characterName}-face.jpg`, type: "image/jpeg", dataUrl: payload.characterDataUrl };
        const childId = nanoid();
        const styleExecution = resolveImageEditStyle(node, payload.prompt, generationConfig);
        if (!styleExecution) return;
        const { prompt: effectivePrompt, metadata: styleMetadata } = styleExecution;
        const providerPrompt = normalizeEmotionPromptForProvider(effectivePrompt);
        const generationMetadata = { ...buildImageGenerationMetadata("edit", generationConfig, 1, [source]), size: `${payload.imageWidth}x${payload.imageHeight}` };
        const emotionEdit = { sourceNodeId: node.id, characterName: payload.characterName, presetId: payload.presetId, intimacy: payload.intimacy, arousal: payload.arousal, label: payload.label, faceBox: payload.faceBox, editRegion: payload.editRegion, sourceWidth: payload.imageWidth, sourceHeight: payload.imageHeight, providerSize, editMode: editPlan.mode };
        if (editPlan.notice) message.info(editPlan.notice);
        setEmotionNodeId(null);
        setRunningNodeId(childId);
        setNodes((current) => [...current, { id: childId, type: CanvasNodeType.Image, title: `${payload.characterName} · ${payload.label}`, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: node.width, height: node.height, metadata: { prompt: providerPrompt, status: NODE_STATUS_LOADING, ...generationMetadata, ...styleMetadata, emotionEdit } }]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        pageUi.getState().setSelectedNodeIds(new Set([childId]));
        pageUi.getState().setSelectedConnectionId(null);
        pageUi.getState().setDialogNodeId(childId);
        const controller = startGenerationRequest(childId, node.id, childId);
        try {
            const mask = emotionProviderMask(editPlan, { id: `${node.id}-emotion-mask`, name: "emotion-mask.png", type: "image/png", dataUrl: payload.maskDataUrl });
            const result = await operation.wait(runBackendCanvasGenerationTask({ projectId, nodeId: childId, mode: "image", prompt: providerPrompt, config: generationConfig, referenceImages: [editReference, characterReference], mask, signal: controller.signal, metadata: { sourceNodeId: node.id, edit: "emotion", emotionEditMode: editPlan.mode, emotion: emotionEdit, ...styleMetadata }, onTaskCreated: (task) => operation.run(() => bindGenerationTask(childId, task)) }));
            const image = result.images?.[0];
            if (!image?.dataUrl) throw new Error("后端任务没有返回图片");
            const sourceDataUrl = await operation.wait(resolveImageUrl(node.metadata.storageKey, node.metadata.content, { cacheMiss: true }));
            const composited = await operation.wait(compositeEmotionImage(sourceDataUrl, image.dataUrl, payload.editRegion, payload.faceBox));
            const uploaded = await operation.wait(uploadImage(composited));
            const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
            const currentNode = nodesRef.current.find((item) => item.id === childId);
            if (!currentNode) throw new Error("表情编辑节点已被删除");
            const finalizedNode = { ...currentNode, width: size.width, height: size.height, metadata: { ...currentNode.metadata, ...imageMetadata(uploaded), prompt: providerPrompt, ...generationMetadata, emotionEdit } };
            setNodes((current) => current.map((item) => item.id === childId ? finalizedNode : item));
            await operation.wait(persistMediaNodes([finalizedNode], [], {}));
        } catch (error) {
            if (!operation.isCurrent()) return;
            if (isGenerationCanceled(error)) return;
            const details = generationErrorMessage(error);
            message.error(details);
            setNodes((current) => current.map((item) => item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : item));
        } finally {
            if (operation.isCurrent()) {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        }
    }, [beginMediaOperation, pageUi, bindGenerationTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, nodesRef, persistMediaNodes, projectId, resolveImageEditStyle, setConnections, setNodes, setRunningNodeId, startGenerationRequest]);

    return {
        clearDeletedImageNodes, angleNodeId, lightingNodeId, emotionNodeId, annotationNodeId,
        createImageReversePromptNodes, openPortraitTextureEditor, cropImageNode, cropNodeId,
        generateAngleNode, generateLightingNode, maskEditImageNode, maskEditNodeId, saveAnnotatedImageNode,
        setAngleNodeId, setLightingNodeId, generateEmotionNode, setEmotionNodeId, setAnnotationNodeId,
        setCropNodeId, setMaskEditNodeId, setUpscaleNodeId, splitImageNode, upscaleImageNode, upscaleNodeId,
    };
}
