import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { updateCanvasNode, updateCanvasNodes } from "@/lib/canvas/canvas-node-timestamps";
import { repairOverlappingImageBatches } from "@/lib/canvas/canvas-generation-layout";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import { createCanvasMediaOperation } from "./canvas-media-operation";

export const MEDIA_NODE_CONTENT_FLUSH_MS = 120;

export function queueMediaNodeContentUpdate(
    pending: Map<string, (node: CanvasNodeData) => CanvasNodeData>,
    nodeId: string,
    update: (node: CanvasNodeData) => CanvasNodeData,
) {
    const previous = pending.get(nodeId);
    pending.set(nodeId, previous ? (node) => update(previous(node)) : update);
}

type UseCanvasNodeContentOptions = {
    canvasId: string;
    nodesRef: { current: CanvasNodeData[] };
    setNodesState: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

export function useCanvasNodeContent({ canvasId, nodesRef, setNodesState }: UseCanvasNodeContentOptions) {
    const pendingMediaUpdatesRef = useRef(new Map<string, (node: CanvasNodeData) => CanvasNodeData>());
    const mediaUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const canvasIdRef = useRef(canvasId);
    canvasIdRef.current = canvasId;
    const { lifetime, mountedRef, userScope } = useCanvasOwnerLifetime(canvasId);
    const pendingOwnerRef = useRef<ReturnType<typeof createCanvasMediaOperation> | null>(null);
    const clearPending = useCallback(() => {
        if (mediaUpdateTimerRef.current) clearTimeout(mediaUpdateTimerRef.current);
        mediaUpdateTimerRef.current = null;
        pendingMediaUpdatesRef.current.clear();
        pendingOwnerRef.current = null;
    }, []);
    useLayoutEffect(clearPending, [canvasId, userScope, clearPending]);

    const updateNodeFromContent = useCallback((nodeId: string, update: (node: CanvasNodeData) => CanvasNodeData) => {
        setNodesState((current) => {
            const next = updateCanvasNode(current, nodeId, update);
            nodesRef.current = next;
            return next;
        });
    }, [nodesRef, setNodesState]);

    const updateMediaNodeFromContent = useCallback((nodeId: string, update: (node: CanvasNodeData) => CanvasNodeData) => {
        if (pendingOwnerRef.current && !pendingOwnerRef.current.isCurrent()) clearPending();
        if (!pendingOwnerRef.current) pendingOwnerRef.current = createCanvasMediaOperation(lifetime, canvasId, () => canvasIdRef.current, () => mountedRef.current);
        queueMediaNodeContentUpdate(pendingMediaUpdatesRef.current, nodeId, update);
        if (mediaUpdateTimerRef.current) return;
        const owner = pendingOwnerRef.current;
        mediaUpdateTimerRef.current = setTimeout(() => {
            const updates = pendingMediaUpdatesRef.current;
            pendingMediaUpdatesRef.current = new Map();
            mediaUpdateTimerRef.current = null;
            pendingOwnerRef.current = null;
            if (!updates.size || !owner.isCurrent()) return;
            setNodesState((current) => {
                if (!owner.isCurrent()) return current;
                const next = repairOverlappingImageBatches(updateCanvasNodes(current, updates));
                nodesRef.current = next;
                return next;
            });
        }, MEDIA_NODE_CONTENT_FLUSH_MS);
    }, [nodesRef, setNodesState, canvasId, clearPending, lifetime, mountedRef]);

    useEffect(() => clearPending, [clearPending]);

    const updateNodeMetadataFromContent = useCallback(
        (nodeId: string, patch: CanvasNodeMetadata) => {
            updateNodeFromContent(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, ...patch } }));
        },
        [updateNodeFromContent],
    );

    return {
        updateNodeFromContent,
        updateMediaNodeFromContent,
        updateNodeMetadataFromContent,
    };
}
