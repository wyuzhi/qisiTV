import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type MouseEvent, type SetStateAction } from "react";

import { isNodeHiddenByCollapsedFrame } from "@/lib/canvas/canvas-frame";
import { isHiddenBatchChild } from "@/lib/canvas/canvas-project-domain";
import { applyCanvasLiveViewport } from "@/lib/canvas/canvas-live-viewport";
import { canOpenCanvasNodePromptPanel, isCanvasMediaResultNode } from "@/lib/canvas/canvas-node-semantics";
import { getCanvasNodesBounds, viewportAtScale, viewportForBounds, type CanvasViewportSize } from "@/lib/canvas/canvas-viewport";
import { sameCanvasViewport } from "@/lib/canvas/canvas-leafer-viewport";
import { canvasGestureRenderPadding, CANVAS_VIRTUALIZATION_REFRESH_INTERVAL_MS, shouldCommitCanvasScaleDuringGesture, shouldRefreshCanvasVirtualization, type CanvasVirtualizationViewport } from "@/lib/canvas/canvas-viewport-render-sync";
import { CanvasNodeType, type CanvasNodeData, type Position, type ViewportTransform } from "@/types/canvas";
import { useCanvasViewportTransition } from "./use-canvas-viewport-transition";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";

type UseCanvasViewportControllerOptions = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    containerRef: { current: HTMLDivElement | null };
    size: CanvasViewportSize;
    viewport: ViewportTransform;
    viewportRef: { current: ViewportTransform };
    nodesRef: { current: CanvasNodeData[] };
    selectedNodeIdsRef: { current: Set<string> };
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setVirtualizationViewport: Dispatch<SetStateAction<ViewportTransform | null>>;
    /** True while a renderer culls per frame itself (overview LOD); previews then skip React refreshes. */
    virtualizationPausedRef?: { current: boolean };
    /** Scale threshold below which overview LOD activates; crossing it refreshes immediately. */
    lodEnterScaleRef?: { current: number };
};

