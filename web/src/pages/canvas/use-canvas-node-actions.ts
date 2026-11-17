import { useCallback, useMemo } from "react";

import type { CanvasNodeActionContextValue } from "@/components/canvas/canvas-node-action-context";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import type { CanvasNodeData } from "@/types/canvas";

type UseCanvasNodeActionsParams = {
    pageUi: CanvasPageUiStoreHook;
    replaceCanvasNodeMedia: CanvasNodeActionContextValue["upload"];
    downloadNodeImage: CanvasNodeActionContextValue["download"];
    duplicateNode: (nodeId: string) => void;
    deleteNodes: (nodeIds: Set<string>) => void;
    updateNodeMetadataFromContent: CanvasNodeActionContextValue["updateMetadata"];
    updateNodeFromContent: CanvasNodeActionContextValue["updateNode"];
    updateMediaNodeFromContent: CanvasNodeActionContextValue["updateMediaNode"];
    openArtCritique: CanvasNodeActionContextValue["openArtCritique"];
    addPanoramaCaptureNode: CanvasNodeActionContextValue["addPanoramaCaptureNode"];
    startUpscaleBatch: CanvasNodeActionContextValue["startUpscaleBatch"];
    recoverAIUpscale: CanvasNodeActionContextValue["recoverUpscaleResult"];
    stepImageHistory?: CanvasNodeActionContextValue["stepImageHistory"];
    restorePreviousHistoryImage?: CanvasNodeActionContextValue["restorePreviousHistoryImage"];
};

export function useCanvasNodeActions({
    pageUi,
    replaceCanvasNodeMedia,
    downloadNodeImage,
    duplicateNode,
    deleteNodes,
    updateNodeMetadataFromContent,
    updateNodeFromContent,
    updateMediaNodeFromContent,
    openArtCritique,
    addPanoramaCaptureNode,
    startUpscaleBatch,
    recoverAIUpscale,
    stepImageHistory,
    restorePreviousHistoryImage,
}: UseCanvasNodeActionsParams): CanvasNodeActionContextValue {
    const duplicateNodeFromContent = useCallback((node: CanvasNodeData) => duplicateNode(node.id), [duplicateNode]);
    const deleteNodeFromContent = useCallback((node: CanvasNodeData) => deleteNodes(new Set([node.id])), [deleteNodes]);
    return useMemo<CanvasNodeActionContextValue>(
        () => ({
            pageUi,
            upload: replaceCanvasNodeMedia,
            download: downloadNodeImage,
            duplicate: duplicateNodeFromContent,
            deleteNode: deleteNodeFromContent,
            updateMetadata: updateNodeMetadataFromContent,
            updateNode: updateNodeFromContent,
            updateMediaNode: updateMediaNodeFromContent,
            openArtCritique,
            addPanoramaCaptureNode,
            startUpscaleBatch,
            recoverUpscaleResult: recoverAIUpscale,
            stepImageHistory,
            restorePreviousHistoryImage,
        }),
        [
            addPanoramaCaptureNode,
            deleteNodeFromContent,
            downloadNodeImage,
            duplicateNodeFromContent,
            openArtCritique,
            pageUi,
            recoverAIUpscale,
            replaceCanvasNodeMedia,
            restorePreviousHistoryImage,
            startUpscaleBatch,
            stepImageHistory,
            updateMediaNodeFromContent,
            updateNodeFromContent,
            updateNodeMetadataFromContent,
        ],
    );
}
