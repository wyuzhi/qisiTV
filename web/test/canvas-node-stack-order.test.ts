import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { bringCanvasNodeToFront, sortCanvasNodesByStackOrder } from "@/lib/canvas/canvas-node-stack-order";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const renderedNodeIds: string[] = [];

mock.module("@/components/canvas/canvas-node", () => ({
    CanvasNode: (props: { data: CanvasNodeData }) => {
        renderedNodeIds.push(props.data.id);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-frame-node", () => ({
    CanvasFrameNode: (props: { data: CanvasNodeData }) => {
        renderedNodeIds.push(props.data.id);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-connections", () => ({
    ConnectionPath: () => null,
    canvasConnectionPath: () => ({ pathD: "", startX: 0, startY: 0, endX: 0, endY: 0 }),
}));

const { CanvasProjectWorldLayers } = await import("@/pages/canvas/canvas-project-world-layers");

beforeEach(() => {
    renderedNodeIds.length = 0;
});

function buildWorldLayerProps(nodes: CanvasNodeData[], nodeStackOrder: string[], selectedNodeIds: Set<string>) {
    const noop = () => undefined;
    return {
        containerRef: { current: null },
        projectId: "canvas-test",
        viewportScale: 1,
        displayConnections: [],
        selectedConnectionId: null,
        relatedConnectionIds: new Set<string>(),
        scriptScrollTopById: {},
        connectingParams: null,
        mouseWorld: { x: 0, y: 0 },
        connectionTargetNodeId: null,
        connectionApproach: null,
        nodeById: new Map(nodes.map((node) => [node.id, node])),
        visibleNodes: nodes,
        nodeStackOrder,
        frameChildrenById: new Map(),
        linkedFolderPreviewNodesById: new Map(),
        dragPreview: null,
        selectedNodeIds,
        activeMediaNodeId: null,
        onActiveMediaNodeChange: noop,
        frameDropTargetId: null,
        relatedNodeIds: new Set<string>(),
        activeNodeId: null,
        selectionBox: null,
        batchChildCountById: new Map(),
        collapsingBatchIds: new Set<string>(),
        openingBatchIds: new Set<string>(),
        batchMotionById: new Map(),
        showImageInfo: false,
        reduceMediaEffects: false,
        resourceReferenceByNodeId: new Map(),
        mentionReferencesByNodeId: new Map(),
        selectedNodeBounds: null,
        batchSourceNodeIds: [],
        batchConnectionPreview: null,
        selectionBoundsElementRef: { current: null },
        renderCanvasNodeContent: () => null,
        onConnectionSelect: noop,
        onConnectionContextMenu: noop,
        onNodeMouseDown: noop,
        onNodeHoverStart: noop,
        onNodeHoverEnd: noop,
        onConnectStart: noop,
        onNodeResize: noop,
        onToggleFrame: noop,
        onFolderStyleChange: noop,
        onFolderThemeChange: noop,
        onNodeTitleChange: noop,
        onNodeContextMenu: noop,
        onNodeContentChange: noop,
        onToggleBatch: noop,
        onSetBatchPrimary: noop,
        onRetry: noop,
        onReloadResource: noop,
        onOpenTaskDetails: noop,
        onOpenVersions: noop,
        onViewImage: noop,
        onReplaceMedia: noop,
        onOpenTextEditor: noop,
        onOpenDrawing: noop,
        onStartBatchConnection: noop,
    };
}

describe("canvas node stack order", () => {
    test("moves the interacted node to the paint-order end", () => {
        expect(bringCanvasNodeToFront(["a", "b"], "a")).toEqual(["b", "a"]);
        expect(bringCanvasNodeToFront(["a", "b"], "c")).toEqual(["a", "b", "c"]);
        const alreadyFront = ["a", "b"];
        expect(bringCanvasNodeToFront(alreadyFront, "b")).toBe(alreadyFront);
    });

    test("keeps untouched nodes stable while the latest node remains on top after deselection", () => {
        const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
        expect(sortCanvasNodesByStackOrder(nodes, ["b", "a"])).toEqual([{ id: "c" }, { id: "b" }, { id: "a" }]);
    });

    test("world layers preserve DOM paint order across selection changes", () => {
        const nodeA = makeCanvasNode("a", CanvasNodeType.Text);
        const nodeB = makeCanvasNode("b", CanvasNodeType.Image);
        const nodeC = makeCanvasNode("c", CanvasNodeType.Video);
        const nodes = [nodeA, nodeB, nodeC];

        let stackOrder = bringCanvasNodeToFront([], nodeB.id);
        stackOrder = bringCanvasNodeToFront(stackOrder, nodeA.id);

        renderToStaticMarkup(createElement(CanvasProjectWorldLayers, buildWorldLayerProps(nodes, stackOrder, new Set(["c"]))));
        expect(renderedNodeIds).toEqual(["c", "b", "a"]);

        renderedNodeIds.length = 0;
        renderToStaticMarkup(createElement(CanvasProjectWorldLayers, buildWorldLayerProps(nodes, stackOrder, new Set())));
        expect(renderedNodeIds).toEqual(["c", "b", "a"]);
    });
});
