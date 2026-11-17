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
    addPanoramaCaptureNode: CanvasNodeActionContextValue["addPanoramaCaptureNode"];
    startUpscaleBatch: CanvasNodeActionContextValue["startUpscaleBatch"];
    recoverAIUpscale: CanvasNodeActionContextValue["recoverUpscaleResult"];
    stepImageHistory?: CanvasNodeActionContextValue["stepImageHistory"];
    restorePreviousHistoryImage?: CanvasNodeActionContextValue["restorePreviousHistoryImage"];
    focusNode?: CanvasNodeActionContextValue["focusNode"];
    editGenerationInput?: CanvasNodeActionContextValue["editGenerationInput"];
    canEditGenerationInput?: CanvasNodeActionContextValue["canEditGenerationInput"];
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
    addPanoramaCaptureNode,
    startUpscaleBatch,
    recoverAIUpscale,
    stepImageHistory,
    restorePreviousHistoryImage,
    focusNode,
    editGenerationInput,
    canEditGenerationInput,
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
            addPanoramaCaptureNode,
            startUpscaleBatch,
            recoverUpscaleResult: recoverAIUpscale,
            stepImageHistory,
            restorePreviousHistoryImage,
            focusNode,
            editGenerationInput,
            canEditGenerationInput,
        }),
        [
            addPanoramaCaptureNode,
            canEditGenerationInput,
            deleteNodeFromContent,
            downloadNodeImage,
            duplicateNodeFromContent,
            editGenerationInput,
            focusNode,
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
