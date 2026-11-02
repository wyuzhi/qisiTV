import { expect, test } from "bun:test";
import { videoSettingsConstraints } from "../src/lib/video-settings-constraints";
import { h3AspectConfig, h3Models, h3StyleModels } from "./fixtures/h3-aspect-config";

for (const model of h3Models) {
}

test("H3 base ordinary references retain an independent ratio", () => {
    const config = h3AspectConfig("minimax-h3");
    expect(videoSettingsConstraints(config, { imageCount: 1 }, { videoEditOperation: "reference_to_video" })).toEqual({});
    expect(videoSettingsConstraints(config, { imageCount: 1, videoCount: 1 })).toEqual({});
    expect(videoSettingsConstraints(config, { imageCount: 1, audioCount: 2 })).toEqual({});
});

test("Max and Turbo treat ordinary image inputs as keyframes", () => {
    for (const model of h3Models.slice(1)) expect(videoSettingsConstraints(h3AspectConfig(model), { imageCount: 1 }).ratioLabel).toBe("随首帧图片");
});

test("same-name models on custom endpoints keep their own protocol controls", () => {
    for (const model of h3Models) expect(videoSettingsConstraints(h3AspectConfig(model, "https://custom.example.com"), { imageCount: 1 })).toEqual({});
});

test("switching to Seedance preserves its existing settings constraints", () => {
    const base = h3AspectConfig();
    const h3Video = base.channels[0]!.modelProfiles![0]!.capabilityConfig!.video!;
    const channel = {
        ...base.channels[0]!,
        models: [...base.channels[0]!.models, "seedance-2.5"],
        modelProfiles: [
            ...(base.channels[0]!.modelProfiles || []),
            {
                model: "seedance-2.5",
                capability: "video" as const,
                protocol: "newapi" as const,
                capabilityConfig: { version: 1, video: { ...h3Video, taskTypeConstraints: true } },
                videoCapabilitiesVersion: "fixture-v1",
            },
        ],
    };
    const config = { ...base, channels: [channel], model: "beefapi::seedance-2.5" };
    expect(videoSettingsConstraints(config, { imageCount: 1 }).ratioLabel).toBe("随首帧");
    expect(videoSettingsConstraints(config, { videoCount: 1 }, { videoEditOperation: "inpaint" })).toEqual({ ratioLabel: "随原视频", durationLocked: true });
    expect(videoSettingsConstraints(config, { characterCount: 1 }).ratioLabel).toBeUndefined();
});

test("a character card cover alone does not determine keyframe mode", () => {
    for (const model of h3Models) {
        const config = h3AspectConfig(model);
        expect(videoSettingsConstraints(config, { characterCount: 1 }).ratioLabel).toBeUndefined();
        expect(videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, { videoStartFrameNodeId: "frame" }).ratioLabel).toBeUndefined();
        expect(videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, { videoEndFrameNodeId: "frame" }).ratioLabel).toBeUndefined();
    }
    expect(videoSettingsConstraints(h3AspectConfig(), { characterCount: 1 }).ratioHelp).toContain("多素材参考生成使用所选比例");
});

for (const model of h3Models) {
}

for (const model of h3StyleModels) {
}
