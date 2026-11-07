import { expect, test } from "bun:test";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor, type ModelCapabilityConfig } from "../src/lib/model-capabilities";
import { http } from "../src/services/api/request";
import { normalizeModelCapabilityDraft } from "../src/services/api/workspace";

const image = (id: string) => ({ id, name: id, type: "image/png", dataUrl: "", width: 512, height: 512 });
const audio = (id: string) => ({ id, name: id, type: "audio/mpeg", url: `https://example.com/${id}.mp3`, durationMs: 3000 });

function backendTightenedProfile(model: string, mutate: (config: ModelCapabilityConfig) => void, baseUrl = "https://beeftv.app", protocol: "newapi" | "volcengine-ark-video" = "newapi") {
    const capabilityConfig = defaultModelCapabilityConfig(protocol, model);
    capabilityConfig.video!.operations = ["text_to_video", "image_to_video", "reference_to_video"];
    capabilityConfig.video!.references.maxVideos = 3;
    capabilityConfig.video!.references.maxAudios = 3;
    capabilityConfig.video!.references.minVideoDurationSeconds = 2;
    capabilityConfig.video!.references.minAudioDurationSeconds = 2;
    mutate(capabilityConfig);
    const channel = { id: "test", models: [model], baseUrl, modelProfiles: [{ model, protocol, capability: "video" as const, capabilityConfig }] };
    return modelCapabilityConfigFor({ channels: [channel] }, `test::${model}`).video!;
}

test("normalizeModelCapabilityDraft 请求后端能力规范化接口并返回收紧后的 capabilityConfig", async () => {
    const originalPost = http.post;
    let capturedUrl = "";
    let capturedBody: unknown = null;
    const backendReturned: ModelCapabilityConfig = {
        ...defaultModelCapabilityConfig("newapi", "seedance-2.0"),
        video: {
            ...defaultModelCapabilityConfig("newapi", "seedance-2.0").video!,
            taskTypeConstraints: false,
            duration: { selection: "enum", values: [-1, 4, 5], default: 5 },
            references: {
                ...defaultModelCapabilityConfig("newapi", "seedance-2.0").video!.references,
                minVideoDurationSeconds: 2,
                minAudioDurationSeconds: 2,
                minVideoPixels: 409600,
                maxVideoPixels: 927408,
            },
        },
    };
    http.post = (async (url: string, data?: unknown) => {
        capturedUrl = url;
        capturedBody = data;
        return { capabilityConfig: backendReturned };
    }) as typeof http.post;

    try {
        const result = await normalizeModelCapabilityDraft({
            channelId: "beeftv",
            baseUrl: "https://beeftv.app",
            capability: "video",
            protocol: "newapi",
            model: "seedance-2.0",
        });
        expect(capturedUrl).toBe("/workspace/model-config/capability");
        expect(capturedBody).toEqual({
            channelId: "beeftv",
            baseUrl: "https://beeftv.app",
            capability: "video",
            protocol: "newapi",
            model: "seedance-2.0",
        });
        expect(result.capabilityConfig?.video?.duration.values).toEqual([-1, 4, 5]);
        expect(result.capabilityConfig?.video?.references.minAudioDurationSeconds).toBe(2);
    } finally {
        http.post = originalPost;
    }
});

