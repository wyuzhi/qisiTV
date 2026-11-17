import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasAppearanceControls } from "@/components/canvas/canvas-appearance-controls";
import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { canvasThemes } from "@/lib/canvas-theme";
import { resolveRenderedCanvasConnections } from "@/lib/canvas/canvas-connection-policy";
import { CanvasNodeType, type CanvasDisplayConnection, type CanvasNodeData } from "@/types/canvas";

function makeNode(id: string, x: number): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x, y: 0 }, width: 200, height: 150 };
}

const nodeA = makeNode("a", 0);
const nodeB = makeNode("b", 320);
const nodeC = makeNode("c", 640);
const nodeBatchRoot = makeNode("batch-root", 0);

const displayConnections: CanvasDisplayConnection[] = [
    { connection: { id: "edge-ab", fromNodeId: "a", toNodeId: "b" }, from: nodeA, to: nodeB },
    { connection: { id: "edge-bc", fromNodeId: "b", toNodeId: "c" }, from: nodeB, to: nodeC },
    { connection: { id: "edge-batch-c", fromNodeId: "batch-child-1", toNodeId: "c" }, from: nodeBatchRoot, to: nodeC },
];

describe("canvas connection visibility and spotlight", () => {
    test("显示连线开启时渲染全部连线", () => {
        expect(resolveRenderedCanvasConnections(displayConnections, true, new Set(), null)).toEqual(displayConnections);
    });

    test("隐藏连线且未选中任何节点或连线时不渲染连线", () => {
        expect(resolveRenderedCanvasConnections(displayConnections, false, new Set(), null)).toEqual([]);
    });

    test("隐藏连线时选中节点仅浮现与该节点直接关联的连线（含折叠批次展示端点）", () => {
        expect(resolveRenderedCanvasConnections(displayConnections, false, new Set(["a"]), null).map((item) => item.connection.id)).toEqual(["edge-ab"]);
        expect(resolveRenderedCanvasConnections(displayConnections, false, new Set(["b"]), null).map((item) => item.connection.id)).toEqual(["edge-ab", "edge-bc"]);
        expect(resolveRenderedCanvasConnections(displayConnections, false, new Set(["batch-root"]), null).map((item) => item.connection.id)).toEqual(["edge-batch-c"]);
    });

    test("隐藏连线时显式选中的单根连线保持可见", () => {
        expect(resolveRenderedCanvasConnections(displayConnections, false, new Set(), "edge-bc").map((item) => item.connection.id)).toEqual(["edge-bc"]);
    });

    test("ConnectionPath 在隐藏连线聚光模式下使用克制半透明样式，不挂载流光和发光滤镜", () => {
        const spotlightSvg = renderToStaticMarkup(
            createElement(
                "svg",
                null,
                createElement(ConnectionPath, {
                    connection: displayConnections[0].connection,
                    from: nodeA,
                    to: nodeB,
                    active: true,
                    spotlight: true,
                    onSelect: () => {},
                }),
            ),
        );
        expect(spotlightSvg).toContain('data-connection-spotlight="true"');
        expect(spotlightSvg).not.toContain("canvas-connection-comet");
        expect(spotlightSvg).not.toContain("canvas-connection-flow");

        const fullActiveSvg = renderToStaticMarkup(
            createElement(
                "svg",
                null,
                createElement(ConnectionPath, {
                    connection: displayConnections[0].connection,
                    from: nodeA,
                    to: nodeB,
                    active: true,
                    spotlight: false,
                    onSelect: () => {},
                }),
            ),
        );
        expect(fullActiveSvg).toContain("canvas-connection-comet");
        expect(fullActiveSvg).toContain("canvas-connection-flow");
    });

    test("底部缩放栏与外观面板暴露连线显隐、小地图、自动排列与网格吸附开关", () => {
        const zoomVisibleHtml = renderToStaticMarkup(
            createElement(CanvasZoomControls, {
                scale: 1,
                onScaleChange: () => {},
                onFitContent: () => {},
                onAutoArrange: () => {},
                snapToGrid: true,
                onSnapToGridChange: () => {},
                showConnections: true,
                onToggleConnections: () => {},
                isMiniMapOpen: false,
                onToggleMiniMap: () => {},
            }),
        );
        expect(zoomVisibleHtml).toContain("隐藏节点连线");
        expect(zoomVisibleHtml).toContain("切换小地图");

        const zoomHiddenHtml = renderToStaticMarkup(
            createElement(CanvasZoomControls, {
                scale: 1,
                onScaleChange: () => {},
                onFitContent: () => {},
                onAutoArrange: () => {},
                snapToGrid: false,
                onSnapToGridChange: () => {},
                showConnections: false,
                onToggleConnections: () => {},
                isMiniMapOpen: true,
                onToggleMiniMap: () => {},
            }),
        );
        expect(zoomHiddenHtml).toContain("显示节点连线");

        const appearanceHtml = renderToStaticMarkup(
            createElement(CanvasAppearanceControls, {
                appearance: { mode: "follow" },
                backgroundMode: "dots",
                colorTheme: "dark",
                theme: canvasThemes.dark,
                onAppearanceChange: () => {},
                onSaveAppearanceDefault: () => {},
                onBackgroundModeChange: () => {},
                snapToGrid: false,
                onSnapToGridChange: () => {},
                showConnections: true,
                onShowConnectionsChange: () => {},
                wheelBehavior: "zoom",
                onWheelBehaviorChange: () => {},
            }),
        );
        expect(appearanceHtml).toContain("显示连线");
    });
});
