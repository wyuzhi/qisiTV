import { expect, test } from "bun:test";

import { replaceCanvasNodeReference } from "../src/lib/canvas/canvas-reference-replace";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";

const node = (id: string, type: CanvasNodeType, extra: Partial<CanvasNodeData> = {}): CanvasNodeData => ({
    id, type, title: id, position: { x: 0, y: 0 }, width: 8, height: 8, ...extra,
});
const edge = (id: string, fromNodeId: string, toNodeId: string): CanvasConnection => ({ id, fromNodeId, toNodeId });

test("rewires the existing reference edge and rewrites the prompt mention", () => {
    const nodes = [
        node("old", CanvasNodeType.Image, { title: "旧图" }),
        node("next", CanvasNodeType.Image, { title: "新图" }),
        node("shot", CanvasNodeType.Image, { metadata: { prompt: "用 @图片1 做背景" } }),
    ];
    const connections = [edge("e1", "old", "shot")];
    const result = replaceCanvasNodeReference(nodes, connections, "shot", { id: "ref", nodeId: "old", label: "图片1" }, "next", () => "e2");
    expect(result.connections).toEqual([edge("e1", "next", "shot")]);
    const shot = result.nodes.find((item) => item.id === "shot");
    expect(shot?.metadata?.prompt ?? shot?.metadata?.composerContent).toContain("@图片1");
    expect(shot?.metadata?.prompt ?? shot?.metadata?.composerContent).not.toContain("旧图");
    expect(result.notice).toBe("已将参考图「图片1」替换为「新图」，提示词已同步更新");
    expect(connections[0]?.fromNodeId).toBe("old");
});

test("adds a new edge when the old reference was not connected, and routes it through a config node", () => {
    const nodes = [
        node("old", CanvasNodeType.Image),
        node("next", CanvasNodeType.Image, { title: "替补" }),
        node("shot", CanvasNodeType.Image),
        node("config", CanvasNodeType.Config),
    ];
    const connections = [edge("main", "shot", "config")];
    const result = replaceCanvasNodeReference(nodes, connections, "shot", { id: "ref", nodeId: "missing", label: "图片2" }, "next", () => "added");
    expect(result.connections.map((item) => item.id)).toEqual(["main", "added"]);
    expect(result.connections[1]).toEqual(edge("added", "next", "config"));
});

test("does nothing when the replacement is the reference itself", () => {
    const nodes = [node("same", CanvasNodeType.Image), node("shot", CanvasNodeType.Image)];
    const connections = [edge("e1", "same", "shot")];
    const result = replaceCanvasNodeReference(nodes, connections, "shot", { id: "ref", nodeId: "same" }, "same");
    expect(result.nodes).toBe(nodes);
    expect(result.connections).toBe(connections);
    expect(result.notice).toBeNull();
});
