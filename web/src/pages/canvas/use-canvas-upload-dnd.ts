import { useCallback, useRef, useState, type ChangeEvent, type Dispatch, type DragEvent, type SetStateAction } from "react";
import type { MessageInstance } from "antd/es/message/interface";

import { CANVAS_IMAGE_ASSET_DND_TYPE } from "@/components/canvas/canvas-asset-tray";
import { CANVAS_PROJECT_CHAPTER_DND_TYPE, type CanvasProjectChapterPayload } from "@/components/canvas/canvas-project-sidebar";
import { isCanvasNodeClipboardMarker, readCanvasClipboard } from "@/lib/canvas/canvas-clipboard";
import { buildSettledUploadNodeMetadata, clearReplacedGenerationTaskMetadata, createFileUploadAttemptId, uploadNodeType } from "@/lib/canvas/canvas-file-upload";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { connectDirectorReferenceNodes } from "@/lib/canvas/director/director-reference-assets";
import { extractScriptDocumentText, isScriptDocumentFile, resolveScriptOrUploadNodeType } from "@/lib/canvas/script-document-import";
import { createClientId } from "@/lib/client-id";
import { isReferenceHTTPSLink } from "@/services/api/reference-link-replacement";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

import type { CanvasOwnerLifetime } from "./canvas-owner-epoch";
import { BATCH_UPLOAD_COLUMN_GAP, BATCH_UPLOAD_COLUMNS, BATCH_UPLOAD_ROW_GAP } from "./canvas-upload-asset-payload";
import { createOwnedCanvasUploadGuard } from "./canvas-upload-ownership";

export type CanvasUploadTarget = {
    nodeId?: string;
    referenceToNodeId?: string;
    position?: Position;
};

type UseCanvasUploadDndOptions = {
    pageUi: CanvasPageUiStoreHook;
    canvasId: string;
    canvasIdRef: { current: string };
    lifetime: CanvasOwnerLifetime;
    mountedRef: { current: boolean };
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    selectedNodeIdsRef: { current: Set<string> };
    uploadTargetRef: { current: CanvasUploadTarget | null };
    getCanvasCenter: () => Position;
    screenToCanvas: (clientX: number, clientY: number) => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    selectInsertedNode: (nodeId: string, dialog: "open" | "close" | "preserve") => void;
    persistMediaNode: (node: CanvasNodeData, signal?: AbortSignal) => Promise<boolean>;
    createFileNode: (file: File, position: Position, replaceId?: string) => Promise<string | null>;
    createImageAssetNode: (asset: ImageAsset, position?: Position) => Promise<void>;
    createTextNodeFromClipboard: (text: string, position?: Position) => boolean;
    handleProjectChapterInsert: (chapter: CanvasProjectChapterPayload, position?: Position) => Promise<void>;
    onCancelNodeGeneration?: (nodeId: string) => void;
    message: Pick<MessageInstance, "success" | "warning" | "error">;
};

const CANVAS_BATCH_TABLE_SELECTOR = "[data-canvas-batch-table]";

function isBatchTableDragEvent(event: DragEvent<HTMLElement>) {
    const target = event.target instanceof Element ? event.target : null;
    return Boolean(target?.closest(CANVAS_BATCH_TABLE_SELECTOR));
}

function hasDraggedFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
}

function parseProjectChapterPayload(value: string): CanvasProjectChapterPayload | null {
    if (!value) return null;
    try {
        const payload = JSON.parse(value) as Partial<CanvasProjectChapterPayload>;
        const validSource = payload.sourceText === undefined || typeof payload.sourceText === "string";
        return typeof payload.id === "string"
            && typeof payload.projectId === "string"
            && typeof payload.title === "string"
            && validSource
            && typeof payload.position === "number"
            ? (payload as CanvasProjectChapterPayload)
            : null;
    } catch {
        return null;
    }
}

