import { describe, expect, test } from "bun:test";

import { isolateCopiedNodeMetadata, nextCopiedNodeTitle } from "@/lib/canvas/canvas-node-copy";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

describe("canvas node copy title", () => {
    test("首次复制使用 copy1，后续按已有最大序号递增", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图"])).toBe("女明星角色三视图_copy1");
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图", "女明星角色三视图_copy1"])).toBe("女明星角色三视图_copy2");
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图_copy1", "女明星角色三视图_copy3"])).toBe("女明星角色三视图_copy4");
    });

    test("复制已有副本时仍使用原始名称计算下一序号", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图_copy1", ["女明星角色三视图", "女明星角色三视图_copy1"])).toBe("女明星角色三视图_copy2");
    });

    test("兼容旧版空格 Copy 后缀", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图 Copy", ["女明星角色三视图", "女明星角色三视图 Copy"])).toBe("女明星角色三视图_copy1");
    });

    test("同一批粘贴可以通过预留标题连续分配序号", () => {
        const titles = new Set(["节点", "节点_copy1"]);
        const first = nextCopiedNodeTitle("节点", titles);
        titles.add(first);
        const second = nextCopiedNodeTitle("节点", titles);
        expect([first, second]).toEqual(["节点_copy2", "节点_copy3"]);
    });
});

