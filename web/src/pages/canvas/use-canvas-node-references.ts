import { useCallback, useEffect, useRef } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";
import { applyCanvasConnectionPromptSync, reorderCanvasResourceConnections, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { replaceCanvasNodeReference } from "@/lib/canvas/canvas-reference-replace";
import { connectAndAppendCanvasResourceMention, connectCanvasResourceMention, registerCanvasPickConnectHandler } from "@/lib/canvas/canvas-text-mention";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import type { useCanvasDocumentState } from "./use-canvas-document-state";
import type { useCanvasUpload } from "./use-canvas-upload";
import { useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import { createCanvasMediaOperation } from "./canvas-media-operation";

type Options = {
    projectId: string;
    document: ReturnType<typeof useCanvasDocumentState>;
    pageUi: CanvasPageUiStoreHook;
    uploads: Pick<ReturnType<typeof useCanvasUpload>, "replaceNodeMedia">;
};

export function useCanvasNodeReferences({ projectId, document, pageUi, uploads }: Options) {
    const { message } = App.useApp();
    const { nodesRef, connectionsRef, setNodes, setConnections } = document;
    const { replaceNodeMedia } = uploads;
    const { setSelectedConnectionId } = pageUi.getState();
    const canvasIdRef = useRef(projectId);
    canvasIdRef.current = projectId;
    const { lifetime, mountedRef } = useCanvasOwnerLifetime(projectId);
    const handleReplaceNodeReference = useCallback(
        (targetNodeId: string, oldReference: { id: string; nodeId?: string; label?: string; title?: string }, sourceNodeId: string) => {
            const result = replaceCanvasNodeReference(nodesRef.current, connectionsRef.current, targetNodeId, oldReference, sourceNodeId);
            if (!result.notice) return;
            nodesRef.current = result.nodes;
            connectionsRef.current = result.connections;
            setNodes(result.nodes);
            setConnections(result.connections);
            message.success(result.notice);
        },
        [connectionsRef, message, nodesRef, setConnections, setNodes],
    );

    const handleReplaceNodeReferenceFiles = useCallback(
        (_targetNodeId: string, oldReference: { id: string; nodeId?: string; label?: string; title?: string }, files: File[]) => {
            const file = files.find((f) => f.type.startsWith("image/"));
            if (!file || !oldReference.nodeId) return;
            const operation = createCanvasMediaOperation(lifetime, projectId, () => canvasIdRef.current, () => mountedRef.current);
            void replaceNodeMedia(oldReference.nodeId, file).then((success: boolean) => {
                if (operation.isCurrent() && success) {
                    message.success("参考图片已替换");
                }
            }).catch(error => { if (operation.isCurrent()) void message.error(error instanceof Error ? error.message : "参考图片替换失败"); });
        },
        [message, replaceNodeMedia, lifetime, projectId, mountedRef],
    );

    const handleRemoveNodeReference = useCallback(
        (targetNodeId: string, reference: CanvasResourceReference) => {
            const referenceNodeId = reference.nodeId;
            if (!referenceNodeId) return;
            // 生成节点可能通过配置节点接收参考，只移除参考来源边，保留目标到配置节点的主链。
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const configNodeId = previousConnections.find((connection) => {
                if (connection.fromNodeId !== targetNodeId) return false;
                return previousNodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config;
            })?.toNodeId;
            const removedConnectionIds = new Set(previousConnections.filter((connection) => connection.fromNodeId === referenceNodeId && (connection.toNodeId === targetNodeId || connection.toNodeId === configNodeId)).map((connection) => connection.id));
            if (!removedConnectionIds.size) return;
            const nextConnections = previousConnections.filter((connection) => !removedConnectionIds.has(connection.id));
            const promptSyncedNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, previousNodes, nextConnections);
            const nextNodes = promptSyncedNodes.map((node) => {
                if (node.id !== targetNodeId && node.id !== configNodeId) return node;
                const metadata = node.metadata;
                if (!metadata) return node;
                const clearShotAsset = node.id === targetNodeId && metadata.workflowKind === "shot" && metadata.referenceAssetNodeIds?.includes(referenceNodeId);
                const clearStart = metadata.videoStartFrameNodeId === referenceNodeId;
                const clearEnd = metadata.videoEndFrameNodeId === referenceNodeId;
                const clearMiddle = metadata.videoMiddleFrameNodeId === referenceNodeId;
                if (!clearShotAsset && !clearStart && !clearEnd && !clearMiddle) return node;
                return {
                    ...node,
                    metadata: {
                        ...metadata,
                        ...(clearShotAsset ? { referenceAssetNodeIds: metadata.referenceAssetNodeIds?.filter((id) => id !== referenceNodeId) } : null),
                        ...(clearStart ? { videoStartFrameNodeId: undefined } : null),
                        ...(clearEnd ? { videoEndFrameNodeId: undefined } : null),
                        ...(clearMiddle ? { videoMiddleFrameNodeId: undefined } : null),
                    },
                };
            });
            if (nextNodes !== previousNodes) {
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
            }
            connectionsRef.current = nextConnections;
            setConnections(nextConnections);
            setSelectedConnectionId((current) => (current && removedConnectionIds.has(current) ? null : current));
        },
        [connectionsRef, nodesRef, setConnections, setNodes, setSelectedConnectionId],
    );

    const handleReorderNodeReferences = useCallback(
        (targetNodeId: string, orderedNodeIds: string[]) => {
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const nextConnections = reorderCanvasResourceConnections(targetNodeId, orderedNodeIds, previousNodes, previousConnections);
            if (nextConnections === previousConnections) return;
            const nextNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, previousNodes, nextConnections);
            if (nextNodes !== previousNodes) {
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
            }
            connectionsRef.current = nextConnections;
            setConnections(nextConnections);
        },
        [connectionsRef, nodesRef, setConnections, setNodes],
    );

    const addTextReference = useCallback((nodeId: string, reference: CanvasResourceReference) => {
        if (reference.active || reference.assetId || reference.kind === "skill") return reference;
        if (!reference.nodeId || reference.nodeId === nodeId) return undefined;
        try {
            const linked = connectCanvasResourceMention(nodesRef.current, connectionsRef.current, nodeId, reference.nodeId, nanoid());
            nodesRef.current = linked.nodes;
            connectionsRef.current = linked.connections;
            setNodes(linked.nodes);
            setConnections(linked.connections);
            return linked.reference;
        } catch (cause) {
            message.warning(cause instanceof Error ? cause.message : "节点引用失败");
            return undefined;
        }
    }, [connectionsRef, message, nodesRef, setConnections, setNodes]);

    const handlePickConnectNodeReference = useCallback((targetNodeId: string, sourceNodeId: string) => {
        if (!targetNodeId || !sourceNodeId || targetNodeId === sourceNodeId) return undefined;
        try {
            const linked = connectAndAppendCanvasResourceMention(nodesRef.current, connectionsRef.current, targetNodeId, sourceNodeId, nanoid());
            nodesRef.current = linked.nodes;
            connectionsRef.current = linked.connections;
            setNodes(linked.nodes);
            setConnections(linked.connections);
            return linked.reference;
        } catch (cause) {
            message.warning(cause instanceof Error ? cause.message : "点选连线引用失败");
            return undefined;
        }
    }, [connectionsRef, message, nodesRef, setConnections, setNodes]);

    registerCanvasPickConnectHandler(projectId, handlePickConnectNodeReference);
    useEffect(() => registerCanvasPickConnectHandler(projectId, handlePickConnectNodeReference), [handlePickConnectNodeReference, projectId]);

    return { handleReplaceNodeReference, handleReplaceNodeReferenceFiles, handleRemoveNodeReference, handleReorderNodeReferences, addTextReference, handlePickConnectNodeReference };
}
