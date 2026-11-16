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

test("migrates video frame bindings and reference order on replacement and clears stale frames for non-image", () => {
    const nodes = [
        node("old", CanvasNodeType.Image, { title: "旧首帧", metadata: { content: "https://example.test/old.png" } }),
        node("keep", CanvasNodeType.Image, { title: "尾帧", metadata: { content: "https://example.test/keep.png" } }),
        node("next", CanvasNodeType.Image, { title: "新首帧", metadata: { content: "https://example.test/next.png" } }),
        node("text", CanvasNodeType.Text, { title: "文案", metadata: { content: "旁白文字" } }),
        node("video", CanvasNodeType.Video, {
            metadata: {
                workflowKind: "shot",
                composerContent: "用 @Image1 作为起始画面，衔接 @图片2",
                referenceAssetNodeIds: ["old", "keep"],
                videoStartFrameNodeId: "old",
                videoEndFrameNodeId: "keep",
                videoMiddleFrameNodeId: "old",
                videoMiddleFrameTime: 2,
                videoReferenceOrder: ["old", "keep"],
            },
        }),
        node("cfg", CanvasNodeType.Config, {
            metadata: {
                videoStartFrameNodeId: "old",
                videoReferenceOrder: ["old", "keep"],
            },
        }),
    ];
    const connections = [edge("e1", "old", "cfg"), edge("e2", "keep", "cfg"), edge("main", "video", "cfg")];
    const replaced = replaceCanvasNodeReference(nodes, connections, "video", { id: "ref", nodeId: "old", label: "图片1", title: "旧首帧" }, "next", () => "new-edge");
    const nextVideo = replaced.nodes.find((item) => item.id === "video");
    const nextCfg = replaced.nodes.find((item) => item.id === "cfg");
    expect(nextVideo?.metadata?.videoStartFrameNodeId).toBe("next");
    expect(nextVideo?.metadata?.videoEndFrameNodeId).toBe("keep");
    expect(nextVideo?.metadata?.videoMiddleFrameNodeId).toBe("next");
    expect(nextVideo?.metadata?.videoReferenceOrder).toEqual(["next", "keep"]);
    expect(nextVideo?.metadata?.referenceAssetNodeIds).toEqual(["next", "keep"]);
    expect(nextVideo?.metadata?.composerContent).toBe("用 @图片1 作为起始画面，衔接 @图片2");
    expect(nextCfg?.metadata?.videoStartFrameNodeId).toBe("next");
    expect(nextCfg?.metadata?.videoReferenceOrder).toEqual(["next", "keep"]);

    const cleared = replaceCanvasNodeReference(nodes, connections, "video", { id: "ref", nodeId: "old", label: "图片1" }, "text", () => "text-edge");
    const clearedVideo = cleared.nodes.find((item) => item.id === "video");
    expect(clearedVideo?.metadata?.videoStartFrameNodeId).toBeUndefined();
    expect(clearedVideo?.metadata?.videoMiddleFrameNodeId).toBeUndefined();
    expect(clearedVideo?.metadata?.videoMiddleFrameTime).toBeUndefined();
    expect(clearedVideo?.metadata?.videoEndFrameNodeId).toBe("keep");
    expect(clearedVideo?.metadata?.videoReferenceOrder).toEqual(["keep"]);
    expect(clearedVideo?.metadata?.referenceAssetNodeIds).toEqual(["keep"]);
});
