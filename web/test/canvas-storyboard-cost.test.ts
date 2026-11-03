import { describe, expect, test } from "bun:test";

import { storyboardCostTargets } from "../src/lib/canvas/canvas-storyboard-cost";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType } from "../src/types/canvas";

// 全局尺寸和画质故意与模型默认值不同：新建的分镜节点按模型默认值提交，不读这两项。
const config: AiConfig = {
    ...defaultConfig,
    channels: [{
        id: "ch", name: "Fixture", baseUrl: "https://example.test", apiKey: "fixture", apiFormat: "openai", models: ["shot-image", "shot-video"],
        modelProfiles: [
            { model: "shot-image", capability: "image", capabilityConfig: defaultModelCapabilityConfig("image"), capabilitySource: "user" },
            { model: "shot-video", capability: "video", capabilityConfig: defaultModelCapabilityConfig("video"), capabilitySource: "user" },
        ],
    }],
    imageModel: "ch::shot-image",
    videoModel: "ch::shot-video",
    size: "2048x2048",
    quality: "high",
};

describe("storyboardCostTargets", () => {
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 });
    const frame = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { content: "data:image/png;base64,AA==", size: "1536x1024", quality: "medium", count: "2" });
    const clip = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { vquality: "1080p" });
    const nodes = [script, frame, clip];
    const rows = [createStoryboardRow(1, { durationSeconds: 7, imageNodeId: frame.id, videoNodeId: clip.id }), createStoryboardRow(2, { durationSeconds: 6 })];

    test("图片按实际提交的节点估算：已有节点用自己的尺寸、画质和张数，新节点用模型默认值", () => {
        const targets = storyboardCostTargets(config, "image", script, rows, nodes, []);
        expect(targets.map((target) => [target.modelKey, target.parameters?.size, target.parameters?.quality, target.parameters?.count])).toEqual([
            ["ch::shot-image", "1536x1024", "medium", "2"],
            ["ch::shot-image", "1:1", "auto", "1"],
        ]);
    });

    test("视频用所选视频模型和每个镜头的时长，已有视频节点保留自己的分辨率", () => {
        const targets = storyboardCostTargets(config, "text_to_video", script, rows, nodes, [], "ch::shot-video");
        expect(targets.map((target) => [target.modelKey, target.kind, target.parameters?.seconds, target.parameters?.count])).toEqual([
            ["ch::shot-video", "video", "7", "1"],
            ["ch::shot-video", "video", "6", "1"],
        ]);
        expect(targets[0].parameters?.vquality).not.toBe(targets[1].parameters?.vquality);
    });

    test("首帧只在首帧生视频时算作参考图", () => {
        const [textToVideo] = storyboardCostTargets(config, "text_to_video", script, rows, nodes, [], "ch::shot-video");
        const [imageToVideo] = storyboardCostTargets(config, "image_to_video", script, rows, nodes, [], "ch::shot-video");
        expect([textToVideo.referenceImages, imageToVideo.referenceImages]).toEqual([0, 1]);
    });
});