export function useCanvasViewportController({
    pageUi,
    projectId,
    containerRef,
    size,
    viewport,
    viewportRef,
    nodesRef,
    selectedNodeIdsRef,
    setViewport,
    setVirtualizationViewport,
    virtualizationPausedRef,
    lodEnterScaleRef,
}: UseCanvasViewportControllerOptions) {
    const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const renderedViewportRef = useRef(viewportRef.current);
    const lastVirtualizationRefreshAtRef = useRef(0);
    // Gesture refreshes so far; each one widens the pre-rendered margin a step.
    const gestureRefreshCountRef = useRef(0);
    // Scale last handed to React. The `viewport` prop lags behind while a
    // commit renders, and comparing against it would commit again per event.
    const committedScaleRef = useRef(viewport.k);
    const committedViewportStateRef = useRef(viewport);
    // The page also sets the camera directly (canvas load restores the saved
    // viewport). That ends any preview, so the culled window is this viewport
    // with the base margin again; measure the next gesture's coverage from it.
    useLayoutEffect(() => {
        committedViewportStateRef.current = viewport;
        committedScaleRef.current = viewport.k;
        if (sameCanvasViewport(renderedViewportRef.current, viewport)) return;
        renderedViewportRef.current = viewport;
        gestureRefreshCountRef.current = 0;
    }, [viewport]);

    const previewViewport = useCallback((next: ViewportTransform) => {
        const scaleChanged = Math.abs(next.k - viewportRef.current.k) > 1e-6;
        viewportRef.current = next;
        const container = containerRef.current;
        if (container && container.dataset.canvasViewportInteracting !== "true") container.dataset.canvasViewportInteracting = "true";
        if (container && scaleChanged && container.dataset.canvasViewportZooming !== "true") container.dataset.canvasViewportZooming = "true";
        applyCanvasLiveViewport(containerRef.current, next);
    }, [containerRef, viewportRef]);

    const commitViewport = useCallback((next: ViewportTransform) => {
        if (commitTimerRef.current) {
            clearTimeout(commitTimerRef.current);
            commitTimerRef.current = null;
        }
        lastVirtualizationRefreshAtRef.current = performance.now();
        gestureRefreshCountRef.current = 0;
        delete containerRef.current?.dataset.canvasViewportInteracting;
        delete containerRef.current?.dataset.canvasViewportZooming;
        const current = committedViewportStateRef.current;
        if (Math.abs(current.x - next.x) < 1e-6 && Math.abs(current.y - next.y) < 1e-6 && Math.abs(current.k - next.k) < 1e-6) {
            viewportRef.current = current;
            renderedViewportRef.current = current;
            committedScaleRef.current = current.k;
            applyCanvasLiveViewport(containerRef.current, current);
            setViewport((prev) => prev);
            return;
        }
        viewportRef.current = next;
        renderedViewportRef.current = next;
        committedScaleRef.current = next.k;
        committedViewportStateRef.current = next;
        setViewport(next);
    }, [containerRef, setViewport, viewportRef]);

    useEffect(() => () => {
        if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
        delete containerRef.current?.dataset.canvasViewportInteracting;
        delete containerRef.current?.dataset.canvasViewportZooming;
    }, [containerRef]);

    const { cancelViewportTransition, transitionViewportTo } = useCanvasViewportTransition(viewportRef, previewViewport, commitViewport);
    const screenToCanvas = useCallback((clientX: number, clientY: number): Position => {
        const rect = containerRef.current?.getBoundingClientRect();
        const viewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);
        return { x: (localX - viewport.x) / viewport.k, y: (localY - viewport.y) / viewport.k };
    }, [containerRef, viewportRef]);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [containerRef, screenToCanvas, size.height, size.width]);

    const focusNodesInView = useCallback((targetNodes: CanvasNodeData[], maxScale = 1) => {
        const bounds = getCanvasNodesBounds(targetNodes);
        if (!bounds) return false;
        transitionViewportTo(viewportForBounds(bounds, size, { padding: 88, maxScale }));
        pageUi.getState().setContextMenu(null);
        return true;
    }, [pageUi, projectId,  size, transitionViewportTo]);

    const fitCanvasContent = useCallback(() => {
        const nodes = nodesRef.current;
        return focusNodesInView(nodes.filter((node) => !isHiddenBatchChild(node, nodes) && !isNodeHiddenByCollapsedFrame(node, nodes)));
    }, [focusNodesInView, nodesRef]);

    const fitCanvasSelection = useCallback(() => {
        const nodes = nodesRef.current;
        return focusNodesInView(nodes.filter((node) => selectedNodeIdsRef.current.has(node.id) && !isHiddenBatchChild(node, nodes) && !isNodeHiddenByCollapsedFrame(node, nodes)), 1.25);
    }, [focusNodesInView, nodesRef, selectedNodeIdsRef]);

    const handleCanvasDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        pageUi.getState().setSelectedNodeIds(new Set());
        pageUi.getState().setSelectedConnectionId(null);
        pageUi.getState().setDialogNodeId(null);
        pageUi.getState().setToolbarNodeId(null);
        pageUi.getState().setContextMenu({ type: "canvas", x: event.clientX, y: event.clientY, position: screenToCanvas(event.clientX, event.clientY), createOpen: true });
    }, [pageUi, projectId, screenToCanvas]);

    const selectFocusedNode = useCallback((nodeId: string) => {
        const selection = new Set([nodeId]);
        selectedNodeIdsRef.current = selection;
        pageUi.getState().setSelectedNodeIds(selection);
        pageUi.getState().setSelectedConnectionId(null);
        pageUi.getState().setContextMenu(null);
    }, [pageUi, projectId, selectedNodeIdsRef]);

    const focusCanvasImageNode = useCallback((nodeId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId && item.type === CanvasNodeType.Image);
        if (!node) return;
        const scale = Math.min(1.25, Math.max(viewportRef.current.k, 0.78));
        transitionViewportTo({ x: size.width / 2 - (node.position.x + node.width / 2) * scale, y: size.height / 2 - (node.position.y + node.height / 2) * scale, k: scale });
        selectFocusedNode(node.id);
        pageUi.getState().setDialogNodeId(null);
        pageUi.getState().setToolbarNodeId(node.id);
    }, [pageUi, projectId, nodesRef, selectFocusedNode, size.height, size.width, transitionViewportTo, viewportRef]);

    const focusCanvasNode = useCallback((nodeId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node) return;
        const scale = Math.min(1.18, Math.max(viewportRef.current.k, 0.72));
        transitionViewportTo({ x: size.width / 2 - (node.position.x + node.width / 2) * scale, y: size.height / 2 - (node.position.y + node.height / 2) * scale, k: scale });
        selectFocusedNode(node.id);
        pageUi.getState().setDialogNodeId(canOpenCanvasNodePromptPanel(node) ? node.id : null);
        pageUi.getState().setToolbarNodeId(isCanvasMediaResultNode(node) ? node.id : null);
    }, [pageUi, projectId, nodesRef, selectFocusedNode, size.height, size.width, transitionViewportTo, viewportRef]);

    const setZoomScale = useCallback((scale: number) => {
        cancelViewportTransition();
        const next = viewportAtScale(viewportRef.current, size, scale);
        previewViewport(next);
        if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
        commitTimerRef.current = setTimeout(() => commitViewport(viewportRef.current), 120);
        pageUi.getState().setContextMenu(null);
    }, [pageUi, projectId, cancelViewportTransition, commitViewport, previewViewport, size, viewportRef]);

    const zoomCanvasIn = useCallback(() => setZoomScale(viewportRef.current.k + 0.1), [setZoomScale, viewportRef]);
    const zoomCanvasOut = useCallback(() => setZoomScale(viewportRef.current.k - 0.1), [setZoomScale, viewportRef]);

    const zoomToActualSize = useCallback(() => {
        transitionViewportTo(viewportAtScale(viewportRef.current, size, 1));
    }, [size, transitionViewportTo, viewportRef]);

    const handleViewportChange = useCallback((next: ViewportTransform) => {
        cancelViewportTransition();
        commitViewport(next);
        pageUi.getState().setContextMenu(null);
    }, [pageUi, projectId, cancelViewportTransition, commitViewport]);

    const handleViewportPreviewChange = useCallback((next: ViewportTransform) => {
        cancelViewportTransition();
        viewportRef.current = next;
        // The overview canvas redraws every frame from the live camera and
        // only leaves LOD after the gesture commits.
        if (virtualizationPausedRef?.current) return;
        const now = performance.now();
        const lodEnterScale = lodEnterScaleRef?.current || 0;
        const enteringLod = lodEnterScale > 0 && next.k < lodEnterScale && renderedViewportRef.current.k >= lodEnterScale;
        const scaleChanged = next.k !== renderedViewportRef.current.k;
        // Re-render the page only when the camera nears the edge of the cards
        // the last refresh pre-rendered; the world transform covers the rest.
        if (!enteringLod && now - lastVirtualizationRefreshAtRef.current < CANVAS_VIRTUALIZATION_REFRESH_INTERVAL_MS) return;
        const previousCommittedScale = committedScaleRef.current;
        const commitScale = next.k > previousCommittedScale && shouldCommitCanvasScaleDuringGesture(next, { ...next, k: previousCommittedScale });
        const renderedPaddingPx = canvasGestureRenderPadding(gestureRefreshCountRef.current);
        if (!enteringLod && !commitScale && !shouldRefreshCanvasVirtualization(renderedViewportRef.current, next, lastVirtualizationRefreshAtRef.current, now, size, renderedPaddingPx)) return;
        renderedViewportRef.current = next;
        lastVirtualizationRefreshAtRef.current = now;
        if (scaleChanged) gestureRefreshCountRef.current = 0;
        else gestureRefreshCountRef.current += 1;
        const culledWindow: CanvasVirtualizationViewport = {
            ...next,
            renderPaddingPx: scaleChanged ? 0 : canvasGestureRenderPadding(gestureRefreshCountRef.current),
        };
        // Keep culling current without relaying every camera tick as a new
        // scale prop to all mounted nodes. The Leafer layer rebases its own
        // raster; DOM cards re-commit scale only for large zoom-in stretches,
        // and the final camera commits on gesture end.
        // setViewport also ends the virtualization preview; restore it so the
        // render model still knows a gesture is in flight (LOD mode and
        // mounted cards then stay put until the gesture-end commit).
        if (commitScale) {
            committedScaleRef.current = next.k;
            committedViewportStateRef.current = next;
            setViewport(next);
        }
        setVirtualizationViewport(culledWindow);
    }, [cancelViewportTransition, lodEnterScaleRef, setViewport, setVirtualizationViewport, size, viewportRef, virtualizationPausedRef]);

    return {
        fitCanvasContent,
        fitCanvasSelection,
        focusCanvasImageNode,
        focusCanvasNode,
        getCanvasCenter,
        handleCanvasDoubleClick,
        handleViewportChange,
        handleViewportPreviewChange,
        previewViewport,
        screenToCanvas,
        setZoomScale,
        zoomCanvasIn,
        zoomCanvasOut,
        zoomToActualSize,
    };
}
