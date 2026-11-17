import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasStageOverlayProps, makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const panelOverlayCalls: Array<Record<string, unknown>> = [];
const toolbarCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-workspace-overlays", () => ({
    CanvasNodePanelOverlay: (props: Record<string, unknown> & { children?: ReactNode }) => {
        panelOverlayCalls.push(props);
        return createElement("div", null, props.children);
    },
    CanvasConnectionCreateMenu: () => null,
    CanvasSelectionToolbar: () => null,
}));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({
    CanvasNodeToolbar: (props: Record<string, unknown>) => {
        toolbarCalls.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({ CanvasOverlayLayerContainer: () => null }));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));

const { CanvasImageMaskEditor } = await import("@/components/canvas/canvas-node-mask-edit-dialog");
const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");

beforeEach(() => {
    panelOverlayCalls.length = 0;
    toolbarCalls.length = 0;
});

describe("inline canvas mask editing", () => {
    test("renders inline mask editor with prompt input, settings, and semantic theme tokens", () => {
        const html = renderToStaticMarkup(
            createElement(CanvasImageMaskEditor, {
                imageDimensions: { width: 512, height: 512 },
                scale: 1,
                config: defaultConfig,
                onCancel: () => undefined,
                onConfirm: () => undefined,
            }),
        );
        expect(html).toContain('data-image-mask-edit-inline="true"');
        expect(html).toContain("<input");
        expect(html).toContain('aria-label="局部重绘要求"');
        expect(html).not.toContain('<textarea aria-label="局部重绘要求"');
        expect(html).toContain('aria-label="局部重绘设置"');
        expect(html).toContain('aria-label="AI 修改"');
        expect(html).not.toContain("#242424");
    });

    test("hides the ordinary node toolbar and prompt panel while mask editing", () => {
        const toolbarNode = makeCanvasNode("img-1", CanvasNodeType.Image, { content: "data:image/png;base64,a" });
        const dialogNode = makeCanvasNode("text-1", CanvasNodeType.Text);

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    toolbarNode,
                    dialogNode,
                    maskEditNodeId: "img-1",
                }),
            ),
        );

        expect(toolbarCalls).toHaveLength(1);
        expect(toolbarCalls[0]?.node).toBeNull();
        expect(panelOverlayCalls).toHaveLength(0);
    });

    test("closes prompt dialog when triggering mask editing from the node toolbar", () => {
        const imgNode = makeCanvasNode("img-2", CanvasNodeType.Image, { content: "data:image/png;base64,b", status: "success" });
        const dialogChanges: Array<string | null> = [];
        const maskChanges: Array<string | null> = [];

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    toolbarNode: imgNode,
                    setDialogNodeId: (next) => {
                        dialogChanges.push(typeof next === "function" ? next(imgNode.id) : next);
                    },
                    setMaskEditNodeId: (next) => {
                        maskChanges.push(next);
                    },
                }),
            ),
        );

        expect(toolbarCalls).toHaveLength(1);
        (toolbarCalls[0]?.onMaskEdit as (node: CanvasNodeData) => void)(imgNode);
        expect(dialogChanges).toEqual([null]);
        expect(maskChanges).toEqual(["img-2"]);
    });
});