describe("canvas generation copy metadata", () => {
    test("copying connected nodes remaps identity prompts to the copied image", () => {
        const image: CanvasNodeData = { id: "A", type: CanvasNodeType.Image, title: "参考", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "data:image/png;base64,a" } };
        const video: CanvasNodeData = { ...image, id: "V", type: CanvasNodeType.Video, metadata: { prompt: "@[node:A]人物移动", composerContent: "@[node:A]人物移动" } };
        const idMap = new Map([["A", "A-copy"], ["V", "V-copy"]]);
        const graph = [image, video].map((source) => ({ ...source, id: idMap.get(source.id)!, metadata: isolateCopiedNodeMetadata(source, idMap) }));
        const copied = graph[1];
        expect(copied.metadata.prompt).toBe("@[node:A-copy]人物移动");
        expect(copied.metadata.composerContent).toBe("@[node:A-copy]人物移动");
        const context = buildNodeGenerationContext(copied.id, graph, [{ id: "edge-copy", fromNodeId: "A-copy", toNodeId: copied.id }], copied.metadata.composerContent!, [], true, { preserveMediaBindings: true });
        expect(context.referenceImages.map((item) => item.id)).toEqual(["A-copy"]);
        expect(context.boundMediaMentions).toEqual([{ token: "@[node:A-copy]", kind: "image", referenceId: "A-copy" }]);
        expect(video.metadata?.composerContent).toBe("@[node:A]人物移动");
    });

    test("copy remaps exact identity tokens in text and self references while preserving external IDs", () => {
        const original = "A @[node:A] @[node:A-long] @[node:external] @[asset:A] @图片1 @[node:A]";
        const source: CanvasNodeData = { id: "A", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: original, prompt: original, composerContent: original } };
        const idMap = new Map([["A", "A-copy"]]);
        const expected = "A @[node:A-copy] @[node:A-long] @[node:external] @[asset:A] @图片1 @[node:A-copy]";
        const copied = isolateCopiedNodeMetadata(source, idMap);
        expect(copied.content).toBe(expected);
        expect(copied.prompt).toBe(expected);
        expect(copied.composerContent).toBe(expected);
        expect(isolateCopiedNodeMetadata({ ...source, type: CanvasNodeType.Image }, idMap).content).toBe(original);
        expect(source.metadata?.content).toBe(original);

        const image: CanvasNodeData = { ...source, type: CanvasNodeType.Image, metadata: { content: "data:image/png;base64,a", composerContent: "@[node:A]变清晰" } };
        const imageCopy = { ...image, id: "A-copy", metadata: isolateCopiedNodeMetadata(image, idMap) };
        expect(buildNodeGenerationContext(imageCopy.id, [imageCopy], [], imageCopy.metadata.composerContent!, []).referenceImages.map((item) => item.id)).toEqual(["A-copy"]);
    });

    test("copied text content keeps nested references bound to copied media", () => {
        const image: CanvasNodeData = { id: "A", type: CanvasNodeType.Image, title: "参考", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "data:image/png;base64,a" } };
        const text = { ...image, id: "text", type: CanvasNodeType.Text, metadata: { content: "@[node:A]保持服装" } };
        const video = { ...image, id: "video", type: CanvasNodeType.Video, metadata: { composerContent: "@[node:text]动起来" } };
        const idMap = new Map([["A", "A-copy"], ["text", "text-copy"], ["video", "video-copy"]]);
        const graph = [image, text, video].map((source) => ({ ...source, id: idMap.get(source.id)!, metadata: isolateCopiedNodeMetadata(source, idMap) }));
        const context = buildNodeGenerationContext("video-copy", graph, ["A-copy", "text-copy"].map((id) => ({ id: `edge-${id}`, fromNodeId: id, toNodeId: "video-copy" })), graph[2].metadata.composerContent!, [], true, { preserveMediaBindings: true });
        expect(context.prompt).toContain("@[node:A-copy]保持服装");
        expect(context.boundMediaMentions).toEqual([{ token: "@[node:A-copy]", kind: "image", referenceId: "A-copy" }]);
    });

    test.each([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio])("%s 副本不继承原节点的生成提交标记", (type) => {
        const source: CanvasNodeData = {
            id: "source", type, title: "结果", position: { x: 0, y: 0 }, width: 340, height: 240,
            metadata: { content: "saved-media", storageKey: "saved-media-key", assetId: "saved-asset", taskId: "old-task", generationEffectKeys: ["attach-node:old-task:source:0"] },
        };
        const metadata = isolateCopiedNodeMetadata(source, new Map([[source.id, "copy"]]));
        expect(metadata.generationEffectKeys).toBeUndefined();
        expect(metadata.taskId).toBeUndefined();
        expect(metadata.content).toBe("saved-media");
        expect(metadata.storageKey).toBe("saved-media-key");
        expect(metadata.assetId).toBe("saved-asset");
        expect(source.metadata?.generationEffectKeys).toEqual(["attach-node:old-task:source:0"]);
        expect(source.metadata?.taskId).toBe("old-task");
    });

    test("媒体副本保留提示词与参考字段，并明确原地回填生成结果", () => {
        const source: CanvasNodeData = {
            id: "source",
            type: CanvasNodeType.Video,
            title: "镜头",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: {
                content: "video-url",
                prompt: "相同提示词",
                videoStartFrameNodeId: "reference-start",
                videoEndFrameNodeId: "reference-end",
                generationResultPlacement: "new-version",
            },
        };

        const metadata = isolateCopiedNodeMetadata(source, new Map([[source.id, "copy"]]));

        expect(metadata.prompt).toBe("相同提示词");
        expect(metadata.videoStartFrameNodeId).toBe("reference-start");
        expect(metadata.videoEndFrameNodeId).toBe("reference-end");
        expect(metadata.copiedFromNodeId).toBe("source");
        expect(metadata.generationResultPlacement).toBe("replace-node");
    });

    test("复制到副本的入边继续解析为同一张参考图", () => {
        const reference: CanvasNodeData = {
            id: "reference",
            type: CanvasNodeType.Image,
            title: "角色参考",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: { content: "reference-url", mimeType: "image/png" },
        };
        const copy: CanvasNodeData = {
            id: "copy",
            type: CanvasNodeType.Image,
            title: "结果_copy1",
            position: { x: 400, y: 0 },
            width: 340,
            height: 240,
            metadata: { content: "old-result", prompt: "保持角色一致", copiedFromNodeId: "source", generationResultPlacement: "replace-node" },
        };

        const context = buildNodeGenerationContext(copy.id, [reference, copy], [{ id: "copy-reference", fromNodeId: reference.id, toNodeId: copy.id }], copy.metadata!.prompt!, []);

        expect(context.prompt).toBe("保持角色一致");
        expect(context.referenceImages.map((image) => image.id)).toEqual([reference.id]);
    });
});
