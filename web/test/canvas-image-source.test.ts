import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canGenerateImageInPlace } from "@/lib/canvas/canvas-generation-layout";
import { createPortraitTextureNode, isCanvasImageSourceNode } from "@/lib/canvas/canvas-image-source";
import { canOpenCanvasNodePromptPanel } from "@/lib/canvas/canvas-node-semantics";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasStageOverlayProps, makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const panelOverlayCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-workspace-overlays", () => ({
    CanvasNodePanelOverlay: (props: Record<string, unknown> & { children?: ReactNode }) => {
        panelOverlayCalls.push(props);
        return createElement("div", null, props.children);
    },
    CanvasConnectionCreateMenu: () => null,
    CanvasSelectionToolbar: () => null,
}));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({ CanvasNodeToolbar: () => null }));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({
    CanvasOverlayLayerContainer: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    useCanvasOverlayLayer: () => ({ zIndex: 100, bringToFront: () => undefined }),
}));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));

const { CanvasImageMaskEditor } = await import("@/components/canvas/canvas-node-mask-edit-dialog");
const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");
const { nodeHoverToolbarTools } = await import("@/lib/canvas/tool-registry/definitions/node-hover-tools");

const source: CanvasNodeData = {
    id: "uploaded",
    type: CanvasNodeType.Image,
    title: "原图",
    position: { x: 10, y: 20 },
    width: 300,
    height: 200,
    metadata: { content: "original-image", storageKey: "original-key", status: "success" },
};

beforeEach(() => {
    panelOverlayCalls.length = 0;
});

describe("上传图片是输入素材", () => {
    test("上传与导入图片没有生成框，空节点与生成结果仍可配置", () => {
        expect(isCanvasImageSourceNode(source)).toBe(true);
        expect(isCanvasImageSourceNode({ ...source, metadata: {} })).toBe(false);
        expect(isCanvasImageSourceNode({ ...source, metadata: { ...source.metadata, generationType: "edit" } })).toBe(false);
        expect(isCanvasImageSourceNode({ ...source, metadata: { ...source.metadata, taskId: "task" } })).toBe(false);
        expect(isCanvasImageSourceNode({ ...source, metadata: { ...source.metadata, nodeRole: "generator" } })).toBe(false);
        expect(isCanvasImageSourceNode({ ...source, metadata: { ...source.metadata, resultOrigin: "generated" } })).toBe(false);
        expect(isCanvasImageSourceNode({ ...source, type: CanvasNodeType.Video })).toBe(false);
        expect(isCanvasImageSourceNode(null)).toBe(false);
    });

    test("显式复制/版本生成入口保持可用", () => {
        expect(isCanvasImageSourceNode({ ...source, metadata: { ...source.metadata, generationResultPlacement: "replace-node" } })).toBe(false);
        expect(isCanvasImageSourceNode({ ...source, metadata: { ...source.metadata, copiedFromNodeId: "original" } })).toBe(false);
    });

    test("人物质感创建独立编辑节点，不复制原图输出和任务状态", () => {
        const before = structuredClone(source);
        const child = createPortraitTextureNode(source, "texture");
        expect(source).toEqual(before);
        expect(child.id).toBe("texture");
        expect(child.position).toEqual({ x: 406, y: 20 });
        expect(child.metadata?.composerContent).toBe("@图片1");
        expect(child.metadata?.generationType).toBe("edit");
        expect(child.metadata?.content).toBeUndefined();
        expect(child.metadata?.storageKey).toBeUndefined();
        expect(child.metadata?.taskId).toBeUndefined();
        expect(child.metadata?.nodeRole).toBe("generator");
        expect(isCanvasImageSourceNode(child)).toBe(false);
        expect(canGenerateImageInPlace(child)).toBe(true);
        expect(canGenerateImageInPlace(source)).toBe(false);
    });

    test("页面和工具入口共享素材判定，不给上传原图弹出生成框", () => {
        const child = createPortraitTextureNode(source, "texture-child");
        expect(canOpenCanvasNodePromptPanel(source)).toBe(false);
        expect(canOpenCanvasNodePromptPanel(child)).toBe(true);

        const openPromptTool = nodeHoverToolbarTools.find((tool) => tool.id === "open-prompt");
        if (openPromptTool?.visible) {
            expect(openPromptTool.visible({ node: source, nodeMetadata: source.metadata, workspaceMode: "canvas" } as never)).toBe(false);
            expect(openPromptTool.visible({ node: child, nodeMetadata: child.metadata, workspaceMode: "canvas" } as never)).toBe(true);
        }

        renderToStaticMarkup(createElement(CanvasProjectStageOverlays, createCanvasStageOverlayProps({ dialogNode: source })));
        expect(panelOverlayCalls).toHaveLength(0);

        const generatorNode = makeCanvasNode("gen-1", CanvasNodeType.Image);
        renderToStaticMarkup(createElement(CanvasProjectStageOverlays, createCanvasStageOverlayProps({ dialogNode: generatorNode })));
        expect(panelOverlayCalls).toHaveLength(1);

        const editorHtml = renderToStaticMarkup(
            createElement(CanvasImageMaskEditor, {
                imageDimensions: { width: 512, height: 512 },
                scale: 1,
                config: defaultConfig,
                onCancel: () => undefined,
                onConfirm: () => undefined,
            }),
        );
        expect(editorHtml).toContain('aria-label="局部重绘设置"');
    });
});
