import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canRecoverManagedToolNode } from "@/lib/canvas/canvas-ai-upscale-task";
import { canvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";
import { planUpscaleProcessingNode } from "@/lib/canvas/canvas-upscale-processor";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasStageOverlayProps, makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const toolbarCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-workspace-overlays", () => ({
    CanvasNodePanelOverlay: () => null,
    CanvasConnectionCreateMenu: () => null,
    CanvasSelectionToolbar: () => null,
}));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({
    CanvasNodeToolbar: (props: Record<string, unknown>) => {
        toolbarCalls.push(props);
        return null;
    },
    CanvasNodeInfoModal: () => null,
}));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({ CanvasOverlayLayerContainer: () => null }));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));

const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");

beforeEach(() => {
    toolbarCalls.length = 0;
});

describe("canvas super resolve fallback and toolbar wiring", () => {
    test("image and video AI upscale create processing nodes and wire toolbar super resolve", () => {
        const imageNode = makeCanvasNode("img-1", CanvasNodeType.Image, { content: "data:image/png;base64,a", status: "success" });
        const videoNode = makeCanvasNode("vid-1", CanvasNodeType.Video, { content: "https://example.com/v.mp4", status: "success" });

        const imagePlan = planUpscaleProcessingNode([imageNode], [], imageNode, new Set());
        const videoPlan = planUpscaleProcessingNode([videoNode], [], videoNode, new Set());
        expect(imagePlan.processor.type).toBe(CanvasNodeType.Upscale);
        expect(imagePlan.connections.some((conn) => conn.fromNodeId === "img-1" && conn.toNodeId === imagePlan.processor.id)).toBe(true);
        expect(videoPlan.processor.type).toBe(CanvasNodeType.Upscale);
        expect(videoPlan.connections.some((conn) => conn.fromNodeId === "vid-1" && conn.toNodeId === videoPlan.processor.id)).toBe(true);

        const created: string[] = [];
        const createUpscaleProcessingNode = (node: CanvasNodeData) => {
            created.push(node.id);
        };

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    toolbarNode: imageNode,
                    createUpscaleProcessingNode,
                }),
            ),
        );
        expect(toolbarCalls).toHaveLength(1);
        expect(toolbarCalls[0]?.onSuperResolve).toBe(createUpscaleProcessingNode);
        (toolbarCalls[0]?.onSuperResolve as (node: CanvasNodeData) => void)(imageNode);
        expect(created).toEqual(["img-1"]);
    });

    test("upscale retry detects managed upscale task before generic retry fallback", () => {
        const recoverableUpscale = makeCanvasNode("up-1", CanvasNodeType.Image, {
            status: "error",
            taskId: "task-upscale-1",
            workflowOperation: { id: "image.ai-upscale", version: 1, config: { scale: 2 }, inputs: [] },
        });
        expect(canRecoverManagedToolNode(recoverableUpscale)).toBe(true);
        expect(canvasNodeFailureView(recoverableUpscale).regenerateBlocked).toBe(false);
    });
});
