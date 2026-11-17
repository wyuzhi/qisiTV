import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasNodeDragEndChrome } from "@/pages/canvas/canvas-pointer-chrome";
import { CanvasNodeType } from "@/types/canvas";
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
}));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({ CanvasOverlayLayerContainer: () => null }));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));

const { CanvasNode } = await import("@/components/canvas/canvas-node");
const { CanvasNodeContent } = await import("@/components/canvas/canvas-node-content");
const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");

function computedPointerEvents(parent?: string, child?: string) {
    return child || parent || "auto";
}

function renderTextNode(isSelected: boolean, readOnly = false) {
    const node = makeCanvasNode("text-node", CanvasNodeType.Text, { content: "示例文案" });
    return renderToStaticMarkup(
        createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(
                CanvasNodeActionContext.Provider,
                {
                    value: {
                        upload: () => undefined,
                        download: () => undefined,
                        duplicate: () => undefined,
                        delete: () => undefined,
                        retry: () => undefined,
                        reload: () => undefined,
                    } as never,
                },
                createElement(CanvasNode, {
                    data: node,
                    scale: 1,
                    isSelected,
                    isRelated: false,
                    isFocusRelated: false,
                    isConnectionTarget: false,
                    showImageInfo: false,
                    readOnly,
                    onMouseDown: () => undefined,
                    onHoverStart: () => undefined,
                    onHoverEnd: () => undefined,
                    onConnectStart: () => undefined,
                    onResize: () => undefined,
                    onContentChange: () => undefined,
                    onContextMenu: () => undefined,
                }),
            ),
        ),
    );
}

beforeEach(() => {
    toolbarCalls.length = 0;
});

describe("canvas text inline edit and empty card", () => {
    test("removes unconfigured empty text from hit-testing and the accessibility tree", () => {
        const emptyNode = makeCanvasNode("empty-text", CanvasNodeType.Text, {});
        const html = renderToStaticMarkup(
            createElement(
                QueryClientProvider,
                { client: new QueryClient() },
                createElement(CanvasNodeContent, {
                    node: emptyNode,
                    projectId: "p1",
                    isEditingContent: false,
                    mentionReferences: [],
                    theme: canvasThemes.dark,
                    onContentChange: () => undefined,
                    onStopEditing: () => undefined,
                }),
            ),
        );
        expect(html).toContain("pointer-events-none");
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain("canvas-node-text-footer");
        expect(html).not.toContain("GVLM 3.1");
        expect(html).not.toContain("6 积分");
    });

    test("keeps computed pointer-events inherited unless child overrides", () => {
        expect(computedPointerEvents("none", undefined)).toBe("none");
        expect(computedPointerEvents("auto", undefined)).toBe("auto");
        expect(computedPointerEvents("none", "auto")).toBe("auto");
    });

    test("keeps the selected enlarge-edit control interactive only while selected", () => {
        const selectedHtml = renderTextNode(true);
        const unselectedHtml = renderTextNode(false);

        expect(selectedHtml).toContain("canvas-node-inline-edit");
        expect(selectedHtml).toContain("pointer-events-auto");
        expect(selectedHtml).toContain('tabindex="0"');
        expect(selectedHtml).toContain('aria-label="放大编辑文本"');
        expect(selectedHtml).toContain('aria-hidden="false"');

        expect(unselectedHtml).toContain('aria-hidden="true"');
        expect(unselectedHtml).toContain('tabindex="-1"');
        expect(renderTextNode(true, true)).not.toContain("canvas-node-inline-edit");
    });

    test("wires toolbar text edit action and keeps text nodes opening prompt panel on selection", () => {
        const textNode = makeCanvasNode("text-edit", CanvasNodeType.Text, { content: "内容" });
        const opened: string[] = [];
        const props = createCanvasStageOverlayProps({ toolbarNode: textNode });
        props.dialogs.openTextNodeEditor = (node) => {
            opened.push(node.id);
        };
        renderToStaticMarkup(createElement(CanvasProjectStageOverlays, props));

        expect(toolbarCalls).toHaveLength(1);
        (toolbarCalls[0]?.onEditText as (node: typeof textNode) => void)(textNode);
        expect(opened).toEqual(["text-edit"]);
        expect(canvasNodeDragEndChrome(textNode)).toEqual({ dialogNodeId: "text-edit" });
    });
});
