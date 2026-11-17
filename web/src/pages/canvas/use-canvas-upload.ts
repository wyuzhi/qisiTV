import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import type { CanvasProjectChapterPayload } from "@/components/canvas/canvas-project-sidebar";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import {
    applyDecodedUploadPlaceholder,
    applyInitialReplacementUploadPlaceholder,
    buildSettledUploadedCanvasNode,
    CANVAS_UPLOAD_ACCEPT,
    createFileUploadAttemptId,
    createFileUploadPlaceholder,
    restoreFailedUploadNode,
    uploadNodeType,
    uploadPercent,
} from "@/lib/canvas/canvas-file-upload";
import { audioMetadata, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { canvasNodesMissingResourceAssetBinding } from "@/lib/canvas/canvas-node-asset";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { isAudioFile } from "@/lib/canvas/canvas-project-generation";
import {
    createScriptDocumentUploadPlaceholder,
    extractScriptDocumentText,
    resolveScriptOrUploadNodeType,
    SCRIPT_DOCUMENT_ACCEPT,
} from "@/lib/canvas/script-document-import";
import { getDataUrlByteSize } from "@/lib/image-utils";
import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { getProjectUnit } from "@/services/api/projects";
import { http } from "@/services/api/request";
import { ownedResourceStorageKey, resourceIdFromStorageKey } from "@/services/api/resources";
import { uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import type { ImageAsset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";
import type { TimelineDirectMedia } from "@/types/timeline";

import { runOwnedCanvasCreatedNodes, useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import type { CanvasUploadStatus } from "./canvas-project-feedback";
import { buildCanvasAssetPayloadNode, buildCanvasAssetPayloadNodes } from "./canvas-upload-asset-payload";
import { createOwnedCanvasUploadGuard, persistOwnedCanvasUploadNode, shouldSuppressOwnedCanvasCallback } from "./canvas-upload-ownership";
import { useCanvasUploadDnd, type CanvasUploadTarget } from "./use-canvas-upload-dnd";

type UseCanvasUploadOptions = {
    pageUi: CanvasPageUiStoreHook;
    canvasId: string;
    domainProjectId?: string;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    selectedNodeIdsRef: { current: Set<string> };
    getCanvasCenter: () => Position;
    screenToCanvas: (clientX: number, clientY: number) => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    onCancelNodeGeneration?: (nodeId: string) => void;
};

export type StartCanvasUploadStatus = (title: string, detail: string, total?: number) => {
    update: (detail: string, step: number) => void;
    done: (detail?: string) => void;
    fail: (detail?: string) => void;
};

const NODE_STATUS_SUCCESS = "success" as const;

function htmlToPlainText(value: string) {
    if (!value) return "";
    const document = new DOMParser().parseFromString(value, "text/html");
    return document.body.textContent?.trim() || "";
}

export function useCanvasUpload({
    pageUi,
    canvasId,
    domainProjectId,
    nodesRef,
    connectionsRef,
    selectedNodeIdsRef,
    getCanvasCenter,
    screenToCanvas,
    setNodes,
    setConnections,
    onCancelNodeGeneration,
}: UseCanvasUploadOptions) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const canvasIdRef = useRef(canvasId);
    canvasIdRef.current = canvasId;
    const { lifetime, mountedRef } = useCanvasOwnerLifetime(canvasId);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<CanvasUploadTarget | null>(null);
    const assetInsertPositionRef = useRef<Position | null>(null);
    const uploadStatusIdRef = useRef(0);
    const statusTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [uploadModalOpen, setUploadModalOpen] = useState(false);
    const [uploadStatus, setUploadStatus] = useState<CanvasUploadStatus | null>(null);

    useEffect(() => () => {
        statusTimersRef.current.forEach((timer) => clearTimeout(timer));
    }, []);

    const startUploadStatus = useCallback<StartCanvasUploadStatus>((title, detail, total = 3) => {
        const id = (uploadStatusIdRef.current += 1);
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        if (guard.alive()) setUploadStatus({ id, title, detail, step: 1, total });
        const dismiss = (delay: number) => {
            const timer = setTimeout(() => {
                statusTimersRef.current.delete(timer);
                if (!guard.alive()) return;
                setUploadStatus((current) => (current?.id === id ? null : current));
            }, delay);
            (timer as { unref?: () => void }).unref?.();
            statusTimersRef.current.add(timer);
        };
        return {
            update: (nextDetail: string, step: number) => {
                if (!guard.alive()) return;
                setUploadStatus((current) => (current?.id === id ? { ...current, detail: nextDetail, step: Math.min(Math.max(step, 1), total) } : current));
            },
            done: (nextDetail = "处理完成") => {
                if (!guard.alive()) return;
                setUploadStatus((current) => (current?.id === id ? { ...current, detail: nextDetail, step: total, done: true } : current));
                dismiss(850);
            },
            fail: (nextDetail = "处理失败") => {
                if (!guard.alive()) return;
                setUploadStatus((current) => (current?.id === id ? { ...current, detail: nextDetail, error: true } : current));
                dismiss(1800);
            },
        };
    }, [canvasId, lifetime, mountedRef]);

    const selectInsertedNode = useCallback((nodeId: string, dialog: "open" | "close" | "preserve") => {
        pageUi.getState().setSelectedNodeIds(new Set([nodeId]));
        pageUi.getState().setSelectedConnectionId(null);
        if (dialog !== "preserve") pageUi.getState().setDialogNodeId(dialog === "open" ? nodeId : null);
    }, [pageUi]);

    const persistMediaNode = useCallback(async (node: CanvasNodeData, signal?: AbortSignal) => {
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        const result = await persistOwnedCanvasUploadNode({
            owner: guard.owner,
            getLiveCanvasId: () => canvasIdRef.current,
            getLiveLifetime: () => lifetime.current(),
            mounted: () => mountedRef.current,
            canvasId,
            domainProjectId,
            node,
            signal: signal ?? guard.signal,
        }, {
            ensureCanvasNodeAsset,
            nodesRef,
            setNodes,
            invalidateProject: domainProjectId
                ? async (projectId) => { await queryClient.invalidateQueries({ queryKey: ["project", projectId] }); }
                : undefined,
            warn: (text) => message.warning(text),
        });
        return result.confirmed;
    }, [canvasId, domainProjectId, lifetime, message, mountedRef, nodesRef, queryClient, setNodes]);

    const persistTimelineMedia = useCallback(async (media: TimelineDirectMedia, signal?: AbortSignal) => {
        const type = media.kind === "audio" ? CanvasNodeType.Audio : media.kind === "video" ? CanvasNodeType.Video : CanvasNodeType.Image;
        const defaults = NODE_DEFAULT_SIZE[type];
        const node: CanvasNodeData = {
            id: media.id,
            type,
            title: media.title,
            position: { x: 0, y: 0 },
            width: media.width || defaults.width,
            height: media.height || defaults.height,
            metadata: {
                content: media.url || media.dataUrl || media.content || "",
                storageKey: media.storageKey,
                naturalWidth: media.width,
                naturalHeight: media.height,
                durationMs: media.durationMs,
                bytes: media.bytes,
                mimeType: media.mimeType,
            },
        };
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        const result = await persistOwnedCanvasUploadNode({
            owner: guard.owner,
            getLiveCanvasId: () => canvasIdRef.current,
            getLiveLifetime: () => lifetime.current(),
            mounted: () => mountedRef.current,
            canvasId,
            domainProjectId,
            node,
            signal: signal ?? guard.signal,
        }, {
            ensureCanvasNodeAsset,
            setNodes,
            invalidateProject: domainProjectId
                ? async (projectId) => { await queryClient.invalidateQueries({ queryKey: ["project", projectId] }); }
                : undefined,
        });
        return result.applied ? result.assetId : undefined;
    }, [canvasId, domainProjectId, lifetime, mountedRef, queryClient, setNodes]);

    const activeUploadsRef = useRef(new Set<string>());
    const createFileNode = useCallback(async (file: File, position: Position, replaceId?: string) => {
        const original = replaceId ? nodesRef.current.find((node) => node.id === replaceId) : undefined;
        if (replaceId && (!original || activeUploadsRef.current.has(replaceId))) return null;
        const id = replaceId || `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        activeUploadsRef.current.add(id);
        pageUi.getState().setUploadProgress(id, undefined);
        const progress = startUploadStatus(replaceId ? "替换文件" : "上传文件", "读取文件信息", domainProjectId ? 4 : 3);
        let placeholderApplied = false;
        const uploadAttemptId = createFileUploadAttemptId();
        const supportedType = resolveScriptOrUploadNodeType(file, uploadNodeType(file));
        try {
            if (replaceId && supportedType) {
                onCancelNodeGeneration?.(replaceId);
                const applyInitialReplacement = (current: CanvasNodeData[]) =>
                    applyInitialReplacementUploadPlaceholder(current, id, uploadAttemptId);
                placeholderApplied = true;
                nodesRef.current = applyInitialReplacement(nodesRef.current);
                setNodes(applyInitialReplacement);
            }
            const placeholder = await createScriptDocumentUploadPlaceholder(
                id,
                file,
                position,
                () => createFileUploadPlaceholder(id, file, position, uploadAttemptId),
            );
            if (!guard.alive()) return null;
            const applyPlaceholder = (current: CanvasNodeData[]) =>
                applyDecodedUploadPlaceholder(current, placeholder, uploadAttemptId, replaceId);
            placeholderApplied = true;
            nodesRef.current = applyPlaceholder(nodesRef.current);
            setNodes(applyPlaceholder);
            selectInsertedNode(id, "close");
            let lastPercent: number | undefined;
            const onProgress = (loaded: number, total: number) => {
                if (!guard.alive()) return;
                const percent = uploadPercent(loaded, total);
                if (percent === undefined || percent === lastPercent) return;
                lastPercent = percent;
                pageUi.getState().setUploadProgress(id, percent);
                progress.update(percent === 100 ? "文件已传输，正在保存与处理" : `已上传 ${percent}%`, 2);
            };
            const localRuntime = isLocalRuntimeMode();
            progress.update(localRuntime ? "保存文件到本地资源目录" : "上传文件并同步资源", 2);
            let metadata: CanvasNodeData["metadata"];
            if (placeholder.type === CanvasNodeType.Image) {
                metadata = imageMetadata(await uploadImage(file, onProgress));
            } else if (placeholder.type === CanvasNodeType.Text) {
                const { title: docTitle, content } = await extractScriptDocumentText(file);
                if (!guard.alive()) return null;
                if (docTitle) placeholder.title = docTitle;
                const uploaded = await uploadMediaFile(file, "file", onProgress);
                metadata = { content, prompt: content, storageKey: uploaded.storageKey, mimeType: uploaded.mimeType || file.type || "text/plain", bytes: uploaded.bytes, status: "success" };
            } else {
                const media = await uploadMediaFile(file, placeholder.type === CanvasNodeType.Video ? "video" : "audio", onProgress);
                metadata = placeholder.type === CanvasNodeType.Video ? videoMetadata(media) : audioMetadata(media);
            }
            if (!guard.alive()) return null;
            progress.update("更新画布节点", 3);
            const currentNode = nodesRef.current.find((item) => item.id === id);
            if (!currentNode) {
                progress.done("上传完成，画布占位已移除");
                return null;
            }
            const node = buildSettledUploadedCanvasNode(currentNode, placeholder, metadata, {
                replace: Boolean(replaceId),
                attemptId: uploadAttemptId,
            });
            const applyUploadedNode = (current: CanvasNodeData[]) =>
                current.map((item) => (item.id === id ? node : item));
            nodesRef.current = applyUploadedNode(nodesRef.current);
            setNodes(applyUploadedNode);
            if (domainProjectId) progress.update("写入项目资产", 4);
            const persisted = await persistMediaNode(node, guard.signal);
            if (!guard.alive()) return null;
            const browserFallback = Boolean(metadata.storageKey && !resourceIdFromStorageKey(metadata.storageKey));
            // Keep the mode decision from the start of this upload. Runtime
            // hydration can finish while the file is being processed; reading
            // the global mode again here could produce contradictory local and
            // remote messages for one upload.
            const localOnly = browserFallback && localRuntime;
            const remotePending = browserFallback && !localRuntime;
            progress.done(localOnly ? "已保存在本机" : remotePending ? "已保存在本机，等待远端同步" : persisted ? "文件已添加到画布" : "文件已添加，项目资产待重试");
            if (remotePending) message.warning("已保存在本机缓存，资源服务暂不可用；等待远端同步");
            return id;
        } catch (error) {
            if (shouldSuppressOwnedCanvasCallback(error, {
                owner: guard.owner,
                liveCanvasId: canvasIdRef.current,
                liveLifetime: lifetime.current(),
                mounted: mountedRef.current,
                signal: guard.signal,
            })) return null;
            const details = error instanceof Error ? error.message : "文件上传失败";
            if (placeholderApplied) {
                const applyFailedUpload = (current: CanvasNodeData[]) =>
                    current.map((item) => (item.id !== id ? item : restoreFailedUploadNode(item, original, details)));
                nodesRef.current = applyFailedUpload(nodesRef.current);
                setNodes(applyFailedUpload);
            }
            progress.fail(details);
            message.error(details);
            return null;
        } finally {
            pageUi.getState().setUploadProgress(id, undefined);
            activeUploadsRef.current.delete(id);
        }
    }, [canvasId, domainProjectId, lifetime, message, mountedRef, nodesRef, onCancelNodeGeneration, pageUi, persistMediaNode, selectInsertedNode, setNodes, startUploadStatus]);

    const createImageAssetNode = useCallback(async (asset: ImageAsset, position?: Position) => {
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        try {
            let storageKey = ownedResourceStorageKey(asset.data.storageKey, asset.data.dataUrl || asset.coverUrl);
            let content = storageKey ? await resolveImageUrl(storageKey, asset.data.dataUrl || asset.coverUrl) : asset.data.dataUrl || asset.coverUrl;
            if (!guard.alive()) return;
            if (!content) {
                message.error("素材图片不可用");
                return;
            }
            // Legacy browser assets can still contain data URLs. They are fine
            // for previewing, but the desktop canvas contract rejects inline
            // media so documents stay small and resource cleanup can track
            // references. Promote the bytes before inserting the node.
            if (content.startsWith("data:image/") || !resourceIdFromStorageKey(storageKey || "")) {
                const uploaded = await uploadImage(content);
                if (!guard.alive()) return;
                content = uploaded.url;
                storageKey = uploaded.storageKey;
            }
            // Canvas persistence intentionally requires an Asset -> Resource
            // pair. Keep that invariant by migrating the legacy library record
            // before the node that references it can be auto-saved.
            if (resourceIdFromStorageKey(storageKey)) {
                await http.put(`/assets/${encodeURIComponent(asset.id)}`, {
                    asset: {
                        ...asset,
                        coverUrl: content,
                        data: { ...asset.data, dataUrl: content, storageKey },
                        updatedAt: new Date().toISOString(),
                    },
                }, { signal: guard.signal });
                if (!guard.alive()) return;
            }
            const size = fitNodeSize(asset.data.width || NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, asset.data.height || NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
            const center = position || getCanvasCenter();
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: asset.title || "素材图片",
                position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: mediaResultMetadata("library", {
                    content,
                    storageKey,
                    status: NODE_STATUS_SUCCESS,
                    naturalWidth: asset.data.width,
                    naturalHeight: asset.data.height,
                    bytes: asset.data.bytes || getDataUrlByteSize(content.startsWith("data:") ? content : ""),
                    mimeType: asset.data.mimeType || "image/png",
                    prompt: typeof asset.metadata?.prompt === "string" ? asset.metadata.prompt : asset.title,
                    assetId: asset.id,
                    assetTags: asset.tags || [],
                }),
            };
            setNodes((current) => [...current, node]);
            selectInsertedNode(id, "close");
        } catch (error) {
            if (guard.suppress(error)) return;
            message.error(error instanceof Error ? error.message : "素材图片读取失败");
        }
    }, [canvasId, getCanvasCenter, lifetime, message, mountedRef, selectInsertedNode, setNodes]);

    const createTextNodeFromClipboard = useCallback((text: string, position?: Position) => {
        const trimmed = text.trim();
        if (!trimmed) return false;
        const node = {
            ...createCanvasNode(CanvasNodeType.Text, position || getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
            title: trimmed.slice(0, 32) || "剪切板文本",
        };
        setNodes((current) => [...current, node]);
        selectInsertedNode(node.id, "open");
        pageUi.getState().setContextMenu(null);
        return true;
    }, [pageUi, getCanvasCenter, selectInsertedNode, setNodes]);

    const handleProjectChapterInsert = useCallback(async (chapter: CanvasProjectChapterPayload, position?: Position) => {
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        let sourceText = chapter.sourceText;
        if (sourceText === undefined) {
            try {
                sourceText = (await getProjectUnit(chapter.projectId, chapter.id, guard.signal)).unit.sourceText;
            } catch (error) {
                if (guard.suppress(error)) return;
                message.error(error instanceof Error ? `章节正文读取失败：${error.message}` : "章节正文读取失败");
                return;
            }
        }
        if (!guard.alive()) return;
        const content = htmlToPlainText(sourceText);
        const node = createCanvasNode(CanvasNodeType.Text, position || getCanvasCenter(), {
            content,
            prompt: content,
            status: NODE_STATUS_SUCCESS,
            workflowKind: "free",
            workflowTitle: "项目章节",
            workflowDescription: `第 ${chapter.position + 1} 章`,
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            fontSize: 14,
        });
        node.title = `章节 · ${chapter.title}`;
        node.width = 460;
        node.height = 280;
        setNodes((current) => [...current, node]);
        selectInsertedNode(node.id, "preserve");
        pageUi.getState().setContextMenu(null);
        message.success(`已添加“${chapter.title}”`);
    }, [pageUi, canvasId, getCanvasCenter, lifetime, message, mountedRef, selectInsertedNode, setNodes]);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        const target = nodeId ? nodesRef.current.find((node) => node.id === nodeId) : null;
        if (imageInputRef.current) {
            imageInputRef.current.accept = target?.type === CanvasNodeType.Image ? "image/*"
                : target?.type === CanvasNodeType.Video ? "video/*"
                : target?.type === CanvasNodeType.Audio ? "audio/*,.mp3,.wav"
                : target?.type === CanvasNodeType.Text || target?.type === CanvasNodeType.Script ? SCRIPT_DOCUMENT_ACCEPT : `${CANVAS_UPLOAD_ACCEPT},.docx`;
            imageInputRef.current.multiple = !nodeId;
        }
        if (nodeId) imageInputRef.current?.click();
        else setUploadModalOpen(true);
    }, [nodesRef]);

    const handleUploadReferenceRequest = useCallback((targetNodeId: string, position: Position) => {
        uploadTargetRef.current = { referenceToNodeId: targetNodeId, position };
        if (imageInputRef.current) {
            imageInputRef.current.accept = "image/*";
            imageInputRef.current.multiple = true;
        }
        setUploadModalOpen(true);
    }, []);

    // 时间线专用：把本地音视频文件上传为直连媒体（仅时间线作用域，不创建画布节点），返回媒体描述数组。
    const uploadTimelineMedia = useCallback(async (files: File[]): Promise<TimelineDirectMedia[]> => {
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        const supportedFiles = files.filter((file) => file.type.startsWith("video/") || isAudioFile(file));
        if (!supportedFiles.length) {
            message.warning("请选择视频、MP3 或 WAV 文件");
            return [];
        }
        const created: TimelineDirectMedia[] = [];
        for (const file of supportedFiles) {
            if (!guard.alive()) return [];
            try {
                if (isAudioFile(file)) {
                    const audio = await uploadMediaFile(file, "audio");
                    if (!guard.alive()) return [];
                    const media: TimelineDirectMedia = {
                        id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        kind: "audio",
                        title: file.name,
                        storageKey: audio.storageKey,
                        url: audio.url,
                        durationMs: audio.durationMs,
                        bytes: audio.bytes,
                        mimeType: audio.mimeType,
                    };
                    media.assetId = await persistTimelineMedia(media, guard.signal);
                    if (!guard.alive()) return [];
                    created.push(media);
                } else {
                    const video = await uploadMediaFile(file, "video");
                    if (!guard.alive()) return [];
                    const media: TimelineDirectMedia = {
                        id: `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        kind: "video",
                        title: file.name,
                        storageKey: video.storageKey,
                        url: video.url,
                        width: video.width,
                        height: video.height,
                        durationMs: video.durationMs,
                        bytes: video.bytes,
                        mimeType: video.mimeType,
                    };
                    media.assetId = await persistTimelineMedia(media, guard.signal);
                    if (!guard.alive()) return [];
                    created.push(media);
                }
            } catch (error) {
                if (guard.suppress(error)) return [];
                message.error(error instanceof Error ? `素材上传失败：${error.message}` : "素材上传失败");
            }
        }
        if (!guard.alive()) return [];
        if (created.length) message.success(`已上传 ${created.length} 个素材到时间线`);
        return created;
    }, [canvasId, lifetime, message, mountedRef, persistTimelineMedia]);

    // 组装能力闭环：把时间线合成结果（MP4 Blob）上传并创建为新的视频节点放回画布，
    // 复用上传/持久化/选中逻辑，新节点可继续编辑字幕与样式。
    const createVideoNodeFromBlob = useCallback(async (blob: Blob, title: string): Promise<CanvasNodeData | null> => {
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        const progress = startUploadStatus("合成视频片段", "上传合成结果", domainProjectId ? 4 : 3);
        try {
            const localRuntime = isLocalRuntimeMode();
            progress.update(localRuntime ? "保存合成结果到本地资源目录" : "上传到服务器并同步资源", 2);
            const video = await uploadMediaFile(blob, "video");
            if (!guard.alive()) return null;
            progress.update("更新画布节点", 3);
            const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
            const center = getCanvasCenter();
            const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node = {
                id,
                type: CanvasNodeType.Video,
                title,
                position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: { ...videoMetadata(video), status: NODE_STATUS_SUCCESS },
            } satisfies CanvasNodeData;
            setNodes((current) => [...current, node]);
            selectInsertedNode(id, "preserve");
            if (domainProjectId) progress.update("写入项目资产", 4);
            const persisted = await persistMediaNode(node, guard.signal);
            if (!guard.alive()) return null;
            progress.done(persisted ? "已生成新视频片段并加入项目资产" : "已生成新视频片段，项目资产待重试");
            return node;
        } catch (error) {
            if (guard.suppress(error)) return null;
            const details = error instanceof Error ? error.message : "合成视频片段失败";
            progress.fail(details);
            message.error(details);
            return null;
        }
    }, [canvasId, domainProjectId, getCanvasCenter, lifetime, message, mountedRef, persistMediaNode, selectInsertedNode, setNodes, startUploadStatus]);

    const openAssetsAtPosition = useCallback((position?: Position) => {
        assetInsertPositionRef.current = position || null;
        setAssetPickerOpen(true);
    }, []);

    const closeAssetPicker = useCallback(() => {
        assetInsertPositionRef.current = null;
        setAssetPickerOpen(false);
    }, []);

    const createAssetPayloadNode = useCallback(buildCanvasAssetPayloadNode, []);
    const createAssetPayloadNodes = useCallback(buildCanvasAssetPayloadNodes, []);

    const insertAssetPayloads = useCallback(async (payloads: InsertAssetPayload[], origin: Position, successMessage: string, failureMessage: string): Promise<CanvasNodeData[]> => {
        const owner = lifetime.capture(canvasId);
        let created: CanvasNodeData[] = [];
        try {
            const status = await runOwnedCanvasCreatedNodes({
                owner,
                getLiveCanvasId: () => canvasIdRef.current,
                getLiveLifetime: () => lifetime.current(),
                create: async () => {
                    created = await createAssetPayloadNodes(payloads, origin);
                    return created;
                },
                apply: (nodes) => {
                    setNodes((current) => {
                        const next = [...current, ...nodes];
                        nodesRef.current = next;
                        return next;
                    });
                    pageUi.getState().setSelectedNodeIds(new Set(nodes.map((node) => node.id)));
                    pageUi.getState().setSelectedConnectionId(null);
                    pageUi.getState().setDialogNodeId(null);
                },
            });
            if (status !== "committed") return [];
            const unboundNodes = canvasNodesMissingResourceAssetBinding(created);
            let allUnboundConfirmed = true;
            for (const unbound of unboundNodes) {
                const confirmed = await persistMediaNode(unbound);
                if (!confirmed) allUnboundConfirmed = false;
            }
            if (!lifetime.matches(owner, canvasIdRef.current)) {
                return [];
            }
            const createdIds = new Set(created.map((node) => node.id));
            const insertedNodes = nodesRef.current.filter((node) => createdIds.has(node.id));
            if (!allUnboundConfirmed) {
                message.warning("素材已添加到画布，但尚未同步到素材库，可在节点上重试");
                return insertedNodes;
            }
            message.success(successMessage);
            return insertedNodes;
        } catch (error) {
            if (!lifetime.matches(owner, canvasIdRef.current)) {
                return [];
            }
            message.error(error instanceof Error ? error.message : failureMessage);
            throw error;
        }
    }, [pageUi, canvasId, createAssetPayloadNodes, lifetime, message, nodesRef, persistMediaNode, setNodes]);

    const handleAssetsInsert = useCallback(async (payloads: InsertAssetPayload[]): Promise<CanvasNodeData[]> => {
        const origin = assetInsertPositionRef.current || getCanvasCenter();
        return insertAssetPayloads(payloads, origin, `已插入 ${payloads.length} 项素材`, "素材插入失败");
    }, [getCanvasCenter, insertAssetPayloads]);

    const handleProjectAssetsInsert = useCallback(async (payloads: InsertAssetPayload[], position?: Position): Promise<CanvasNodeData[]> => {
        const origin = position || getCanvasCenter();
        return insertAssetPayloads(payloads, origin, `已引入 ${payloads.length} 项项目资产`, "项目资产引入失败");
    }, [getCanvasCenter, insertAssetPayloads]);

    const dnd = useCanvasUploadDnd({
        pageUi,
        canvasId,
        canvasIdRef,
        lifetime,
        mountedRef,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        uploadTargetRef,
        getCanvasCenter,
        screenToCanvas,
        setNodes,
        setConnections,
        selectInsertedNode,
        persistMediaNode,
        createFileNode,
        createImageAssetNode,
        createTextNodeFromClipboard,
        handleProjectChapterInsert,
        onCancelNodeGeneration,
        message,
    });

    return {
        assetPickerOpen,
        uploadModalOpen,
        closeUploadModal: () => setUploadModalOpen(false),
        handleImportUrl: dnd.handleImportUrl,
        closeAssetPicker,
        createVideoNodeFromBlob,
        createAssetPayloadNode,
        createAssetPayloadNodes,
        createImageAssetNode,
        fileDropActive: dnd.fileDropActive,
        handleAssetsInsert,
        handleDrop: dnd.handleDrop,
        handleFileDragEnter: dnd.handleFileDragEnter,
        handleFileDragLeave: dnd.handleFileDragLeave,
        handleFileDragOver: dnd.handleFileDragOver,
        handleImageInputChange: dnd.handleImageInputChange,
        handleProjectAssetsInsert,
        handleProjectChapterInsert,
        handleUploadFiles: dnd.handleUploadFiles,
        handleUploadRequest,
        handleUploadReferenceRequest,
        imageInputRef,
        openAssetsAtPosition,
        pasteAssistantImage: dnd.pasteAssistantImage,
        pasteSystemClipboard: dnd.pasteSystemClipboard,
        replaceNodeMedia: dnd.replaceNodeMedia,
        createFileNode,
        startUploadStatus,
        uploadStatus,
        uploadTimelineMedia,
    };
}
