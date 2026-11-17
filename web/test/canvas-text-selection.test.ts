import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canvasThemes } from "@/lib/canvas-theme";
import { canOpenCanvasNodePromptPanel } from "@/lib/canvas/canvas-node-semantics";
import { canvasNodeDragEndChrome, resolvePromptDialogNode } from "@/pages/canvas/canvas-pointer-chrome";
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
mock.module("@/lib/canvas/canvas-rich-text", () => ({
    canvasRichTextHTML: (doc?: Record<string, unknown>) => (doc ? "<p>富文本内容</p>" : ""),
    isSafeCanvasRichTextLink: () => true,
}));

const { CanvasNodeContent } = await import("@/components/canvas/canvas-node-content");
const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");

beforeEach(() => {
    panelOverlayCalls.length = 0;
    toolbarCalls.length = 0;
});

function renderNodeContent(node: CanvasNodeData, isEditingContent = false) {
    return renderToStaticMarkup(
        createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(CanvasNodeContent, {
                node,
                projectId: "proj-1",
                isEditingContent,
                mentionReferences: [],
                theme: canvasThemes.dark,
                onContentChange: () => undefined,
                onStopEditing: () => undefined,
            }),
        ),
    );
}

describe("text node selection (#429)", () => {
    test("media generators open the generation panel while all media results use tools", () => {
        const generator = makeCanvasNode("gen-img", CanvasNodeType.Image);
        const result = makeCanvasNode("res-img", CanvasNodeType.Image, { content: "https://example.com/a.png", status: "success" });

        expect(canOpenCanvasNodePromptPanel(generator)).toBe(true);
        expect(canOpenCanvasNodePromptPanel(result)).toBe(false);
        expect(canvasNodeDragEndChrome(generator)).toEqual({ dialogNodeId: "gen-img" });
        expect(canvasNodeDragEndChrome(result)).toEqual({ dialogNodeId: null, toolbarNodeId: "res-img" });
    });

    test("the render boundary rejects stale dialog state for result media", () => {
        const result = makeCanvasNode("res-video", CanvasNodeType.Video, { content: "https://example.com/v.mp4", status: "success" });
        const textNode = makeCanvasNode("txt-1", CanvasNodeType.Text);

        expect(resolvePromptDialogNode(result)).toBeNull();
        expect(resolvePromptDialogNode(textNode)).toBe(textNode);

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    dialogNode: resolvePromptDialogNode(result),
                    toolbarNode: result,
                }),
            ),
        );
        expect(panelOverlayCalls).toHaveLength(0);
        expect((toolbarCalls[0]?.node as CanvasNodeData | null)?.id).toBe("res-video");
    });

    test("allows plain and rich text previews to render selectable text without dragging traps", () => {
        const plainNode = makeCanvasNode("txt-plain", CanvasNodeType.Text, { content: "普通文本" });
        const richNode = makeCanvasNode("txt-rich", CanvasNodeType.Text, {
            content: "标题",
            richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "富文本内容" }] }] },
        });
        const editingHtml = renderNodeContent(plainNode, true);
        const plainHtml = renderNodeContent(plainNode, false);
        const richHtml = renderNodeContent(richNode, false);

        expect(editingHtml).toContain("<textarea");
        expect(plainHtml).toContain("select-text");
        expect(plainHtml).toContain("普通文本");
        expect(richHtml).toContain("select-text");
        expect(richHtml).toContain("富文本内容");
    });
});
