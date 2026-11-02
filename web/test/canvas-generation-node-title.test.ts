import { describe, expect, test } from "bun:test";

import { buildImageGenerationNodeTitle, promptNodeTitle } from "@/lib/canvas/canvas-generation-title";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(title: string, type: CanvasNodeData["type"] = CanvasNodeType.Text): CanvasNodeData {
    return { id: "node-1", type, title, position: { x: 0, y: 0 }, width: 320, height: 180 };
}

describe("canvas generation node title", () => {
    test("keeps a title the user gave the node (飞书 #66)", () => {
        expect(promptNodeTitle(node("分镜 1 - 清晨街角"), "一只猫在草地上打滚，阳光很好")).toBe("分镜 1 - 清晨街角");
    });

    test("names an unnamed node after the prompt", () => {
        expect(promptNodeTitle(node("文本节点"), "一只猫在草地上打滚")).toBe("一只猫在草地上打滚");
        expect(promptNodeTitle(node("  "), "一只猫在草地上打滚")).toBe("一只猫在草地上打滚");
    });

    test("keeps generation result nodes named after the prompt", () => {
        expect(buildImageGenerationNodeTitle("一只猫", undefined)).toBe("一只猫");
    });
});
