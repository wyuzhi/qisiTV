import { describe, expect, test } from "bun:test";
import { applyNodeConfigPatch } from "../src/lib/canvas/canvas-project-domain";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-generation-config";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { createModelChannel, defaultConfig, effectiveConfigForCustomChannels } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function imageNode(metadata: Record<string, unknown> = {}): CanvasNodeData {
    return {
        id: "image-1",
        type: CanvasNodeType.Image,
        title: "图片",
        position: { x: 0, y: 0 },
        width: 400,
        height: 400,
        metadata: metadata as CanvasNodeData["metadata"],
    };
}

describe("applyNodeConfigPatch 模型切换清理生成参数", () => {
    test("切换模型标识时清理旧模型的能力档位参数，回落全局配置", () => {
        const node = imageNode({
            model: "default::gpt-image-2",
            size: "1:1",
            quality: "high",
            count: 2,
            transparentBackground: "true",
        });
        const next = applyNodeConfigPatch(node, { model: "default::grok-imagine-video" });
        expect(next.metadata?.model).toBe("default::grok-imagine-video");
        expect(next.metadata?.size).toBeUndefined();
        expect(next.metadata?.quality).toBeUndefined();
        expect(next.metadata?.count).toBeUndefined();
        expect(next.metadata?.transparentBackground).toBeUndefined();
    });

    test("视频参数随模型切换一并清理", () => {
        const node = imageNode({
            model: "default::seedance-video",
            seconds: "10",
            vquality: "1080p",
            generateAudio: "true",
            watermark: "false",
            draft: "true",
            returnLastFrame: "true",
        });
        const next = applyNodeConfigPatch(node, { model: "default::veo-3" });
        expect(next.metadata?.seconds).toBeUndefined();
        expect(next.metadata?.vquality).toBeUndefined();
        expect(next.metadata?.generateAudio).toBeUndefined();
        expect(next.metadata?.watermark).toBeUndefined();
        expect(next.metadata?.draft).toBeUndefined();
        expect(next.metadata?.returnLastFrame).toBeUndefined();
    });

    test("视频生成配置仅在 480p 时保留 videoDraft 并透传 videoReturnLastFrame", () => {
        const draft480 = buildGenerationConfig(
            defaultConfig,
            {
                id: "video-1",
                type: CanvasNodeType.Video,
                title: "视频",
                position: { x: 0, y: 0 },
                width: 400,
                height: 300,
                metadata: {
                    vquality: "480p",
                    draft: "true",
                    returnLastFrame: "true",
                },
            },
            "video",
        );
        expect(draft480.videoDraft).toBe("true");
        expect(draft480.videoReturnLastFrame).toBe("true");

        const draft720 = buildGenerationConfig(
            defaultConfig,
            {
                id: "video-2",
                type: CanvasNodeType.Video,
                title: "视频",
                position: { x: 0, y: 0 },
                width: 400,
                height: 300,
                metadata: {
                    vquality: "720p",
                    draft: "true",
                    returnLastFrame: "false",
                },
            },
            "video",
        );
        expect(draft720.videoDraft).toBe("false");
        expect(draft720.videoReturnLastFrame).toBe("false");

        const baseChannel = createModelChannel({
            id: "BeefTV",
            name: "BeefTV",
            scope: "system",
            baseUrl: "https://enterprise.beefapi.com/v1",
            models: ["seedance-2.5"],
            modelProfiles: [
                {
                    model: "seedance-2.5",
                    capability: "video",
                    protocol: "newapi",
                    capabilityConfig: {
                        version: 1,
                        video: {
                            operations: ["text_to_video", "image_to_video"],
                            defaultOperation: "text_to_video",
                            duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
                            ratios: ["16:9"],
                            defaultRatio: "16:9",
                            resolutions: ["720p", "1080p"],
                            defaultResolution: "720p",
                            generateAudio: { supported: false, default: false },
                            watermark: { supported: true, default: false },
                            references: {
                                maxImages: 9,
                                maxVideos: 3,
                                maxAudios: 3,
                                maxImageBytes: 30 * 1024 * 1024,
                                maxVideoBytes: 200 * 1024 * 1024,
                                maxAudioBytes: 15 * 1024 * 1024,
                                maxVideoDurationSeconds: 15,
                                maxAudioDurationSeconds: 15,
                            },
                        },
                    },
                },
            ],
        });
        const normalizedConfig = effectiveConfigForCustomChannels({ ...defaultConfig, channels: [baseChannel] }, false);
        const cap = modelCapabilityConfigFor(normalizedConfig, "BeefTV::seedance-2.5");
        expect(cap.video?.draft?.supported).toBe(true);
        expect(cap.video?.returnLastFrame?.supported).toBe(true);
        expect(cap.video?.resolutions.includes("480p")).toBe(true);
        expect(cap.video?.operations.includes("draft_to_final")).toBe(true);
    });

    test("音频参数随模型切换一并清理", () => {
        const node = imageNode({
            model: "default::tts-1",
            audioVoice: "alloy",
            audioFormat: "mp3",
            audioSpeed: "1.25",
            audioInstructions: "温暖、自然",
        });
        const next = applyNodeConfigPatch(node, { model: "default::gpt-4o-mini-tts" });
        expect(next.metadata?.audioVoice).toBeUndefined();
        expect(next.metadata?.audioFormat).toBeUndefined();
        expect(next.metadata?.audioSpeed).toBeUndefined();
        expect(next.metadata?.audioInstructions).toBeUndefined();
    });

    test("同一模型标识的参数调整不受影响", () => {
        const node = imageNode({ model: "default::gpt-image-2", size: "1:1", quality: "high" });
        const next = applyNodeConfigPatch(node, { model: "default::gpt-image-2", quality: "medium" });
        expect(next.metadata?.model).toBe("default::gpt-image-2");
        expect(next.metadata?.quality).toBe("medium");
        expect(next.metadata?.size).toBe("1:1");
    });

    test("非模型 patch（仅调整参数）不触发清理", () => {
        const node = imageNode({ model: "default::gpt-image-2", size: "1:1" });
        const next = applyNodeConfigPatch(node, { size: "16:9" });
        expect(next.metadata?.size).toBe("16:9");
        expect(next.metadata?.model).toBe("default::gpt-image-2");
    });

    test("模型切换时同批显式参数仍优先于清理", () => {
        const node = imageNode({ model: "default::gpt-image-2", size: "1:1", quality: "high" });
        const next = applyNodeConfigPatch(node, { model: "default::grok-imagine-video", size: "16:9" });
        expect(next.metadata?.model).toBe("default::grok-imagine-video");
        expect(next.metadata?.size).toBe("16:9");
        expect(next.metadata?.quality).toBeUndefined();
    });

    test("内容型字段不随模型切换清理", () => {
        const node = imageNode({ model: "default::gpt-image-2", prompt: "一只猫", composerContent: "生成一只猫" });
        const next = applyNodeConfigPatch(node, { model: "default::grok-imagine-video" });
        expect(next.metadata?.prompt).toBe("一只猫");
        expect(next.metadata?.composerContent).toBe("生成一只猫");
    });
});
