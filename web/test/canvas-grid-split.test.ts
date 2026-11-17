import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNode } from "../src/components/canvas/canvas-node";
import { CANVAS_GRID_SPLIT_GAP, clampGridSplitSize, isValidGridSplit, layoutGridSplitCells } from "../src/lib/canvas/canvas-grid-split";
import { CanvasNodeType } from "../src/types/canvas";

describe("canvas-grid-split", () => {
    test("clamps size into 1..5", () => {
        expect(clampGridSplitSize(0)).toBe(1);
        expect(clampGridSplitSize(8)).toBe(5);
        expect(clampGridSplitSize(2.6)).toBe(3);
    });

    test("rejects a single cell", () => {
        expect(isValidGridSplit({ rows: 1, columns: 1 })).toBe(false);
        expect(isValidGridSplit({ rows: 1, columns: 2 })).toBe(true);
        expect(isValidGridSplit({ rows: 3, columns: 2 })).toBe(true);
    });

    test("lays out fitted cells without overlap and keeps default 96px gap", () => {
        const cells = [
            { row: 0, column: 0, width: 592, height: 432 },
            { row: 0, column: 1, width: 592, height: 432 },
            { row: 1, column: 0, width: 592, height: 432 },
            { row: 1, column: 1, width: 592, height: 432 },
        ];
        expect(CANVAS_GRID_SPLIT_GAP).toBe(96);
        const defaultPositions = layoutGridSplitCells({ x: 100, y: 40 }, cells);
        expect(defaultPositions[1]).toEqual({ x: 100 + 592 + 96, y: 40 });
        expect(defaultPositions[2]).toEqual({ x: 100, y: 40 + 432 + 96 });
        expect(defaultPositions[3]).toEqual({ x: 100 + 592 + 96, y: 40 + 432 + 96 });

        const positions = layoutGridSplitCells({ x: 100, y: 40 }, cells, 48);
        expect(positions[1]).toEqual({ x: 100 + 592 + 48, y: 40 });
        expect(positions[2]).toEqual({ x: 100, y: 40 + 432 + 48 });
        expect(positions[3]).toEqual({ x: 100 + 592 + 48, y: 40 + 432 + 48 });
        expect(positions[1]!.x).toBeGreaterThanOrEqual(positions[0]!.x + cells[0]!.width + 48);
        expect(positions[2]!.y).toBeGreaterThanOrEqual(positions[0]!.y + cells[0]!.height + 48);
    });

    test("keeps resting connection side rail hitbox compact so neighbor split nodes do not block output handle", () => {
        const noop = () => {};
        const markup = renderToStaticMarkup(
            createElement(CanvasNode, {
                data: {
                    id: "split-cell-0-1",
                    type: CanvasNodeType.Image,
                    title: "图片 · 宫格 1-2",
                    position: { x: 688, y: 0 },
                    width: 592,
                    height: 432,
                    metadata: { content: "data:image/png;base64,AAAA" },
                },
                scale: 1,
                isSelected: true,
                isRelated: false,
                isFocusRelated: false,
                isConnectionTarget: false,
                showImageInfo: false,
                onMouseDown: noop,
                onHoverStart: noop,
                onHoverEnd: noop,
                onConnectStart: noop,
                onResize: noop,
                onTitleChange: noop,
                onContentChange: noop,
                onContextMenu: noop,
            }),
        );
        expect(markup).not.toContain('data-canvas-connection-rail="left"');
        expect(markup).toContain('data-canvas-connection-rail="right"');
        expect(markup).toContain("width:28px");
        expect(markup).not.toContain("width:80px");

        const generatedMarkup = renderToStaticMarkup(
            createElement(CanvasNode, {
                data: {
                    id: "generated-cell",
                    type: CanvasNodeType.Image,
                    title: "AI 生成图",
                    position: { x: 688, y: 0 },
                    width: 592,
                    height: 432,
                    metadata: { content: "data:image/png;base64,AAAA", resultOrigin: "generated" },
                },
                scale: 1,
                isSelected: true,
                isRelated: false,
                isFocusRelated: false,
                isConnectionTarget: false,
                showImageInfo: false,
                onMouseDown: noop,
                onHoverStart: noop,
                onHoverEnd: noop,
                onConnectStart: noop,
                onResize: noop,
                onTitleChange: noop,
                onContentChange: noop,
                onContextMenu: noop,
            }),
        );
        expect(generatedMarkup).toContain('data-canvas-connection-rail="left"');
        expect(generatedMarkup).toContain('data-canvas-connection-rail="right"');
        expect(generatedMarkup).toContain("width:28px");
        expect(generatedMarkup).not.toContain("width:80px");
    });
});
