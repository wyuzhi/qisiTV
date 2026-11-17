import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CANVAS_MAIN_DOCK_CLEARANCE, getNodePanelPosition } from "@/components/canvas/canvas-workspace-overlays";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasStageOverlayProps, makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const mediaNode = {
    id: "image-node",
    type: CanvasNodeType.Image,
    position: { x: 240, y: 580 },
    width: 480,
    height: 160,
} as CanvasNodeData;

const panelOverlayCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-workspace-overlays", () => ({
    CANVAS_MAIN_DOCK_CLEARANCE,
    getNodePanelPosition,
    CanvasNodePanelOverlay: (props: Record<string, unknown>) => {
        panelOverlayCalls.push(props);
        return null;
    },
    CanvasConnectionCreateMenu: () => null,
    CanvasSelectionToolbar: () => null,
}));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({ CanvasNodeToolbar: () => null }));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({ CanvasOverlayLayerContainer: () => null }));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));

const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");

beforeEach(() => {
    panelOverlayCalls.length = 0;
});

describe("canvas media prompt panel placement", () => {
    test("keeps the panel below the node even when it extends past the viewport", () => {
        const position = getNodePanelPosition(
            mediaNode,
            { x: 0, y: 0, k: 1 },
            { width: 1200, height: 700 },
            660,
            190,
            undefined,
            true,
        );

        expect(position.placement).toBe("below");
        expect(position.top).toBe(756);
    });

    test("wires the fixed-below policy to all media prompt panels", () => {
        for (const [type, expected] of [
            [CanvasNodeType.Image, true],
            [CanvasNodeType.Video, true],
            [CanvasNodeType.Audio, true],
            [CanvasNodeType.Text, false],
        ] as const) {
            panelOverlayCalls.length = 0;
            const node = makeCanvasNode(`node-${type}`, type);
            renderToStaticMarkup(
                createElement(CanvasProjectStageOverlays, createCanvasStageOverlayProps({ dialogNode: node })),
            );
            expect(panelOverlayCalls).toHaveLength(1);
            expect(panelOverlayCalls[0]?.keepBelowNode).toBe(expected);
        }
    });

    test("video trim panel stays above the main dock without flipping over the node", () => {
        const videoNode = {
            id: "video-1790252932340-pga5v",
            type: CanvasNodeType.Video,
            position: { x: 200, y: 420 },
            width: 720,
            height: 360,
        } as CanvasNodeData;
        const position = getNodePanelPosition(
            videoNode,
            { x: 0, y: 0, k: 1 },
            { width: 1440, height: 900 },
            540,
            104,
            undefined,
            true,
            true,
        );

        expect(position.placement).toBe("below");
        expect(position.top).toBe(900 - 104 - CANVAS_MAIN_DOCK_CLEARANCE);
        expect(position.top + 104).toBeLessThanOrEqual(900 - CANVAS_MAIN_DOCK_CLEARANCE);
    });
});
