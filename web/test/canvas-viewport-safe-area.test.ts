import { expect, test } from "bun:test";

import { connectedNodeVisibleViewport } from "@/pages/canvas/canvas-viewport-safe-area";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function box(id: string, x: number, y: number, width = 720, height = 405): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x, y },
        width,
        height,
    };
}

test("returns null when the canvas has not been measured", () => {
    expect(connectedNodeVisibleViewport({
        node: box("target", 900, 40),
        nodes: [box("source", 0, 40)],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
        canvasWidth: 0,
        canvasHeight: 720,
    })).toBeNull();
});

test("returns null when the newly connected node is already inside the safe area", () => {
    const source = box("source", 100, 120, 320, 200);
    const target = box("target", 500, 120, 320, 200);
    expect(connectedNodeVisibleViewport({
        node: target,
        sourceNodeId: "source",
        nodes: [source, target],
        connections: [{ id: "c1", fromNodeId: "source", toNodeId: "target" }],
        viewport: { x: 0, y: 0, k: 1 },
        canvasWidth: 1200,
        canvasHeight: 720,
    })).toBeNull();
});

test("never zooms in when zoomed out on a large storyboard canvas (k = 0.2)", () => {
    const source = box("source", 1000, 1000, 720, 405);
    const target = box("target", 5800, 1000, 720, 405);
    const next = connectedNodeVisibleViewport({
        node: target,
        sourceNodeId: "source",
        nodes: [source, target],
        connections: [{ id: "c1", fromNodeId: "source", toNodeId: "target" }],
        viewport: { x: 0, y: 0, k: 0.2 },
        canvasWidth: 1200,
        canvasHeight: 720,
    });
    expect(next).not.toBeNull();
    expect(next!.k).toBeLessThanOrEqual(0.2);
});

test("pans minimally into the safe area when the node overflows to the right/bottom", () => {
    const source = box("source", 100, 100, 300, 200);
    const target = box("target", 950, 480, 300, 200);
    const next = connectedNodeVisibleViewport({
        node: target,
        sourceNodeId: "source",
        nodes: [source, target],
        connections: [{ id: "c1", fromNodeId: "source", toNodeId: "target" }],
        viewport: { x: 0, y: 0, k: 1 },
        canvasWidth: 1200,
        canvasHeight: 720,
    });
    expect(next).toEqual({
        x: 1176 - 1250,
        y: 648 - 680,
        k: 1,
    });
});

test("pans the viewport and leaves node world positions unchanged", () => {
    const source = box("source", 0, 40);
    const target = box("target", 2000, 40);
    const next = connectedNodeVisibleViewport({
        node: target,
        sourceNodeId: "source",
        nodes: [source, target],
        connections: [{ id: "c1", fromNodeId: "source", toNodeId: "target" }],
        viewport: { x: 0, y: 0, k: 1 },
        canvasWidth: 1200,
        canvasHeight: 720,
    });
    expect(next).not.toBeNull();
    expect(target.position).toEqual({ x: 2000, y: 40 });
    expect(source.position).toEqual({ x: 0, y: 40 });
    expect(next?.k).toBeLessThan(1);
});
