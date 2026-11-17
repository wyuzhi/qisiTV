import { beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canvasNodeDragEndChrome, isCanvasPointerMoving } from "@/pages/canvas/canvas-pointer-chrome";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasStageOverlayProps, makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const panelOverlays: Array<Record<string, unknown>> = [];
const emotionOverlays: Array<Record<string, unknown>> = [];
const selectionToolbars: Array<Record<string, unknown>> = [];
const toolbars: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-workspace-overlays", () => ({
    CanvasNodePanelOverlay: (props: Record<string, unknown> & { children?: ReactNode }) => {
        panelOverlays.push(props);
        return createElement("div", { "data-panel-node": (props.node as CanvasNodeData | undefined)?.id }, props.children);
    },
    CanvasConnectionCreateMenu: () => null,
    CanvasSelectionToolbar: (props: Record<string, unknown>) => {
        selectionToolbars.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-emotion-workspace", () => ({
    CanvasEmotionWorkspace: (props: Record<string, unknown>) => {
        emotionOverlays.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({
    CanvasNodeToolbar: (props: Record<string, unknown>) => {
        toolbars.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({
    CanvasOverlayLayerContainer: () => null,
}));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));
mock.module("@/components/canvas/canvas-mini-map", () => ({ Minimap: () => null }));
mock.module("@/components/canvas/canvas-node-angle-dialog", () => ({ CanvasNodeAnglePanel: () => null }));

const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");

beforeEach(() => {
    panelOverlays.length = 0;
    emotionOverlays.length = 0;
    selectionToolbars.length = 0;
    toolbars.length = 0;
});

describe("canvas node drag overlays", () => {
    test("treats either pointer dragging or active drag preview as moving", () => {
        expect(isCanvasPointerMoving(false, null)).toBe(false);
        expect(isCanvasPointerMoving(false, { nodeIds: new Set() })).toBe(false);
        expect(isCanvasPointerMoving(true, null)).toBe(true);
        expect(isCanvasPointerMoving(false, { nodeIds: new Set(["n1"]) })).toBe(true);
    });

    test("hides floating editors and selection controls for the whole drag preview", () => {
        const dialogNode = makeCanvasNode("text-1", CanvasNodeType.Text);
        const angleNode = makeCanvasNode("angle-1", CanvasNodeType.Image, { content: "data:image/png;base64,a" });
        const emotionNode = makeCanvasNode("emotion-1", CanvasNodeType.Image, { content: "data:image/png;base64,b" });
        const toolbarNode = makeCanvasNode("img-1", CanvasNodeType.Image, { content: "data:image/png;base64,c", status: "success" });
        const selectedNodeBounds = { count: 2, x: 0, y: 0, width: 400, height: 300 };

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    dialogNode,
                    angleNode,
                    emotionNode,
                    selectedNodeBounds,
                    isCanvasNodeMoving: false,
                }),
            ),
        );
        expect(panelOverlays.map((p) => (p.node as CanvasNodeData).id)).toEqual(["angle-1", "text-1"]);
        expect(emotionOverlays).toHaveLength(1);
        expect(selectionToolbars).toHaveLength(1);

        toolbars.length = 0;
        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    toolbarNode,
                    isCanvasNodeMoving: false,
                }),
            ),
        );
        expect((toolbars[0]?.node as CanvasNodeData | null)?.id).toBe("img-1");

        panelOverlays.length = 0;
        emotionOverlays.length = 0;
        selectionToolbars.length = 0;
        toolbars.length = 0;

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    dialogNode,
                    angleNode,
                    emotionNode,
                    toolbarNode,
                    selectedNodeBounds,
                    isCanvasNodeMoving: true,
                    isNodeDragging: false,
                    dragPreview: { nodeIds: new Set(["angle-1"]), x: 24, y: -10 },
                }),
            ),
        );
        expect(panelOverlays.map((p) => (p.node as CanvasNodeData).id)).toEqual(["angle-1"]);
        expect(panelOverlays[0]?.dragOffset).toEqual({ x: 24, y: -10 });
        expect(emotionOverlays).toHaveLength(0);
        expect(selectionToolbars).toHaveLength(0);
        expect(toolbars[0]?.node).toBeNull();
    });

    test("suppresses dialog and selection overlays while box-selecting or drawing nodes", () => {
        const drawingNode = makeCanvasNode("draw-1", CanvasNodeType.Drawing);
        const textNode = makeCanvasNode("text-2", CanvasNodeType.Text);
        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    dialogNode: drawingNode,
                    selectedNodeBounds: { count: 1, x: 0, y: 0, width: 100, height: 100 },
                    selectionBox: null,
                }),
            ),
        );
        expect(panelOverlays).toHaveLength(0);

        panelOverlays.length = 0;
        selectionToolbars.length = 0;

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    dialogNode: textNode,
                    selectedNodeBounds: { count: 1, x: 0, y: 0, width: 100, height: 100 },
                    selectionBox: { x: 0, y: 0, width: 50, height: 50 },
                }),
            ),
        );
        expect(panelOverlays).toHaveLength(0);
        expect(selectionToolbars).toHaveLength(0);
    });

    test("binds dialog or media toolbar after drag ends based on node editability", () => {
        const generatorNode = makeCanvasNode("gen-1", CanvasNodeType.Text);
        const resultNode = makeCanvasNode("res-1", CanvasNodeType.Image, { content: "url", taskId: "task-1", status: "success" });
        expect(canvasNodeDragEndChrome(generatorNode)).toEqual({ dialogNodeId: "gen-1" });
        expect(canvasNodeDragEndChrome(resultNode)).toEqual({ dialogNodeId: null, toolbarNodeId: "res-1" });
    });
});
