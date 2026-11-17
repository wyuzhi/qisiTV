import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeType } from "@/types/canvas";
import { createCanvasStageOverlayProps, makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const panelOverlayCalls: Array<Record<string, unknown>> = [];
const anglePanelCalls: Array<Record<string, unknown>> = [];
const modalCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-workspace-overlays", () => ({
    CanvasNodePanelOverlay: (props: Record<string, unknown> & { children?: ReactNode }) => {
        panelOverlayCalls.push(props);
        return createElement("div", { "data-testid": "angle-overlay" }, props.children);
    },
    CanvasConnectionCreateMenu: () => null,
    CanvasSelectionToolbar: () => null,
}));
mock.module("@/components/canvas/canvas-node-angle-dialog", () => ({
    CanvasNodeAnglePanel: (props: Record<string, unknown>) => {
        anglePanelCalls.push(props);
        return createElement("div", { "data-testid": "angle-panel" });
    },
}));
mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: (props: Record<string, unknown>) => {
        modalCalls.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({ CanvasNodeToolbar: () => null }));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({ CanvasOverlayLayerContainer: () => null }));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));

const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");

beforeEach(() => {
    panelOverlayCalls.length = 0;
    anglePanelCalls.length = 0;
    modalCalls.length = 0;
});

describe("image angle editor", () => {
    test("anchors the 3D angle editor to the selected node and follows drag", async () => {
        const angleNode = makeCanvasNode("angle-node-1", CanvasNodeType.Image, { content: "data:image/png;base64,img" });
        const closedValues: Array<string | null> = [];
        const generated: Array<{ id: string; params: unknown }> = [];

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    angleNode,
                    angleNodeId: angleNode.id,
                    isNodeDragging: true,
                    dragPreview: { nodeIds: new Set([angleNode.id]), x: 18, y: -12 },
                    setAngleNodeId: (next) => {
                        closedValues.push(typeof next === "function" ? next(angleNode.id) : next);
                    },
                    generateAngleNode: async (node, params) => {
                        generated.push({ id: node.id, params });
                    },
                }),
            ),
        );

        expect(panelOverlayCalls).toHaveLength(1);
        expect(panelOverlayCalls[0]?.node).toBe(angleNode);
        expect(panelOverlayCalls[0]?.panelWidth).toBe(640);
        expect(panelOverlayCalls[0]?.panelHeight).toBe(540);
        expect(panelOverlayCalls[0]?.allowOverflow).toBe(true);
        expect(panelOverlayCalls[0]?.dragOffset).toEqual({ x: 18, y: -12 });
        expect(panelOverlayCalls[0]?.isDragging).toBe(true);
        expect(anglePanelCalls).toHaveLength(1);
        expect(modalCalls).toHaveLength(0);

        (anglePanelCalls[0]?.onClose as () => void)();
        expect(closedValues).toEqual([null]);
        (anglePanelCalls[0]?.onConfirm as (params: unknown) => void)({ yaw: 45 });
        await Promise.resolve();
        expect(generated).toEqual([{ id: "angle-node-1", params: { yaw: 45 } }]);
    });
});
