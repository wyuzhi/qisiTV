import assert from "node:assert/strict";
import test from "node:test";

// Bun 直接执行 TypeScript 测试时需要保留扩展名；生产 tsconfig 不包含 test/。
import { DEFAULT_VIDEO_PROMPT_MAX_CHARS, defaultModelCapabilityConfig, modelCapabilityConfigFor, normalizeVideoValue } from "../src/lib/model-capabilities.ts";
import { modelCompatibilityError } from "../src/lib/model-selection.ts";
import type { AiConfig } from "../src/stores/use-config-store.ts";

test("switching to MiniMax H3 replaces an unsupported 720p value with 768P", () => {
    const profile = defaultModelCapabilityConfig("minimax-video", "MiniMax-H3").video!;

    assert.deepEqual(normalizeVideoValue(profile, { seconds: "11", ratio: "16:9", resolution: "720" }), {
        seconds: "11",
        ratio: "16:9",
        resolution: "768P",
    });
});

// 视频提示词由「输入框文本 + 连线内容 + 技能上下文」合成，技能上下文预算为 32000，
// 合成结果远长于用户手输内容。默认上限过小会把正常可用的画布工作流拦在本地预检。
// 这里锁定默认值本身，避免被改回偏小值（前端放行/后端拒绝的判定必须同源）。
test("video prompt default allows a composed canvas prompt", () => {
    assert.equal(DEFAULT_VIDEO_PROMPT_MAX_CHARS, 8000);
    for (const protocol of [undefined, "seedance-videos-compatible", "agnes-video", "volcengine-ark-video"]) {
        const profile = defaultModelCapabilityConfig(protocol, "test-model");
        assert.equal(profile.video!.references.promptMaxChars, DEFAULT_VIDEO_PROMPT_MAX_CHARS);
    }
});

test("raising the video default leaves text and image limits untouched", () => {
    // 只放宽视频默认值，避免顺带改变其它能力的判定口径。
    const profile = defaultModelCapabilityConfig("seedance-videos-compatible", "sd-2.5");
    assert.equal(profile.text!.references.promptMaxChars, 32000);
    assert.equal(profile.image!.references.promptMaxChars, 32000);
});

test("APIMart NewAPI channel exposes Seedance multimodal reference operations", () => {
    const profile = defaultModelCapabilityConfig("newapi-channel-2", "seedance-2.0-fast").video!;
    assert.deepEqual(profile.references.maxVideos, 3);
    assert.ok(profile.operations.includes("reference_to_video"));
    assert.ok(!profile.operations.includes("audio_to_video"));
});

test("BeefAPI generic newapi Seedance accepts mixed image and video references without a persisted capability profile", () => {
    const model = "beefapi::seedance-2.0-fast";
    const config = {
        channels: [{
            id: "beefapi",
            name: "BeefAPI",
            baseUrl: "https://enterprise.beefapi.com",
            apiKey: "test",
            apiFormat: "openai",
            models: ["seedance-2.0-fast"],
            modelProfiles: [{
                model: "seedance-2.0-fast",
                capability: "video",
                protocol: "newapi",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 0,
            }],
        }],
    } as AiConfig;

    const profile = modelCapabilityConfigFor(config, model).video!;
    assert.ok(profile.operations.includes("reference_to_video"));
    assert.ok(profile.references.maxVideos >= 1);
    assert.equal(modelCompatibilityError(config, model, {
        capability: "video",
        input: { textCount: 1, imageCount: 1, videoCount: 1, audioCount: 0, characterCount: 0 },
        videoSeconds: "5",
    }), "");
});
