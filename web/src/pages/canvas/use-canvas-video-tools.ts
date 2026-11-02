import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { useAppProps } from "antd/es/app/context";
import { confirmDepthComponents } from "@/components/depth-components-panel";
import { nanoid } from "nanoid";

import type { CanvasVideoCropRect } from "@/components/canvas/canvas-video-crop-dialog";
import type { CanvasVideoFrameParams } from "@/components/canvas/canvas-video-frame-dialog";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { normalizeVideoCropForEncoding } from "@/lib/canvas/video-crop-geometry";
import { audioMetadata, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { attachOwnedDepthCaptureResult, recoverOwnedDepthCaptureNode, recoverOwnedDepthCaptureNodes } from "@/lib/canvas/canvas-depth-recover";
import { depthCaptureTaskMetadata, depthCaptureWaitFailureMetadata } from "@/lib/canvas/canvas-depth-capture";
import { captureVideoFrames, resolveVideoFramePresetTimeMs } from "@/lib/canvas/canvas-video-frame";
import { resolveCanvasVideoDurationMs } from "@/lib/canvas/canvas-video-duration";
import { buildVideoFrameNodes } from "@/lib/canvas/canvas-video-frame-nodes";
import { mergeVideos, warmFFmpeg, type MergeVideoProgress } from "@/lib/canvas/canvas-video-merge";
import { cropVideo, extractVideoAudio, removeAudioFromVideo, trimVideoSegment } from "@/lib/canvas/canvas-video-segment";
import { applyInlineVideoTrimMetadata, normalizeInlineVideoTrimRange, type InlineVideoTrimRange } from "@/lib/canvas/canvas-video-inline-trim";
import { generationErrorMessage } from "@/lib/generation-error";
import { storeGeneratedVideo } from "@/services/api/video";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { getResourcePlaybackBlob, ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import { assertLocalExecutorSession, beginLocalExecutorSession, isLocalExecutorSessionStop, isUncertainLocalExecutorSubmit, localExecutorFrozenInputKey, localExecutorIntentAfterError, nextLocalExecutorClientOperationId, runOwnedDepthCapture } from "@/lib/plugins/builtin/editor/local-executor-session";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { StartCanvasUploadStatus } from "./use-canvas-upload";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import type { createCanvasMediaOperation } from "./canvas-media-operation";

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export type UseCanvasVideoToolsOptions = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    projectIdRef: { current: string };
    depthObserversRef: { current: Set<AbortController> };
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    selectedNodeIdsRef: { current: Set<string> };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    startUploadStatus: StartCanvasUploadStatus;
    beginMediaOperation: () => ReturnType<typeof createCanvasMediaOperation>;
    persistMediaNodes: (mediaNodes: CanvasNodeData[], mediaConnections?: CanvasConnection[], options?: { signal?: AbortSignal }) => Promise<Map<string, string>>;
    message: useAppProps["message"];
    modal: useAppProps["modal"];
};

export function useCanvasVideoTools({
    pageUi, projectId, projectIdRef, depthObserversRef, nodesRef, connectionsRef, selectedNodeIdsRef,
    setNodes, setConnections, startUploadStatus, beginMediaOperation, persistMediaNodes, message, modal,
}: UseCanvasVideoToolsOptions) {
    const extractingVideoFramesNodeIdRef = useRef<string | null>(null);
    const mergeVideoRunningRef = useRef(false);
    const [videoCropNodeId, setVideoCropNodeId] = useState<string | null>(null);
    const [frameDialogNodeId, setFrameDialogNodeId] = useState<string | null>(null);
    const [extractingVideoFramesNodeId, setExtractingVideoFramesNodeId] = useState<string | null>(null);
    const [mergeVideoProgress, setMergeVideoProgress] = useState<MergeVideoProgress | null>(null);
    const [segmentRunningMode, setSegmentRunningMode] = useState<"audio" | null>(null);
    const segmentRunningRef = useRef(false);
    const [inlineTrimNodeId, setInlineTrimNodeId] = useState<string | null>(null);
    const [inlineTrimRunning, setInlineTrimRunning] = useState(false);
    const inlineTrimRunningRef = useRef(false);

    const clearDeletedVideoNodes = useCallback((removedIds: Set<string>) => {
        const clear = (current: string | null) => (current && removedIds.has(current) ? null : current);
        setVideoCropNodeId(clear);
        setFrameDialogNodeId(clear);
        setInlineTrimNodeId(clear);
    }, []);

    useEffect(() => {
        extractingVideoFramesNodeIdRef.current = null;
        mergeVideoRunningRef.current = false;
        segmentRunningRef.current = false;
        inlineTrimRunningRef.current = false;
        setExtractingVideoFramesNodeId(null);
        setMergeVideoProgress(null);
        setSegmentRunningMode(null);
        setInlineTrimRunning(false);
        setVideoCropNodeId(null);
        setFrameDialogNodeId(null);
        setInlineTrimNodeId(null);
    }, [projectId]);

    const cropVideoNode = useCallback(async (node: CanvasNodeData, crop: CanvasVideoCropRect, sourceDimensions: { width: number; height: number }) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        const source = { url: node.metadata?.content, storageKey: node.metadata?.storageKey };
        if (!source.url && !source.storageKey) return;
        const normalizedCrop = normalizeVideoCropForEncoding(crop, sourceDimensions);
        const childId = nanoid();
        const connection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
        const size = fitNodeSize(normalizedCrop.width, normalizedCrop.height, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
        const pendingChild: CanvasNodeData = {
            id: childId, type: CanvasNodeType.Video, title: `${node.title || "视频"} · 裁切`,
            position: { x: node.position.x + node.width + 96, y: node.position.y }, width: size.width, height: size.height,
            metadata: mediaResultMetadata("derived", {
                status: NODE_STATUS_LOADING, processingLabel: "正在裁切视频", prompt: `从「${node.title || "视频"}」裁切画面`,
                videoCrop: normalizedCrop, videoCropSourceNodeId: node.id,
                workflowOperation: { id: "video.crop", version: 1, config: { x: normalizedCrop.x / sourceDimensions.width, y: normalizedCrop.y / sourceDimensions.height, width: normalizedCrop.width / sourceDimensions.width, height: normalizedCrop.height / sourceDimensions.height }, inputs: [{ nodeId: node.id, port: "video" }] },
            }),
        };
        // The source remains available as soon as the crop is confirmed. The
        // downstream node owns the asynchronous FFmpeg work and its outcome.
        setNodes((current) => [...current, pendingChild]);
        setConnections((current) => [...current, connection]);
        pageUi.getState().setSelectedNodeIds(new Set([childId]));
        pageUi.getState().setSelectedConnectionId(null);
        setVideoCropNodeId(null);
        try {
            const output = await operation.wait(cropVideo(source, normalizedCrop));
            const uploaded = await operation.wait(uploadMediaFile(output, "video"));
            const fitted = fitNodeSize(uploaded.width || normalizedCrop.width, uploaded.height || normalizedCrop.height, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
            const completedChild: CanvasNodeData = {
                ...pendingChild, width: fitted.width, height: fitted.height,
                metadata: mediaResultMetadata("derived", {
                    ...videoMetadata(uploaded), prompt: pendingChild.metadata?.prompt, status: NODE_STATUS_SUCCESS,
                    videoCrop: normalizedCrop, videoCropSourceNodeId: node.id, workflowOperation: pendingChild.metadata?.workflowOperation,
                }),
            };
            setNodes((current) => current.map((item) => item.id === childId ? completedChild : item));
            await operation.wait(persistMediaNodes([completedChild], [connection], {}));
        } catch (error) {
            if (!operation.isCurrent()) return;
            const details = error instanceof Error ? error.message : "视频画面裁切失败";
            setNodes((current) => current.map((item) => item.id === childId ? {
                ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details },
            } : item));
        }
    }, [beginMediaOperation, pageUi, projectId, persistMediaNodes, setConnections, setNodes]);

    const runDepthCaptureForTarget = useCallback(async (
        originalProjectId: string, targetNodeId: string, resourceId: string, clientOperationId: string, frozenInputKey: string,
    ) => {
        const observer = new AbortController();
        depthObserversRef.current.add(observer);
        let submittedTaskId: string | undefined;
        let latestDepthTask: GenerationTask | undefined;
        try {
            const session = beginLocalExecutorSession(originalProjectId, { controller: observer, getLiveProjectId: () => projectIdRef.current });
            await persistCanvasDocument(originalProjectId, { nodes: nodesRef.current, connections: connectionsRef.current });
            assertLocalExecutorSession(session);
            if (!nodesRef.current.some(item => item.id === targetNodeId && item.metadata?.taskClientOperationId === clientOperationId)) return;
            const { task } = await runOwnedDepthCapture({
                session, projectId: originalProjectId, resourceId, nodeId: targetNodeId, clientOperationId,
                onCreated: async (created) => {
                    latestDepthTask = created;
                    submittedTaskId = created.id;
                    nodesRef.current = nodesRef.current.map(item => item.id === targetNodeId && item.metadata?.taskClientOperationId === clientOperationId ? { ...item, metadata: { ...item.metadata, taskId: created.id, taskStatus: created.status, taskClientOperationId: created.clientOperationId || clientOperationId } } : item);
                    setNodes(nodesRef.current);
                    await persistCanvasDocument(originalProjectId, { nodes: nodesRef.current, connections: connectionsRef.current });
                },
                onTaskUpdate: (next) => {
                    latestDepthTask = next;
                    setNodes((current) => current.map((item) => item.id === targetNodeId && item.metadata?.taskId === next.id ? { ...item, metadata: { ...item.metadata, ...depthCaptureTaskMetadata(next) } } : item));
                },
            });
            const target = nodesRef.current.find(item => item.id === targetNodeId);
            if (target?.metadata?.taskId === task.id) await attachOwnedDepthCaptureResult({ node: target, task, session, nodesRef, setNodes });
        } catch (error) {
            if (isLocalExecutorSessionStop(error)) return;
            const details = error instanceof Error ? error.message : "深度动作捕捉失败";
            const intent = localExecutorIntentAfterError({ clientOperationId, submittedTaskId, frozenInputKey }, error);
            const uncertain = isUncertainLocalExecutorSubmit(error, submittedTaskId);
            setNodes((current) => current.map((item) => item.id === targetNodeId && item.metadata?.taskClientOperationId === clientOperationId ? {
                ...item,
                metadata: {
                    ...item.metadata, status: NODE_STATUS_ERROR, taskId: submittedTaskId,
                    taskClientOperationId: intent.clientOperationId, taskClientOperationInput: frozenInputKey, taskClientOperationTerminal: intent.terminal,
                    taskOutcome: uncertain ? ({ phase: "retrievable", regenerate: "blocked", reason: "submission_unknown" } as const) : undefined,
                    errorDetails: details, ...(!uncertain ? depthCaptureWaitFailureMetadata(error, latestDepthTask || submittedTaskId) : {}),
                },
            } : item));
            message.error(details);
        } finally {
            depthObserversRef.current.delete(observer);
        }
    }, [connectionsRef, depthObserversRef, message, nodesRef, projectIdRef, setNodes]);

    const depthCaptureNode = useCallback(async (node: CanvasNodeData) => {
        const resourceId = ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content);
        if (!resourceId) {
            message.error("请先等待视频保存到本地资源库，再进行深度动作捕捉");
            return;
        }
        try {
            if (!await confirmDepthComponents(modal)) return;
            if (projectIdRef.current !== projectId || !nodesRef.current.some(item => item.id === node.id)) return;
        } catch (error) { message.error(generationErrorMessage(error)); return; }
        const originalProjectId = projectId;
        const frozenInputKey = localExecutorFrozenInputKey(["depth_capture", originalProjectId, resourceId]);
        const clientOperationId = nextLocalExecutorClientOperationId(null, frozenInputKey);
        const childId = nanoid();
        const connection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
        const pendingChild: CanvasNodeData = {
            id: childId, type: CanvasNodeType.Video, title: `${node.title || "视频"} · 深度动作捕捉`,
            position: { x: node.position.x + node.width + 96, y: node.position.y }, width: node.width, height: node.height,
            metadata: mediaResultMetadata("derived", {
                status: NODE_STATUS_LOADING, processingLabel: "检查深度处理组件", taskStage: "检查深度处理组件", taskProgress: 0,
                prompt: `从「${node.title || "视频"}」生成深度动作参考`, depthSourceNodeId: node.id,
                taskClientOperationId: clientOperationId, taskClientOperationInput: frozenInputKey,
            }),
        };
        nodesRef.current = [...nodesRef.current, pendingChild];
        connectionsRef.current = [...connectionsRef.current, connection];
        setNodes(nodesRef.current);
        setConnections((current) => [...current, connection]);
        pageUi.getState().setSelectedNodeIds(new Set([childId]));
        pageUi.getState().setSelectedConnectionId(null);
        await runDepthCaptureForTarget(originalProjectId, childId, resourceId, clientOperationId, frozenInputKey);
    }, [pageUi, message, modal, nodesRef, connectionsRef, projectId, projectIdRef, runDepthCaptureForTarget, setConnections, setNodes]);

    const retryDepthCaptureNode = useCallback(async (node: CanvasNodeData) => {
        // A known task is recovered before considering a new execution.
        if (node.metadata?.taskId) {
            const observer = new AbortController();
            depthObserversRef.current.add(observer);
            try {
                const session = beginLocalExecutorSession(projectId, { controller: observer, getLiveProjectId: () => projectIdRef.current });
                const existing = await queryGenerationTask(node.metadata.taskId, { signal: observer.signal });
                assertLocalExecutorSession(session);
                if (!nodesRef.current.some(item => item.id === node.id && item.metadata?.taskId === existing.id)) return;
                if (existing.status !== "failed" && existing.status !== "cancelled") {
                    await recoverOwnedDepthCaptureNode({ node, nodesRef, setNodes, session });
                    return;
                }
            } catch (error) {
                if (!isLocalExecutorSessionStop(error)) message.error(generationErrorMessage(error));
                return;
            } finally { depthObserversRef.current.delete(observer); }
        }
        const sourceNodeId = node.metadata?.depthSourceNodeId;
        const sourceNode = sourceNodeId ? nodesRef.current.find((item) => item.id === sourceNodeId) : undefined;
        const resourceId = sourceNode ? ownedResourceIdFromMediaRef(sourceNode.metadata?.storageKey, sourceNode.metadata?.content) : undefined;
        if (!sourceNode || !resourceId) {
            const details = "原始视频已丢失，无法重新生成深度动作参考";
            setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : item));
            message.error(details);
            return;
        }
        try {
            if (!await confirmDepthComponents(modal)) return;
            if (projectIdRef.current !== projectId || !nodesRef.current.some(item => item.id === node.id)) return;
        } catch (error) { message.error(generationErrorMessage(error)); return; }
        const originalProjectId = projectId;
        const frozenInputKey = localExecutorFrozenInputKey(["depth_capture", originalProjectId, resourceId]);
        const clientOperationId = nextLocalExecutorClientOperationId({
            clientOperationId: node.metadata?.taskClientOperationId, submittedTaskId: node.metadata?.taskId,
            frozenInputKey: node.metadata?.taskClientOperationInput, terminal: node.metadata?.taskClientOperationTerminal,
        }, frozenInputKey);
        nodesRef.current = nodesRef.current.map((item) => item.id === node.id ? {
            ...item,
            metadata: {
                ...item.metadata, status: NODE_STATUS_LOADING, processingLabel: "检查深度处理组件", taskStage: "检查深度处理组件",
                taskProgress: 0, taskStatus: "queued", taskId: undefined, taskClientOperationId: clientOperationId,
                taskClientOperationInput: frozenInputKey, taskClientOperationTerminal: undefined, errorDetails: undefined,
            },
        } : item);
        setNodes(nodesRef.current);
        await runDepthCaptureForTarget(originalProjectId, node.id, resourceId, clientOperationId, frozenInputKey);
    }, [depthObserversRef, message, modal, nodesRef, projectId, projectIdRef, runDepthCaptureForTarget, setNodes]);

    const recoverDepthCaptureNodes = useCallback((signal: AbortSignal) => {
        recoverOwnedDepthCaptureNodes({
            nodesRef, signal, projectId, getLiveProjectId: () => projectIdRef.current, observers: depthObserversRef.current, setNodes,
        });
    }, [depthObserversRef, nodesRef, projectId, projectIdRef, setNodes]);

    const closeFrameDialog = useCallback(() => {
        if (extractingVideoFramesNodeIdRef.current) return;
        setFrameDialogNodeId(null);
    }, []);

    const extractVideoFrames = useCallback(async (node: CanvasNodeData, params: CanvasVideoFrameParams) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        const content = node.metadata?.content;
        const resourceId = ownedResourceIdFromMediaRef(node.metadata?.storageKey, content);
        const effectiveStorageKey = node.metadata?.storageKey || (resourceId ? resourceStorageKey(resourceId) : "");
        if ((!content && !effectiveStorageKey) || extractingVideoFramesNodeIdRef.current || !params.timesMs.length) return;
        const progress = startUploadStatus("关键帧截取", "读取视频资源", params.timesMs.length + 2);
        extractingVideoFramesNodeIdRef.current = node.id;
        setExtractingVideoFramesNodeId(node.id);
        setFrameDialogNodeId(null);
        try {
            const storedBlob = effectiveStorageKey ? await operation.wait(getMediaBlob(effectiveStorageKey).catch(() => null)) : null;
            const resolvedUrl = storedBlob ? "" : await operation.wait(resolveMediaUrl(effectiveStorageKey, content || "").catch(() => content || ""));
            operation.run(() => progress.update("定位并绘制所选画面", 2));
            let captured: Awaited<ReturnType<typeof captureVideoFrames>>;
            try {
                captured = await operation.wait(captureVideoFrames(storedBlob || resolvedUrl, params.timesMs));
            } catch (captureError) {
                if (!operation.isCurrent()) return;
                const playbackBlob = resourceId ? await operation.wait(getResourcePlaybackBlob(resourceStorageKey(resourceId)).catch(() => null)) : null;
                if (!playbackBlob) throw captureError;
                captured = await operation.wait(captureVideoFrames(playbackBlob, params.timesMs));
            }
            const uploadedFrames = [];
            const uploadFailures: string[] = [];
            for (let index = 0; index < captured.frames.length; index += 1) {
                const frame = captured.frames[index];
                try {
                    operation.run(() => progress.update(`保存画面（${index + 1}/${captured.frames.length}）`, index + 3));
                    uploadedFrames.push({ timeMs: frame.timeMs, image: await operation.wait(uploadImage(frame.blob)) });
                } catch (error) {
                    if (!operation.isCurrent()) return;
                    uploadFailures.push(error instanceof Error ? error.message : "画面图片上传失败");
                }
            }
            const frameNodes = buildVideoFrameNodes(node, uploadedFrames, nodesRef.current);
            if (!frameNodes.length) throw new Error(uploadFailures[0] || "画面图片保存失败");
            const links = frameNodes.map((frameNode) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: frameNode.id }));
            const nextNodes = [...nodesRef.current, ...frameNodes];
            const nextConnections = [...connectionsRef.current, ...links];
            const selection = new Set(frameNodes.map((frameNode) => frameNode.id));
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            selectedNodeIdsRef.current = selection;
            setNodes(nextNodes);
            setConnections(nextConnections);
            pageUi.getState().setSelectedNodeIds(selection);
            pageUi.getState().setSelectedConnectionId(null);
            await operation.wait(persistMediaNodes(frameNodes, links, {}));
            const failedCount = captured.failures.length + uploadFailures.length;
            operation.run(() => progress.done(failedCount ? `已截取 ${frameNodes.length} 个关键帧，${failedCount} 个失败` : `已截取 ${frameNodes.length} 个关键帧并创建独立图片节点`));
            if (failedCount) message.warning(`${failedCount} 个时间点提取失败，其余画面已创建`);
            else message.success(`已截取 ${frameNodes.length} 个关键帧，新图片节点已生成在视频右侧`);
        } catch (error) {
            if (!operation.isCurrent()) return;
            const details = error instanceof Error ? error.message : "视频画面提取失败";
            operation.run(() => progress.fail(details));
            message.error(details);
        } finally {
            if (operation.isCurrent()) {
                extractingVideoFramesNodeIdRef.current = null;
                setExtractingVideoFramesNodeId(null);
            }
        }
    }, [beginMediaOperation, pageUi, projectId, connectionsRef, message, nodesRef, persistMediaNodes, selectedNodeIdsRef, setConnections, setNodes, startUploadStatus]);

    // 视频节点工具栏的三个快捷取帧动作直接执行，不再打开批量选帧弹窗。
    const extractVideoFrameAt = useCallback((node: CanvasNodeData, preset: "current" | "first" | "last" = "current") => {
        if (!node.metadata?.content && !node.metadata?.storageKey) {
            message.warning("视频节点为空，无法进行关键帧截取");
            return;
        }
        const video = document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(node.id)}"] video`);
        const durationMs = resolveCanvasVideoDurationMs(node.metadata?.durationMs, video?.duration);
        const currentMs = video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : 0;
        const timeMs = resolveVideoFramePresetTimeMs(preset, durationMs, currentMs);
        pageUi.getState().setHoveredNodeId(null);
        pageUi.getState().setToolbarNodeId(null);
        if (preset === "last" && (node.metadata?.lastFrameStorageKey || node.metadata?.lastFrameUrl)) {
            void (async () => {
                const operation = beginMediaOperation();
                if (!operation.isCurrent() || extractingVideoFramesNodeIdRef.current) return;
                const progress = startUploadStatus("截取无损尾帧", "读取上游尾帧", 3);
                extractingVideoFramesNodeIdRef.current = node.id;
                setExtractingVideoFramesNodeId(node.id);
                try {
                    let uploaded: Awaited<ReturnType<typeof uploadImage>>;
                    try {
                        const resolved = await operation.wait(resolveImageUrl(node.metadata?.lastFrameStorageKey, node.metadata?.lastFrameUrl || ""));
                        if (!resolved) throw new Error("上游尾帧读取失败");
                        operation.run(() => progress.update("保存无损尾帧画面", 2));
                        uploaded = await operation.wait(uploadImage(resolved));
                    } catch {
                        if (!operation.isCurrent()) return;
                        operation.run(() => progress.done("改用视频画面解码提取尾帧"));
                        extractingVideoFramesNodeIdRef.current = null;
                        setExtractingVideoFramesNodeId(null);
                        await extractVideoFrames(node, { timesMs: [timeMs] });
                        return;
                    }
                    const fallbackDurationMs = Number(node.metadata?.seconds) > 0 ? Math.round(Number(node.metadata?.seconds) * 1000) : 0;
                    const displayTimeMs = durationMs > 0 ? timeMs : fallbackDurationMs > 0 ? Math.max(0, fallbackDurationMs - 1) : 0;
                    const frameNodes = buildVideoFrameNodes(node, [{ timeMs: displayTimeMs, image: uploaded }], nodesRef.current);
                    if (!frameNodes.length) throw new Error("无损尾帧节点创建失败");
                    const links = frameNodes.map((frameNode) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: frameNode.id }));
                    const nextNodes = [...nodesRef.current, ...frameNodes];
                    const nextConnections = [...connectionsRef.current, ...links];
                    const selection = new Set(frameNodes.map((frameNode) => frameNode.id));
                    nodesRef.current = nextNodes;
                    connectionsRef.current = nextConnections;
                    selectedNodeIdsRef.current = selection;
                    setNodes(nextNodes);
                    setConnections(nextConnections);
                    pageUi.getState().setSelectedNodeIds(selection);
                    pageUi.getState().setSelectedConnectionId(null);
                    await operation.wait(persistMediaNodes(frameNodes, links, {}));
                    operation.run(() => progress.done("已提取上游无损尾帧并创建独立图片节点"));
                    message.success("已提取上游无损尾帧，新图片节点已生成在视频右侧");
                } catch (error) {
                    if (!operation.isCurrent()) return;
                    const details = error instanceof Error ? error.message : "无损尾帧提取失败";
                    operation.run(() => progress.fail(details));
                    message.error(details);
                } finally {
                    if (operation.isCurrent()) {
                        extractingVideoFramesNodeIdRef.current = null;
                        setExtractingVideoFramesNodeId(null);
                    }
                }
            })();
            return;
        }
        void extractVideoFrames(node, { timesMs: [timeMs] });
    }, [beginMediaOperation, connectionsRef, extractVideoFrames, message, nodesRef, pageUi, persistMediaNodes, selectedNodeIdsRef, setConnections, setNodes, startUploadStatus]);

    const openInlineVideoTrim = useCallback((node: CanvasNodeData) => {
        if (!node.metadata?.content) {
            message.warning("视频节点为空，无法剪辑");
            return;
        }
        if (inlineTrimRunningRef.current) return;
        pageUi.getState().setHoveredNodeId(null);
        pageUi.getState().setToolbarNodeId(null);
        pageUi.getState().setDialogNodeId(null);
        // Preload the same shared worker while the user sets the trim range.
        // A failure remains non-blocking here and is reported by submission.
        void warmFFmpeg().catch(() => undefined);
        setInlineTrimNodeId(node.id);
    }, [pageUi, projectId, message]);

    const openVideoCrop = useCallback((node: CanvasNodeData) => {
        if (!node.metadata?.content) {
            message.warning("视频节点为空，无法裁切");
            return;
        }
        pageUi.getState().setHoveredNodeId(null);
        pageUi.getState().setToolbarNodeId(null);
        // The editor remains responsive while FFmpeg initializes in the
        // background; confirmation then reuses this exact worker instance.
        void warmFFmpeg().catch(() => undefined);
        setVideoCropNodeId(node.id);
    }, [pageUi, projectId, message]);

    const closeInlineVideoTrim = useCallback(() => {
        if (!inlineTrimRunningRef.current) setInlineTrimNodeId(null);
    }, []);

    const confirmInlineVideoTrim = useCallback(async (node: CanvasNodeData, requestedRange: InlineVideoTrimRange) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        if (inlineTrimRunningRef.current || !node.metadata?.content) return;
        const sourceDurationMs = Math.max(100, node.metadata.durationMs || requestedRange.endMs);
        const range = normalizeInlineVideoTrimRange(requestedRange, sourceDurationMs);
        inlineTrimRunningRef.current = true;
        setInlineTrimRunning(true);
        const progress = startUploadStatus("剪辑视频", "加载 FFmpeg", 4);
        try {
            const output = await operation.wait(trimVideoSegment(
                { url: node.metadata.content, storageKey: node.metadata.storageKey },
                range,
                sourceDurationMs,
                (status) => operation.run(() => progress.update(status.phase === "loading" ? "加载 FFmpeg" : status.phase === "reading" ? "读取视频资源" : "正在裁切片段 · " + Math.round(status.progress) + "%", status.phase === "encoding" ? 3 : 2)),
            ));
            operation.run(() => progress.update("保存剪辑结果", 4));
            const uploaded = await operation.wait(uploadMediaFile(output, "video"));
            const existingTrimCount = nodesRef.current.filter((item) => item.metadata?.videoTrimSourceNodeId === node.id).length;
            const child: CanvasNodeData = {
                id: nanoid(), type: CanvasNodeType.Video, title: `${node.title || "视频"} · 剪辑片段`,
                position: { x: node.position.x + node.width + 96, y: node.position.y + existingTrimCount * 48 },
                width: node.width, height: node.height,
                metadata: mediaResultMetadata("derived", {
                    ...applyInlineVideoTrimMetadata(node.metadata || {}, videoMetadata(uploaded), range),
                    status: NODE_STATUS_SUCCESS, prompt: `从「${node.title || "视频"}」剪辑 ${((range.endMs - range.startMs) / 1000).toFixed(2)} 秒片段`,
                    videoTrimSourceNodeId: node.id,
                    workflowOperation: { id: "video.trim", version: 1, config: { startSeconds: range.startMs / 1000, endSeconds: range.endMs / 1000 }, inputs: [{ nodeId: node.id, port: "video" }] },
                }),
            };
            const connection: CanvasConnection = { id: nanoid(), fromNodeId: node.id, toNodeId: child.id };
            const nextNodes = [...nodesRef.current, child];
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            selectedNodeIdsRef.current = new Set([child.id]);
            setNodes(nextNodes);
            setConnections(nextConnections);
            pageUi.getState().setSelectedNodeIds(new Set([child.id]));
            pageUi.getState().setSelectedConnectionId(null);
            pageUi.getState().setDialogNodeId(null);
            await operation.wait(persistMediaNodes([child], [], {}));
            setInlineTrimNodeId(null);
            operation.run(() => progress.done(`已生成 ${((range.endMs - range.startMs) / 1000).toFixed(2)} 秒剪辑视频`));
            message.success("已生成新的剪辑视频，原视频已保留");
        } catch (error) {
            if (!operation.isCurrent()) return;
            const details = error instanceof Error ? error.message : "视频剪辑失败";
            operation.run(() => progress.fail(details));
            message.error(details);
        } finally {
            if (operation.isCurrent()) {
                inlineTrimRunningRef.current = false;
                setInlineTrimRunning(false);
            }
        }
    }, [beginMediaOperation, pageUi, projectId, connectionsRef, message, nodesRef, persistMediaNodes, selectedNodeIdsRef, setConnections, setNodes, startUploadStatus]);

    // 音视频分离同时产出独立音轨和无声视频，原视频始终保留。
    const runExtractVideoAudio = useCallback(async (node: CanvasNodeData, params: { startMs: number; endMs: number }) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        const sourceIsCurrent = () => {
            const current = nodesRef.current.find((item) => item.id === node.id);
            return operation.isCurrent() && Boolean(current)
                && current?.metadata?.storageKey === node.metadata?.storageKey
                && current?.metadata?.content === node.metadata?.content;
        };
        const assertSourceCurrent = () => {
            if (!sourceIsCurrent()) throw new DOMException("The audio extraction target changed", "AbortError");
        };
        const progress = startUploadStatus("音视频分离", "生成无声视频与音轨", 6);
        try {
            assertSourceCurrent();
            const source = { url: node.metadata?.content, storageKey: node.metadata?.storageKey };
            const range = { startMs: params.startMs, endMs: params.endMs };
            const audio = await operation.wait(extractVideoAudio(source, range, node.metadata?.durationMs, (status) => {
                operation.run(() => progress.update(status.phase === "loading" ? "加载 FFmpeg" : status.phase === "reading" ? "检查视频音轨" : "正在提取音轨 · " + Math.round(status.progress) + "%", status.phase === "encoding" ? 2 : 1));
            }));
            assertSourceCurrent();
            operation.run(() => progress.update("正在生成无声视频", 3));
            const mutedVideo = await operation.wait(removeAudioFromVideo(source, range, node.metadata?.durationMs, (status) => {
                operation.run(() => progress.update(status.phase === "reading" ? "读取视频资源" : "正在生成无声视频 · " + Math.round(status.progress) + "%", status.phase === "encoding" ? 4 : 3));
            }));
            assertSourceCurrent();
            operation.run(() => progress.update("保存两个独立结果", 5));
            const [uploadedVideo, uploadedAudio] = await operation.wait(Promise.all([uploadMediaFile(mutedVideo, "video"), uploadMediaFile(audio, "audio")]));
            assertSourceCurrent();
            const videoSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
            const audioSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
            const outputX = node.position.x + node.width + 96;
            const silentVideo = createCanvasNode(CanvasNodeType.Video, { x: outputX + videoSpec.width / 2, y: node.position.y + videoSpec.height / 2 }, mediaResultMetadata("derived", {
                ...videoMetadata(uploadedVideo), prompt: `从「${node.title || "视频"}」移除声音`, status: NODE_STATUS_SUCCESS,
                videoAudioSourceNodeId: node.id, videoHasAudio: false,
            }));
            silentVideo.title = `${node.title || "视频"} · 无声视频`;
            const audioNode = createCanvasNode(CanvasNodeType.Audio, { x: outputX + audioSpec.width / 2, y: node.position.y + videoSpec.height + 96 + audioSpec.height / 2 }, mediaResultMetadata("derived", {
                ...audioMetadata(uploadedAudio), prompt: `从「${node.title || "视频"}」提取的声音`, status: NODE_STATUS_SUCCESS,
                audioExtractSourceNodeId: node.id, audioExtractStartMs: params.startMs, audioExtractEndMs: params.endMs,
            }));
            audioNode.title = `${node.title || "视频"} · 音轨`;
            const outputs = [silentVideo, audioNode];
            const outputIds = new Set(outputs.map((item) => item.id));
            const links = outputs.map((item) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: item.id }));
            nodesRef.current = [...nodesRef.current, ...outputs];
            connectionsRef.current = [...connectionsRef.current, ...links];
            setNodes(nodesRef.current);
            setConnections(connectionsRef.current);
            pageUi.getState().setSelectedNodeIds(outputIds);
            pageUi.getState().setSelectedConnectionId(null);
            const savedAssets = await operation.wait(persistMediaNodes(outputs, links, {}));
            assertSourceCurrent();
            if (outputs.some((output) => !savedAssets.get(output.id))) throw new Error("分离结果尚未确认保存，请重试；不要将当前节点视为已保存的成品");
            operation.run(() => progress.done("已生成并保存无声视频和独立音轨"));
            message.success("已生成并保存无声视频和独立音轨，原视频已保留");
        } catch (error) {
            if (!sourceIsCurrent()) return;
            const details = error instanceof Error ? error.message : "音频提取失败";
            setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, mediaOperationError: details } } : item));
            operation.run(() => progress.fail(details));
            modal.error({ title: "音视频分离未完成", content: details, okText: "知道了" });
        }
    }, [beginMediaOperation, pageUi, projectId, connectionsRef, message, modal, nodesRef, persistMediaNodes, setConnections, setNodes, startUploadStatus]);

    // 音视频分离始终处理整段视频，直接生成独立音轨节点，不再打开范围选择弹窗。
    const extractAudioFromVideo = useCallback((node: CanvasNodeData) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        if (!node.metadata?.content) {
            message.warning("视频节点为空，无法进行音视频分离");
            return;
        }
        if (segmentRunningRef.current) return;
        segmentRunningRef.current = true;
        setSegmentRunningMode("audio");
        pageUi.getState().setHoveredNodeId(null);
        pageUi.getState().setToolbarNodeId(null);
        const video = document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(node.id)}"] video`);
        const durationMs = resolveCanvasVideoDurationMs(node.metadata.durationMs, video?.duration);
        if (!durationMs || durationMs <= 0) {
            segmentRunningRef.current = false;
            setSegmentRunningMode(null);
            message.warning("视频时长尚未就绪，无法分离整段音频，请稍后重试");
            return;
        }
        return runExtractVideoAudio(node, { startMs: 0, endMs: durationMs }).finally(() => {
            if (operation.isCurrent()) {
                segmentRunningRef.current = false;
                setSegmentRunningMode(null);
            }
        });
    }, [beginMediaOperation, pageUi, projectId, message, runExtractVideoAudio, setSegmentRunningMode]);

    const mergeVideosByIds = useCallback(async (videoNodeIds: string[]) => {
        const operation = beginMediaOperation();
        if (!operation.isCurrent()) return;
        if (mergeVideoRunningRef.current) return;
        const requestedIds = new Set(videoNodeIds);
        const videos = nodesRef.current
            .filter((node) => requestedIds.has(node.id) && node.type === CanvasNodeType.Video && Boolean(node.metadata?.content))
            .sort((left, right) => {
                const leftShot = left.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER;
                const rightShot = right.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER;
                return leftShot - rightShot || left.position.y - right.position.y || left.position.x - right.position.x;
            });
        if (videos.length < 2) {
            message.warning("请至少选择两个已有视频");
            return;
        }
        mergeVideoRunningRef.current = true;
        setMergeVideoProgress({ phase: "reading", progress: 0 });
        try {
            const blob = await operation.wait(mergeVideos(videos.map((node) => ({ id: node.id, url: node.metadata?.content, storageKey: node.metadata?.storageKey })), (value) => operation.run(() => setMergeVideoProgress(value))));
            setMergeVideoProgress({ phase: "saving", progress: 98 });
            const uploaded = await operation.wait(storeGeneratedVideo({ blob }));
            const size = fitNodeSize(uploaded.width || 1280, uploaded.height || 720, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
            const left = Math.max(...videos.map((node) => node.position.x + node.width)) + 120;
            const top = Math.min(...videos.map((node) => node.position.y));
            const mergedNode = createCanvasNode(CanvasNodeType.Video, { x: left + size.width / 2, y: top + size.height / 2 }, mediaResultMetadata("derived", {
                ...videoMetadata(uploaded), prompt: `按选中顺序合并 ${videos.length} 段视频`,
                workflowKind: "final", workflowTitle: "合并成片", videoEditOperation: "concat",
                videoMergeSourceNodeIds: videos.map((node) => node.id), status: NODE_STATUS_SUCCESS,
            }));
            mergedNode.title = `合并成片 · ${videos.length} 段`;
            mergedNode.width = size.width;
            mergedNode.height = size.height;
            mergedNode.position = { x: left, y: top };
            const links = videos.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: mergedNode.id }));
            const nextNodes = [...nodesRef.current, mergedNode];
            const nextConnections = [...connectionsRef.current, ...links];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            const selection = new Set([mergedNode.id]);
            selectedNodeIdsRef.current = selection;
            pageUi.getState().setSelectedNodeIds(selection);
            pageUi.getState().setSelectedConnectionId(null);
            pageUi.getState().setDialogNodeId(null);
            setMergeVideoProgress({ phase: "binding", progress: 98 });
            await operation.wait(persistMediaNodes([mergedNode], [], {}));
            setMergeVideoProgress({ phase: "done", progress: 100 });
            message.success(`已合并 ${videos.length} 段视频，成片节点已添加`);
        } catch (error) {
            if (!operation.isCurrent()) return;
            message.error(error instanceof Error ? error.message : "视频合并失败");
        } finally {
            if (operation.isCurrent()) {
                mergeVideoRunningRef.current = false;
                window.setTimeout(() => operation.run(() => setMergeVideoProgress(null)), 700);
            }
        }
    }, [beginMediaOperation, pageUi, projectId, connectionsRef, message, nodesRef, persistMediaNodes, selectedNodeIdsRef, setConnections, setNodes]);

    const mergeSelectedVideos = useCallback(() => mergeVideosByIds(Array.from(selectedNodeIdsRef.current)), [mergeVideosByIds, selectedNodeIdsRef]);

    return {
        clearDeletedVideoNodes, videoCropNodeId, setVideoCropNodeId, cropVideoNode, depthCaptureNode, retryDepthCaptureNode,
        recoverDepthCaptureNodes, closeFrameDialog, extractAudioFromVideo, extractVideoFrameAt, extractVideoFrames,
        extractingVideoFramesNodeId, frameDialogNodeId, setFrameDialogNodeId, mergeSelectedVideos, mergeVideosByIds,
        mergeVideoProgress, segmentRunningMode, inlineTrimNodeId, inlineTrimRunning, setInlineTrimNodeId,
        openInlineVideoTrim, openVideoCrop, closeInlineVideoTrim, confirmInlineVideoTrim,
    };
}
