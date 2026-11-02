import { expect, test } from "bun:test";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";

import { explainGenerationError } from "../src/lib/generation-error";

test("persisted material duration explanation keeps actionable limits", () => {
    const text = "参考素材时长不符合模型要求。请检查每段参考音频和视频，将不符合要求的素材调整为 1.8–30.2 秒后重新提交。";
    expect(explainGenerationError({ code: "invalid_params", message: text }).action).toContain("1.8–30.2");
});

test("catalog Seedance limits are not overwritten by official defaults", () => {
    const profile = modelCapabilityConfigFor(
        {
            channels: [
                {
                    id: "test",
                    models: ["seedance-2.5"],
                    modelProfiles: [
                        {
                            model: "seedance-2.5",
                            protocol: "newapi-channel-2",
                            capabilityConfig: {
                                version: 1,
                                video: {
                                    references: { promptMaxChars: 8000, minImages: 0, maxImages: 12, maxImageBytes: 1, maxVideos: 4, maxVideoBytes: 1, maxVideoDurationSeconds: 8, maxAudios: 5, maxAudioBytes: 1, maxAudioDurationSeconds: 8 },
                                    duration: { selection: "range", min: 1, max: 15, step: 1, default: 6 },
                                    ratios: ["16:9"],
                                    defaultRatio: "16:9",
                                    resolutions: ["720p"],
                                    defaultResolution: "720p",
                                    generateAudio: { supported: true, default: true },
                                    watermark: { supported: false, default: false },
                                    operations: ["text_to_video", "image_to_video"],
                                    defaultOperation: "text_to_video",
                                },
                            },
                        },
                    ],
                },
            ],
        } as never,
        "test::seedance-2.5",
    ).video!;
    expect(profile.references.maxImages).toBe(12);
    expect(profile.references.maxVideos).toBe(4);
    expect(profile.references.maxAudios).toBe(5);
    expect(profile.operations).not.toContain("audio_to_video");
    expect(profile.operations).not.toContain("reference_to_video");
});

test("enterprise catalog maxImages is not expanded to official 30", () => {
    const profile = modelCapabilityConfigFor(
        {
            channels: [
                {
                    id: "test",
                    models: ["seedance-2.5"],
                    modelProfiles: [
                        {
                            model: "seedance-2.5",
                            protocol: "newapi-channel-2",
                            capabilityConfig: {
                                version: 1,
                                video: {
                                    references: { promptMaxChars: 8000, minImages: 0, maxImages: 9, maxImageBytes: 1, maxVideos: 0, maxVideoBytes: 0, maxVideoDurationSeconds: 0, maxAudios: 0, maxAudioBytes: 0, maxAudioDurationSeconds: 0 },
                                    duration: { selection: "range", min: 1, max: 15, step: 1, default: 6 },
                                    ratios: ["16:9"],
                                    defaultRatio: "16:9",
                                    resolutions: ["720p"],
                                    defaultResolution: "720p",
                                    generateAudio: { supported: true, default: true },
                                    watermark: { supported: false, default: false },
                                    operations: ["text_to_video", "image_to_video"],
                                    defaultOperation: "text_to_video",
                                },
                            },
                        },
                    ],
                },
            ],
        } as never,
        "test::seedance-2.5",
    ).video!;
    expect(profile.references.maxImages).toBe(9);
    expect(profile.references.maxVideos).toBe(0);
    expect(profile.references.maxAudios).toBe(0);
});

test("legacy channel protocol without model profiles still applies Seedance duration limits", () => {
    const profile = modelCapabilityConfigFor({ channels: [{ id: "legacy", interfaceType: "openai", models: ["seedance-2.5"] }] }, "legacy::seedance-2.5").video!;
    expect(profile.references.minAudioDurationSeconds).toBe(2);
    expect(profile.references.maxAudioDurationSeconds).toBe(30);
});
