import { expect, test } from "bun:test";
import { canvasReferenceIssues, replaceCanvasReferenceToken } from "../src/lib/canvas/canvas-reference-issues";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";
import { inspectNodeGenerationMentions } from "../src/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { Asset } from "../src/stores/use-asset-store";

const image: CanvasResourceReference = { id: "image", nodeId: "image", kind: "image", label: "图片1", title: "人物照片", previewUrl: "data:image/png;base64,AA", active: true };
const nodes: CanvasNodeData[] = [
    { id: "image", type: CanvasNodeType.Image, title: "人物照片", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "data:image/png;base64,AA" } },
    { id: "target", type: CanvasNodeType.Video, title: "生成视频", position: { x: 0, y: 200 }, width: 100, height: 100, metadata: {} },
];
const connections = [{ id: "edge", fromNodeId: "image", toNodeId: "target" }];

test("UI issue descriptions consume the same unresolved bindings as submission", () => {
    const asset: Asset = { id: "a", kind: "image", title: "素材库图片", status: "confirmed", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "data:image/png;base64,AA", width: 1, height: 1, mimeType: "image/png", bytes: 1 } };
    expect(inspectNodeGenerationMentions("target", nodes, connections, "使用 @[node:image]、@图片1 和 @[asset:a]。", [asset]).unresolved).toEqual([]);
    const unresolved = inspectNodeGenerationMentions("target", nodes, [], "使用 @[node:image] 和 @图片9。", []).unresolved;
    const issues = canvasReferenceIssues(unresolved, [{ ...image, active: false }], nodes);
    expect(issues.map((issue) => issue.title)).toEqual(["人物照片", "图片9"]);
    expect(issues[0].nodeId).toBe("image");
    expect(issues[0].reason).toBe("未连接到当前生成节点");
});

test("missing IDs get deduplicated readable labels without leaking IDs", () => {
    const [issue] = canvasReferenceIssues(["@[asset:opaque-id]", "@[asset:opaque-id]"], []);
    expect(issue.title).toBe("素材库引用 1");
    expect(issue.reason).not.toContain("opaque-id");
    expect(canvasReferenceIssues(["@图片1abc", "@图片1"], [])).toHaveLength(1);
});

test("preview availability does not define generation eligibility", () => {
    const unresolved = inspectNodeGenerationMentions("target", nodes, connections, "参考 @[node:image] 和 @图片1|", []).unresolved;
    expect(canvasReferenceIssues(unresolved, [{ ...image, previewUrl: undefined }], nodes)).toEqual([]);
});

test("reselect replaces every occurrence of one binding and leaves other bindings and prose untouched", () => {
    const prompt = "@[asset:a] 与 @[asset:ab]，然后 @[asset:a]。IMAGE 1 不改";
    expect(replaceCanvasReferenceToken(prompt, "@[asset:a]", "@[node:image]")).toBe("@[node:image] 与 @[asset:ab]，然后 @[node:image]。IMAGE 1 不改");
    expect(replaceCanvasReferenceToken("@图片1abc @图片1。@图片10", "@图片1", "@[asset:a]")).toBe("@图片1abc @[asset:a]。@图片10");
});