export function useCanvasUploadDnd({
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
}: UseCanvasUploadDndOptions) {
    const fileDragDepthRef = useRef(0);
    const [fileDropActive, setFileDropActive] = useState(false);

    const handleUploadFiles = useCallback(async (files: File[]) => {
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        const current = () => guard.alive();
        const uploadTarget = uploadTargetRef.current;
        const supportedFiles = files.filter((file) => uploadTarget?.referenceToNodeId
            ? uploadNodeType(file) === CanvasNodeType.Image
            : Boolean(resolveScriptOrUploadNodeType(file, uploadNodeType(file))));
        if (!supportedFiles.length) {
            message.warning(uploadTarget?.referenceToNodeId ? "请选择图片作为导演台参考素材" : "请选择图片、视频、音频或剧本/文档文件 (.docx/.txt/.md)");
            return false;
        }
        const center = uploadTarget?.position || getCanvasCenter();
        const columns = Math.min(BATCH_UPLOAD_COLUMNS, supportedFiles.length);
        const originX = center.x - ((columns - 1) * BATCH_UPLOAD_COLUMN_GAP) / 2;
        const createdIds: string[] = [];
        for (let index = 0; index < supportedFiles.length; index += 1) {
            if (!current()) return false;
            const file = supportedFiles[index];
            const position = {
                x: originX + (index % columns) * BATCH_UPLOAD_COLUMN_GAP,
                y: center.y + Math.floor(index / columns) * BATCH_UPLOAD_ROW_GAP,
            };
            const createdId = await createFileNode(file, position);
            if (!current()) return false;
            if (createdId) createdIds.push(createdId);
        }
        if (!createdIds.length || !current()) return false;
        let linkedReferenceCount = 0;
        if (uploadTarget?.referenceToNodeId) {
            const linked = connectDirectorReferenceNodes(
                nodesRef.current,
                connectionsRef.current,
                createdIds,
                uploadTarget.referenceToNodeId,
                () => `director-reference-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            );
            linkedReferenceCount = linked.linkedSourceIds.length;
            if (linked.nodes !== nodesRef.current) {
                nodesRef.current = linked.nodes;
                setNodes(linked.nodes);
            }
            if (linked.connections !== connectionsRef.current) {
                connectionsRef.current = linked.connections;
                setConnections(linked.connections);
            }
        }
        if (!current()) return false;
        pageUi.getState().setSelectedNodeIds(new Set(createdIds));
        pageUi.getState().setSelectedConnectionId(null);
        pageUi.getState().setDialogNodeId(null);
        const failedCount = supportedFiles.length - createdIds.length;
        if (uploadTarget?.referenceToNodeId) {
            if (linkedReferenceCount) message.success(`已添加并连接 ${linkedReferenceCount} 张参考图`);
            else message.warning("参考图已上传到画布，但导演节点已不存在；可手动连接素材节点");
        } else if (failedCount) {
            message.warning(`已添加 ${createdIds.length} 个文件，${failedCount} 个上传失败`);
        } else {
            message.success(`已添加 ${createdIds.length} 个文件到画布`);
        }
        return true;
    }, [canvasId, canvasIdRef, connectionsRef, createFileNode, getCanvasCenter, lifetime, message, mountedRef, nodesRef, pageUi, setConnections, setNodes, uploadTargetRef]);

    const handleImportUrl = useCallback(async (url: string, kind: "image" | "video" | "audio") => {
        if (!isReferenceHTTPSLink(url)) throw new Error("请填写不含账号密码的 HTTPS 素材网址");
        const target = uploadTargetRef.current;
        if (target?.referenceToNodeId && kind !== "image") throw new Error("导演台参考素材请选择图片");
        const type = kind === "image" ? CanvasNodeType.Image : kind === "video" ? CanvasNodeType.Video : CanvasNodeType.Audio;
        const existing = target?.nodeId ? nodesRef.current.find((node) => node.id === target.nodeId) : undefined;
        if (existing && existing.type !== type) throw new Error("素材类型须与当前节点一致");
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        if (existing) onCancelNodeGeneration?.(existing.id);
        const importAttemptId = createFileUploadAttemptId();
        const createdFresh = !existing ? createCanvasNode(type, target?.position || getCanvasCenter(), { content: url }) : null;
        const node = existing
            ? {
                ...existing,
                metadata: mediaResultMetadata(
                    "imported",
                    buildSettledUploadNodeMetadata(
                        existing.metadata,
                        { content: url, storageKey: undefined, assetId: undefined, status: "success" },
                        { replace: true, preserveFreeResize: Boolean(existing.metadata?.freeResize), attemptId: importAttemptId },
                    ),
                ),
            }
            : {
                ...createdFresh!,
                title: new URL(url).pathname.split("/").pop() || "在线素材",
                metadata: mediaResultMetadata("imported", { ...createdFresh!.metadata, content: url, status: "success", fileUploadAttemptId: importAttemptId }),
            };
        if (!guard.alive()) return false;
        const applyImportedNode = (current: CanvasNodeData[]) =>
            existing ? current.map((item) => (item.id === node.id ? node : item)) : [...current, node];
        nodesRef.current = applyImportedNode(nodesRef.current);
        setNodes(applyImportedNode);
        const persisted = await persistMediaNode(node, guard.signal);
        if (!guard.alive()) return false;
        if (!persisted) {
            selectInsertedNode(node.id, "close");
            return true;
        }
        if (target?.referenceToNodeId) {
            const persistedNode = nodesRef.current.find((item) => item.id === node.id) ?? node;
            const linked = connectDirectorReferenceNodes(
                [...nodesRef.current.filter((item) => item.id !== node.id), persistedNode],
                connectionsRef.current,
                [node.id],
                target.referenceToNodeId,
                () => createClientId(),
            );
            nodesRef.current = linked.nodes;
            connectionsRef.current = linked.connections;
            setNodes(linked.nodes);
            setConnections(linked.connections);
        }
        selectInsertedNode(node.id, "close");
        message.success("已添加在线素材");
        return true;
    }, [canvasId, canvasIdRef, connectionsRef, getCanvasCenter, lifetime, message, mountedRef, nodesRef, onCancelNodeGeneration, persistMediaNode, selectInsertedNode, setConnections, setNodes, uploadTargetRef]);

    const replaceNodeMedia = useCallback(async (nodeId: string, file: File) => {
        const currentNode = nodesRef.current.find((node) => node.id === nodeId);
        const fileNodeType = resolveScriptOrUploadNodeType(file, uploadNodeType(file));
        if (!currentNode || !fileNodeType) return false;
        if (currentNode.type === CanvasNodeType.Script && isScriptDocumentFile(file)) {
            onCancelNodeGeneration?.(nodeId);
            const scriptAttemptId = createFileUploadAttemptId();
            const { title, content } = await extractScriptDocumentText(file);
            const applyScriptReplacement = (current: CanvasNodeData[]) =>
                current.map((item) =>
                    item.id === nodeId
                        ? {
                            ...item,
                            title: title || item.title,
                            metadata: {
                                ...clearReplacedGenerationTaskMetadata(item.metadata),
                                resultOrigin: "upload" as const,
                                fileUploadAttemptId: scriptAttemptId,
                                composerContent: content,
                                prompt: content,
                                status: "success" as const,
                            },
                        }
                        : item,
                );
            nodesRef.current = applyScriptReplacement(nodesRef.current);
            setNodes(applyScriptReplacement);
            return true;
        }
        const typedNode = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text].includes(currentNode.type as CanvasNodeType);
        if (typedNode && fileNodeType !== currentNode.type) return false;
        return Boolean(await createFileNode(file, currentNode.position, nodeId));
    }, [createFileNode, nodesRef, onCancelNodeGeneration, setNodes]);

    const pasteSystemClipboard = useCallback(async (position?: Position, clipboardEvent?: ClipboardEvent | null) => {
        const selected = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id));
        const replaceId = selected.length === 1 && selected[0].type === CanvasNodeType.Image ? selected[0].id : null;
        const pastePosition = position || getCanvasCenter();
        const guard = createOwnedCanvasUploadGuard({
            lifetime,
            canvasId,
            getLiveCanvasId: () => canvasIdRef.current,
            mounted: () => mountedRef.current,
        });
        const pasteImageFile = async (file: File) => {
            if (!guard.alive()) return false;
            if (replaceId) {
                const replaced = await replaceNodeMedia(replaceId, file);
                if (replaced && guard.alive()) message.success("已用剪切板图片替换，可撤销恢复");
                return true;
            }
            const inserted = await createFileNode(file, pastePosition);
            if (inserted && guard.alive()) message.success("已从剪切板添加图片");
            return Boolean(inserted);
        };

        try {
            const content = await readCanvasClipboard(clipboardEvent, navigator.clipboard);
            if (!guard.alive()) return false;
            if (typeof content !== "string") return await pasteImageFile(content);
            if (isCanvasNodeClipboardMarker(content)) return false;
            if (createTextNodeFromClipboard(content, pastePosition)) {
                message.success("已从剪切板添加文本");
                return true;
            }
        } catch {
            if (guard.alive()) message.warning("粘贴未完成，请重试");
        }
        return false;
    }, [canvasId, canvasIdRef, createFileNode, createTextNodeFromClipboard, getCanvasCenter, lifetime, message, mountedRef, nodesRef, replaceNodeMedia, selectedNodeIdsRef]);

    const handleImageInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        const file = files[0];
        const target = uploadTargetRef.current;
        try {
            const fileNodeType = file ? resolveScriptOrUploadNodeType(file, uploadNodeType(file)) : null;
            if (!file || !fileNodeType) return;
            if (target?.nodeId) {
                const targetNode = nodesRef.current.find((node) => node.id === target.nodeId);
                const compatible = targetNode && (targetNode.type === fileNodeType || (targetNode.type === CanvasNodeType.Script && isScriptDocumentFile(file))
                    || ![CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text].includes(targetNode.type as CanvasNodeType));
                if (!compatible) {
                    message.warning("请选择与当前节点相同类型的媒体文件");
                    return;
                }
                await replaceNodeMedia(target.nodeId, file);
                return;
            }
            await handleUploadFiles(files);
        } finally {
            uploadTargetRef.current = null;
            event.target.value = "";
        }
    }, [handleUploadFiles, message, nodesRef, replaceNodeMedia, uploadTargetRef]);

    const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (isBatchTableDragEvent(event)) {
            event.preventDefault();
            fileDragDepthRef.current = 0;
            setFileDropActive(false);
            return;
        }
        event.preventDefault();
        fileDragDepthRef.current = 0;
        setFileDropActive(false);
        const chapterPayload = parseProjectChapterPayload(event.dataTransfer.getData(CANVAS_PROJECT_CHAPTER_DND_TYPE));
        if (chapterPayload) {
            void handleProjectChapterInsert(chapterPayload, screenToCanvas(event.clientX, event.clientY));
            return;
        }
        const imageAssetId = event.dataTransfer.getData(CANVAS_IMAGE_ASSET_DND_TYPE);
        if (imageAssetId) {
            const asset = useAssetStore.getState().assets.find((item): item is ImageAsset => item.kind === "image" && item.id === imageAssetId);
            if (!asset) {
                message.warning("素材不存在");
                return;
            }
            void createImageAssetNode(asset, screenToCanvas(event.clientX, event.clientY));
            return;
        }
        const files = Array.from(event.dataTransfer.files).filter((item) => resolveScriptOrUploadNodeType(item, uploadNodeType(item)));
        if (!files.length) return;
        if (files.length > 1) {
            void handleUploadFiles(files);
            return;
        }
        const file = files[0];
        const fileNodeType = resolveScriptOrUploadNodeType(file, uploadNodeType(file));
        const position = screenToCanvas(event.clientX, event.clientY);
        const target = [...nodesRef.current].reverse().find((node) => {
            const compatible = node.type === fileNodeType || (node.type === CanvasNodeType.Script && isScriptDocumentFile(file));
            return compatible && position.x >= node.position.x && position.x <= node.position.x + node.width && position.y >= node.position.y && position.y <= node.position.y + node.height;
        });
        if (target) {
            void replaceNodeMedia(target.id, file).then((replaced) => {
                if (replaced) message.success("媒体已替换，可撤销恢复");
            });
            return;
        }
        void createFileNode(file, position);
    }, [createFileNode, createImageAssetNode, handleProjectChapterInsert, handleUploadFiles, message, nodesRef, replaceNodeMedia, screenToCanvas]);

    const handleFileDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (isBatchTableDragEvent(event)) {
            event.preventDefault();
            fileDragDepthRef.current = 0;
            setFileDropActive(false);
            return;
        }
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        fileDragDepthRef.current += 1;
        setFileDropActive(true);
    }, []);

    const handleFileDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (isBatchTableDragEvent(event)) {
            event.preventDefault();
            fileDragDepthRef.current = 0;
            setFileDropActive(false);
            return;
        }
        if (!hasDraggedFiles(event) && !Array.from(event.dataTransfer.types).includes(CANVAS_PROJECT_CHAPTER_DND_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }, []);

    const handleFileDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (isBatchTableDragEvent(event)) {
            event.preventDefault();
            fileDragDepthRef.current = 0;
            setFileDropActive(false);
            return;
        }
        if (!hasDraggedFiles(event)) return;
        fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
        if (fileDragDepthRef.current === 0) setFileDropActive(false);
    }, []);

    const pasteAssistantImage = useCallback((file: File) => {
        void createFileNode(file, getCanvasCenter()).then((inserted) => {
            if (inserted) message.success("已从剪切板添加图片");
        });
    }, [createFileNode, getCanvasCenter, message]);

    return {
        fileDropActive,
        handleDrop,
        handleFileDragEnter,
        handleFileDragLeave,
        handleFileDragOver,
        handleImageInputChange,
        handleImportUrl,
        handleUploadFiles,
        pasteAssistantImage,
        pasteSystemClipboard,
        replaceNodeMedia,
    };
}
