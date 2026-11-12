import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    appendCanvasResourceMentionToPrompt,
    connectAndAppendCanvasResourceMention,
    connectCanvasResourceMention,
    connectCanvasTextMention,
    registerCanvasPickConnectHandler,
    useCanvasPickConnectStore,
} from "@/lib/canvas/canvas-text-mention";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { ConnectedReferenceShelf } from "@/components/canvas/canvas-node-reference-shelf";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasResourceMentionToken } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const nodes: CanvasNodeData[] = [
    { id: "text", type: CanvasNodeType.Text, title: "镜头正文", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { content: "清晨，人物推开木门" } },
    { id: "video", type: CanvasNodeType.Video, title: "镜头1", position: { x: 500, y: 0 }, width: 300, height: 200 },
];

test("selecting an unconnected text mention connects and expands its content for video generation", () => {
    const linked = connectCanvasTextMention(nodes, [], "video", "text", "edge");
    expect(linked.connections).toEqual([{ id: "edge", fromNodeId: "text", toNodeId: "video" }]);
    expect(linked.reference.active).toBe(true);
    const prompt = `${canvasResourceMentionToken(linked.reference)} 缓慢运镜`;
    const context = buildNodeGenerationContext("video", linked.nodes, linked.connections, prompt, []);
    expect(context.prompt).toContain("清晨，人物推开木门");
    expect(context.prompt).toContain("缓慢运镜");
    expect(connectCanvasTextMention(linked.nodes, linked.connections, "video", "text", "duplicate").connections).toHaveLength(1);
});

test("text mentions follow a connected Config and reject cycles, self references and locked targets", () => {
    const config: CanvasNodeData = { ...nodes[1], id: "config", type: CanvasNodeType.Config };
    const other: CanvasNodeData = { ...nodes[0], id: "other" };
    const linked = connectCanvasTextMention([...nodes, config, other], [{ id: "config-edge", fromNodeId: "video", toNodeId: "config" }, { id: "existing", fromNodeId: "other", toNodeId: "config" }], "video", "text", "edge");
    expect(linked.connections[2].toNodeId).toBe("config");
    expect(linked.reference.label).toBe("文本2");
    expect(linked.reference.nodeId).toBe("text");
    expect(() => connectCanvasTextMention(nodes, [{ id: "reverse", fromNodeId: "video", toNodeId: "text" }], "video", "text", "edge")).toThrow("循环");
    expect(() => connectCanvasTextMention(nodes, [], "text", "text", "edge")).toThrow();
    expect(() => connectCanvasTextMention(nodes.map((node) => node.id === "video" ? { ...node, metadata: { locked: true } } : node), [], "video", "text", "edge")).toThrow();
});

test("appending a text reference preserves existing mention numbering with an empty Config", () => {
    const other: CanvasNodeData = { ...nodes[0], id: "other", metadata: { content: "原有文本" } };
    const config: CanvasNodeData = { ...nodes[1], id: "config", type: CanvasNodeType.Config };
    const linked = connectCanvasTextMention([...nodes, other, config], [{ id: "old", fromNodeId: "other", toNodeId: "video" }, { id: "config", fromNodeId: "video", toNodeId: "config" }], "video", "text", "new");
    expect(linked.connections[2].toNodeId).toBe("video");
    expect(linked.reference.label).toBe("文本2");
    const context = buildNodeGenerationContext("video", linked.nodes, linked.connections, "@文本1 @文本2", []);
    expect(context.prompt).toContain("原有文本");
    expect(context.prompt).toContain("清晨，人物推开木门");
});

test("connects unconnected image, video, audio, and character resource nodes and appends mention token", () => {
    const imageNode: CanvasNodeData = {
        id: "img-1",
        type: CanvasNodeType.Image,
        title: "参考海报",
        position: { x: 0, y: 200 },
        width: 240,
        height: 240,
        metadata: { content: "https://example.com/poster.png" },
    };
    const audioNode: CanvasNodeData = {
        id: "aud-1",
        type: CanvasNodeType.Audio,
        title: "环境音",
        position: { x: 0, y: 460 },
        width: 240,
        height: 120,
        metadata: { content: "https://example.com/bgm.mp3" },
    };
    const targetVideo: CanvasNodeData = {
        id: "vid-target",
        type: CanvasNodeType.Video,
        title: "分镜1",
        position: { x: 500, y: 200 },
        width: 300,
        height: 200,
        metadata: { prompt: "主角转身", composerContent: "主角转身" },
    };
    const allNodes = [imageNode, audioNode, targetVideo];
    const first = connectAndAppendCanvasResourceMention(allNodes, [], "vid-target", "img-1", "edge-img");
    expect(first.connections).toEqual([{ id: "edge-img", fromNodeId: "img-1", toNodeId: "vid-target" }]);
    expect(first.reference.kind).toBe("image");
    expect(first.reference.label).toBe("图片1");
    const updatedTarget1 = first.nodes.find((n) => n.id === "vid-target")!;
    expect(updatedTarget1.metadata?.composerContent).toBe("主角转身 @[node:img-1] ");

    const second = connectCanvasResourceMention(first.nodes, first.connections, "vid-target", "aud-1", "edge-aud");
    expect(second.connections).toHaveLength(2);
    expect(second.reference.kind).toBe("audio");
    expect(second.reference.label).toBe("音频1");
    expect(appendCanvasResourceMentionToPrompt(updatedTarget1.metadata?.composerContent || "", second.reference)).toBe("主角转身 @[node:img-1] @[node:aud-1] ");
});

test("pick-connect store and handler registration toggle target node cleanly", () => {
    useCanvasPickConnectStore.getState().setPickConnectTargetNodeId(null);
    expect(useCanvasPickConnectStore.getState().pickConnectTargetNodeId).toBeNull();
    useCanvasPickConnectStore.getState().togglePickConnectTargetNodeId("node-a");
    expect(useCanvasPickConnectStore.getState().pickConnectTargetNodeId).toBe("node-a");
    useCanvasPickConnectStore.getState().togglePickConnectTargetNodeId("node-a");
    expect(useCanvasPickConnectStore.getState().pickConnectTargetNodeId).toBeNull();

    const calls: Array<[string, string]> = [];
    const unregister = registerCanvasPickConnectHandler("proj-1", (targetId, sourceId) => {
        calls.push([targetId, sourceId]);
        return undefined;
    });
    unregister();
    expect(calls).toEqual([]);
});

test("ConnectedReferenceShelf preview thumbnail uses single-click insert label with double-click preview hint", () => {
    const html = renderToStaticMarkup(
        React.createElement(ConnectedReferenceShelf, {
            references: [
                {
                    id: "img-1",
                    nodeId: "img-1",
                    kind: "image",
                    label: "图片1",
                    title: "赛博街景",
                    active: true,
                    previewUrl: "https://example.com/img-1.png",
                },
            ],
            theme: canvasThemes.dark,
            onInsert: () => {},
        }),
    );
    expect(html).toContain("点击插入 @赛博街景（双击预览大图）");
});
