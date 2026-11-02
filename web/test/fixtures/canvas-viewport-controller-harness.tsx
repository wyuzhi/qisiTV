import React, { memo, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Dispatch, SetStateAction } from "react";
import { InfiniteCanvas } from "../../src/components/canvas/infinite-canvas";
import { useCanvasViewportController } from "../../src/pages/canvas/use-canvas-viewport-controller";
import type { CanvasNodeData, ViewportTransform } from "../../src/types/canvas";
import { applyCanvasLiveViewport, applyCanvasNodeSelectionPreview } from "../../src/lib/canvas/canvas-live-viewport";
import { createCanvasPageUiStore } from "../../src/stores/canvas/use-canvas-page-ui-store";
const pageUi = createCanvasPageUiStore();

Object.assign(window, { async scopedScaleProbe() {
    const container = document.createElement("div");
    container.style.cssText = "position:relative;--canvas-committed-scale:0.05";
    container.innerHTML = '<div data-canvas-world-layer><div style="transform:scale(.05);transform-origin:0 0"><div class="node-element" data-node-lod-pinned="true"><div id="scope-title" data-canvas-live-scale style="width:100px;height:20px;transform:scale(var(--canvas-live-inverse-scale));transform-origin:0 0"></div></div><div class="node-element"><div id="scope-unpinned" data-canvas-live-scale style="width:100px;height:20px"></div></div><div id="scope-unrelated" data-node-id="scope-unrelated" style="width:100px;height:20px"></div></div></div>';
    document.body.append(container);
    const title = container.querySelector<HTMLElement>("#scope-title")!;
    const unpinned = container.querySelector<HTMLElement>("#scope-unpinned")!;
    const unrelated = container.querySelector<HTMLElement>("#scope-unrelated")!;
    applyCanvasLiveViewport(container, { x: 0, y: 0, k: .05 });
    const first = { titleWidth: title.getBoundingClientRect().width, inverse: getComputedStyle(title).getPropertyValue("--canvas-live-inverse-scale"), unrelated: getComputedStyle(unrelated).getPropertyValue("--canvas-live-inverse-scale") };
    const late = document.createElement("div"); late.dataset.canvasLiveScale = "";
    late.style.transform = "scale(var(--canvas-live-inverse-scale))"; container.append(late);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const lateInverse = getComputedStyle(late).getPropertyValue("--canvas-live-inverse-scale");
    container.dataset.canvasLodDomHidden = "true";
    applyCanvasLiveViewport(container, { x: 0, y: 0, k: .08 });
    const lodPinnedInverse = getComputedStyle(title).getPropertyValue("--canvas-live-inverse-scale");
    const lodUnpinnedInverse = getComputedStyle(unpinned).getPropertyValue("--canvas-live-inverse-scale");
    delete container.dataset.canvasLodDomHidden;
    applyCanvasLiveViewport(container, { x: 30, y: 20, k: .1 });
    applyCanvasNodeSelectionPreview(container, { includeNodeIds: new Set(["scope-unrelated"]), removeNodeIds: new Set() });
    const next = { titleWidth: title.getBoundingClientRect().width, inverse: getComputedStyle(title).getPropertyValue("--canvas-live-inverse-scale"), selectionInverse: getComputedStyle(unrelated).getPropertyValue("--canvas-live-inverse-scale") };
    container.remove(); return { first, lateInverse, lodPinnedInverse, lodUnpinnedInverse, next };
} });

let nodeRenders = 0;
const Node = memo(function Node({ scale }: { scale: number }) {
    nodeRenders++;
    return <div id="node" data-scale={scale} style={{ position: "absolute", left: 200, top: 100, width: 100, height: 80, background: "red" }} />;
});
const noop = () => {};
function Harness() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setCommittedViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [virtualizationViewport, setVirtualizationViewport] = useState<ViewportTransform | null>(null);
    const setViewport = useCallback<Dispatch<SetStateAction<ViewportTransform>>>((next) => {
        setVirtualizationViewport(null);
        setCommittedViewport(next);
    }, []);
    const viewportRef = useRef(viewport);
    const nodesRef = useRef<CanvasNodeData[]>([]);
    const selectedNodeIdsRef = useRef(new Set<string>());
    const controller = useCanvasViewportController({ pageUi,
        projectId: "canvas",
        containerRef, size: { width: 800, height: 600 }, viewport, viewportRef,
        nodesRef, selectedNodeIdsRef, setViewport, setVirtualizationViewport,
    });
    // Canvas load restores the saved camera through setViewport, not the controller.
    Object.assign(window, { viewportProbe: () => ({ viewport, virtualizationViewport, live: viewportRef.current, nodeRenders }), restoreViewport: (next: ViewportTransform) => { viewportRef.current = next; setViewport(next); } });
    return <InfiniteCanvas containerRef={containerRef} viewport={viewport} onViewportChange={controller.handleViewportChange} onViewportPreviewChange={controller.handleViewportPreviewChange}>
        <Node scale={viewport.k} />
    </InfiniteCanvas>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
