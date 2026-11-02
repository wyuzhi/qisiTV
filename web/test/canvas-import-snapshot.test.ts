import { expect, test } from "bun:test";

import { appendCanvasImport } from "../src/lib/canvas/canvas-import-snapshot";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";

const node = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 8, height: 8 });
const edge = (id: string, fromNodeId: string, toNodeId: string): CanvasConnection => ({ id, fromNodeId, toNodeId });

test("appends imported nodes and connections without touching the current snapshot", () => {
    const current = { nodes: [node("a")], connections: [edge("e1", "a", "a")] };
    const next = appendCanvasImport(current, [node("b")], [edge("e2", "a", "b")]);
    expect(next.nodes.map((item) => item.id)).toEqual(["a", "b"]);
    expect(next.connections.map((item) => item.id)).toEqual(["e1", "e2"]);
    expect(current.nodes).toHaveLength(1);
    expect(current.connections).toHaveLength(1);
});

test("an empty import still returns new arrays so a failed save can restore the previous ones", () => {
    const current = { nodes: [node("a")], connections: [] as CanvasConnection[] };
    const next = appendCanvasImport(current, [], []);
    expect(next.nodes).not.toBe(current.nodes);
    expect(next.nodes).toEqual(current.nodes);
    expect(next.connections).toEqual([]);
});
