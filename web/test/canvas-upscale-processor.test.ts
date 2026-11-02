import { expect, test } from "bun:test";

import { planUpscaleProcessingNode } from "../src/lib/canvas/canvas-upscale-processor";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const media = (id: string, type: CanvasNodeType, x: number, readable = true): CanvasNodeData => ({
    id, type, title: id, position: { x, y: 0 }, width: 100, height: 80,
    metadata: readable ? { content: "data:" } : {},
});

test("connects every selected readable image or video and places the processor to the right", () => {
    const source = media("a", CanvasNodeType.Image, 0);
    const nodes = [source, media("b", CanvasNodeType.Video, 400), media("c", CanvasNodeType.Text, 800), media("d", CanvasNodeType.Image, 1200, false)];
    let nextId = 0;
    const plan = planUpscaleProcessingNode(nodes, [], source, new Set(["a", "b", "c", "d"]), () => `edge-${nextId++}`);
    expect(plan.processor.type).toBe(CanvasNodeType.Upscale);
    expect(plan.processor.position.x).toBeGreaterThan(source.position.x);
    expect(plan.connections.map((edge) => edge.fromNodeId)).toEqual(["a", "b"]);
    expect(plan.connections.every((edge) => edge.toNodeId === plan.processor.id)).toBe(true);
    expect(plan.processor.metadata?.status).toBe("idle");
});

test("uses only the clicked source when it is not part of the selection", () => {
    const source = media("a", CanvasNodeType.Image, 0);
    const plan = planUpscaleProcessingNode([source, media("b", CanvasNodeType.Video, 400)], [], source, new Set(["b"]), () => "edge");
    expect(plan.connections).toEqual([{ id: "edge", fromNodeId: "a", toNodeId: plan.processor.id }]);
});
