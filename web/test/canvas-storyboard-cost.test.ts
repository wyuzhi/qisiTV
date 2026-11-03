import { describe, expect, test } from "bun:test";

import { storyboardCostTargets } from "../src/lib/canvas/canvas-storyboard-cost";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { defaultConfig } from "../src/stores/use-config-store";
import { CanvasNodeType } from "../src/types/canvas";

describe("storyboardCostTargets", () => {
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 });

    test("视频按每个镜头自己的时长估算，一个镜头一条", () => {
        const rows = [createStoryboardRow(1, { durationSeconds: 6 }), createStoryboardRow(2, { durationSeconds: 4 })];
        const targets = storyboardCostTargets(defaultConfig, "beefapi::seedance-2.0", "video", script, rows, [script], []);
        expect(targets.map((target) => [target.modelKey, target.kind, target.parameters?.seconds, target.parameters?.count])).toEqual([
            ["beefapi::seedance-2.0", "video", "6", "1"],
            ["beefapi::seedance-2.0", "video", "4", "1"],
        ]);
        expect(targets[0].parameters?.vquality).toBeTruthy();
        expect(targets[0].referenceImages).toBe(0);
    });

    test("图片带上生成时会用的尺寸、画质和张数", () => {
        const config = { ...defaultConfig, size: "2048x2048", quality: "high", count: "2" };
        const [target] = storyboardCostTargets(config, "beefapi::gpt-image-2", "image", script, [createStoryboardRow(1)], [script], []);
        expect(target.kind).toBe("image");
        expect(target.parameters).toMatchObject({ size: "2048x2048", quality: "high" });
        expect(Object.values(target.parameters || {}).every((value) => typeof value === "string" && value !== "")).toBe(true);
    });
});
