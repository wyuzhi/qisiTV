import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import type { CanvasNodeData } from "@/types/canvas";

import { canvasNodeDragEndChrome, canvasNodeInteractionStartChrome } from "./canvas-pointer-chrome";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";

type UseCanvasPointerSelectionChromeOptions = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    nodesRef: { current: CanvasNodeData[] };
    segmentRunningMode?: string | null;
};

export function useCanvasPointerSelectionChrome({
    pageUi,
    projectId,
    nodesRef,
    segmentRunningMode,
}: UseCanvasPointerSelectionChromeOptions) {
    const handleCanvasSelectionStart = useCallback(() => {
        pageUi.getState().setContextMenu(null);
    }, [pageUi, projectId]);

    const handleNodeInteractionStart = useCallback((selectionModifier: boolean) => {
        pageUi.getState().setContextMenu(null);
        pageUi.getState().setHoveredNodeId(null);
        // Keep the source node's extraction state visible while FFmpeg is
        // producing the independent video/audio outputs.
        const chrome = canvasNodeInteractionStartChrome({
            segmentRunningAudio: segmentRunningMode === "audio",
            selectionModifier,
        });
        if (chrome.ignore) return;
        pageUi.getState().setToolbarNodeId(null);
        if (chrome.closeDialog) pageUi.getState().setDialogNodeId(null);
    }, [pageUi, projectId, segmentRunningMode]);

    const handleNodeDragEnd = useCallback(
        (nodeId: string) => {
            const chrome = canvasNodeDragEndChrome(nodesRef.current.find((item) => item.id === nodeId));
            const { setDialogNodeId, setToolbarNodeId } = pageUi.getState();
            setDialogNodeId(chrome.dialogNodeId);
            if (chrome.toolbarNodeId) setToolbarNodeId(chrome.toolbarNodeId);
        },
        [pageUi, nodesRef, projectId],
    );

    const handleCanvasDeselect = useCallback(() => {
        pageUi.getState().setContextMenu(null);
        pageUi.getState().setHoveredNodeId(null);
        pageUi.getState().setToolbarNodeId(null);
        pageUi.getState().setDialogNodeId(null);
    }, [pageUi, projectId]);

    return {
        handleCanvasSelectionStart,
        handleNodeInteractionStart,
        handleNodeDragEnd,
        handleCanvasDeselect,
    };
}

type UseCanvasNodeToolbarHoverOptions = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    nodeDraggingRef: { current: boolean };
    nodeImageSettingsOpen: boolean;
};

export function useCanvasNodeToolbarHover({
    pageUi,
    projectId,
    nodeDraggingRef,
    nodeImageSettingsOpen,
}: UseCanvasNodeToolbarHoverOptions) {
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            pageUi.getState().setToolbarNodeId(nodeId);
        },
        [pageUi, nodeDraggingRef, nodeImageSettingsOpen, projectId],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            pageUi.getState().setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, [pageUi, projectId]);

    useEffect(() => () => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
    }, []);

    const handleCanvasNodeHoverStart = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current) return;
            pageUi.getState().setHoveredNodeId(nodeId);
            keepNodeToolbar(nodeId);
        },
        [pageUi, keepNodeToolbar, nodeDraggingRef],
    );

    const handleCanvasNodeHoverEnd = useCallback(
        (nodeId: string) => {
            pageUi.getState().setHoveredNodeId((current) => (current === nodeId ? null : current));
            hideNodeToolbar();
        },
        [pageUi, hideNodeToolbar, projectId],
    );

    return {
        keepNodeToolbar,
        hideNodeToolbar,
        handleCanvasNodeHoverStart,
        handleCanvasNodeHoverEnd,
    };
}
