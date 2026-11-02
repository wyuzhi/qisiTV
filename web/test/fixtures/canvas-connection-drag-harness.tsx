import React, { type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import { CanvasProjectWorldLayers } from "../../src/pages/canvas/canvas-project-world-layers";
import { applyCanvasNodeDragPreview } from "../../src/lib/canvas/canvas-live-viewport";
import { CanvasNodeType, type CanvasDisplayConnection, type CanvasNodeData } from "../../src/types/canvas";

export function mountConnectionDragHarness(element: HTMLElement) {
    const container = document.createElement("div");
    container.dataset.canvasViewport = "true";
    element.append(container);
    let unrelatedReads = 0;
    const node = (id: string, x: number, y = 0): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width: 100, height: 80 });
    const from = node("from", 0);
    const to = node("to", 300);
    const other = node("other", 600);
    const displays: CanvasDisplayConnection[] = [
        { connection: { id: "main", fromNodeId: "from", toNodeId: "to" }, from, to },
        { connection: { id: "next", fromNodeId: "to", toNodeId: "other" }, from: to, to: other },
    ];
    const frame = node("frame", 0, 200);
    displays.push({ connection: { id: "collapsed", fromNodeId: "hidden-child", toNodeId: "to" }, from: frame, to });
    const script = { ...node("script", 0, 400), height: 400, metadata: { storyboard: { rows: [{ id: "r0" }, { id: "r1" }] } } } as CanvasNodeData;
    displays.push({ connection: { id: "row", fromNodeId: "script", toNodeId: "to", fromHandleId: "row:r1" }, from: script, to });
    const edgeCount = Math.min(5000, Math.max(0, Number(new URL(location.href).searchParams.get("edges") || 1000)));
    for (let i = 0; i < edgeCount; i++) {
        const source = node(`unrelated-${i}`, 1000 + i);
        const id = source.id;
        Object.defineProperty(source, "id", { get() { unrelatedReads++; return id; } });
        displays.push({ connection: { id: `edge-${i}`, fromNodeId: id, toNodeId: other.id }, from: source, to: other });
    }
    const props = {
        containerRef: { current: container }, projectId: "drag-test", viewportScale: 1,
        connectionLayerBounds: { left: -100, top: -100, width: 2400, height: 600 },
        displayConnections: displays, selectedConnectionId: null, relatedConnectionIds: new Set(),
        scriptScrollTopById: { script: 20 }, visibleNodes: [], nodeById: new Map(), nodeStackOrder: {},
        selectedNodeIds: new Set(), batchSourceNodeIds: [], batchChildCountById: new Map(),
        collapsingBatchIds: new Set(), openingBatchIds: new Set(), batchMotionById: new Map(),
        frameChildrenById: new Map(), linkedFolderPreviewNodesById: new Map(),
        resourceReferenceByNodeId: new Map(), mentionReferencesByNodeId: new Map(),
        onConnectionSelect() {}, onConnectionContextMenu() {}, renderCanvasNodeContent() { return null; },
    } as unknown as ComponentProps<typeof CanvasProjectWorldLayers>;
    const root = createRoot(container);
    root.render(<CanvasProjectWorldLayers {...props} />);
    Object.assign(window, { connectionDrag: {
        move(nodeIds: string[] | null, x = 0, y = 0, compact?: { nodeId: string; x: number; y: number; scale: number }) {
            unrelatedReads = 0;
            applyCanvasNodeDragPreview(container, nodeIds ? { nodeIds: new Set(nodeIds), x, y, compact } : null);
            return unrelatedReads;
        },
        refresh() {
            root.render(<CanvasProjectWorldLayers {...props} scriptScrollTopById={{ script: 20 }} />);
        },
        switchProject() {
            root.render(<CanvasProjectWorldLayers {...props} projectId="other-project" />);
        },
    } });
}
