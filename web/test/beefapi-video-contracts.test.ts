import { expect, test } from "bun:test";
import { managedVideoCatalogItem } from "./managed-video-fixture";
import { mergeFetchedChannelModelProfiles } from "../src/lib/channel-model-catalog";
import { beefAPIVideoContract, isBeefAPIEndpoint } from "../src/lib/beefapi-video-contracts";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-generation-config";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { backendProviderConfig } from "../src/services/api/generation-task";

test("Kling server capability preserves profile defaults and explicit canvas audio choices through task config", () => {
    const model = "kling-video-v3";
    for (const audioDefault of [false, true]) {
        const capabilityConfig = { version: 1, video: structuredClone(managedVideoCatalogItem(model).videoCapabilities!) };
        capabilityConfig.video!.generateAudio = { supported: true, default: audioDefault };
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://beeftv.app", models: [model], modelProfiles: [{ model, capability: "video", protocol: "openai-videos", capabilityConfig, videoCapabilitiesVersion: "fixture-v1" }] });
        const snapshot = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], videoModel: `beefapi::${model}`, videoGenerateAudio: String(!audioDefault) } }).config;
        expect(modelCapabilityConfigFor(snapshot, `beefapi::${model}`).video!.generateAudio).toEqual({ supported: true, default: audioDefault });
        for (const selected of [undefined, "false", "true"] as const) {
            const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "fixture", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { model: `beefapi::${model}`, generateAudio: selected } };
            const config = resolveModelRequestConfig(buildGenerationConfig(snapshot, node, "video"), `beefapi::${model}`);
            const expected = selected === undefined ? audioDefault : selected === "true";
            expect(config.videoGenerateAudio).toBe(String(expected));
            expect(backendProviderConfig(config, "video")).toMatchObject({ videoGenerateAudio: String(expected), videoSeconds: "5", model });
        }
    }
});

test("Wan uses shared protocol and supported reference limits across reloads", () => {
    const model = "wan3.0-video";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "openai-videos"}]});
    channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [managedVideoCatalogItem(model)]);
    let config = {...defaultConfig, channels: [channel]};
    for (let i = 0; i < 2; i++) {
        config = normalizeConfigSnapshot({config}).config;
        expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("openai-videos");
        const refs = modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references;
        expect([refs.maxImages, refs.maxVideos, refs.maxAudios]).toEqual([10, 5, 5]);
    }
});

test("new models preserve their catalog protocol without inheriting unverified inline support", () => {
    const model = "future-video";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "minimax-video"}]});
    const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
    expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("minimax-video");
    expect(beefAPIVideoContract(model)).toBeUndefined();
    expect(beefAPIVideoContract("wan3.0-video-prime")).toBeUndefined();
});

test("refresh replaces stale text profiles with the server-declared video protocol", () => {
    for (const model of ["future-video-model", "seedance-2.0-fast"]) {
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{ model, capability: "text", protocol: "chat-completion" }] });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [managedVideoCatalogItem(model)]);
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
        expect(config.channels[0]!.modelProfiles![0]).toMatchObject({ capability: "video", protocol: "openai-videos" });
        expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("openai-videos");
    }
});

test("media contract overrides require the exact enterprise HTTPS endpoint", () => {
    for (const base of ["https://enterprise.beefapi.com.evil.test", "https://evil.test/enterprise.beefapi.com", "http://enterprise.beefapi.com", "https://user@enterprise.beefapi.com", "https://enterprise.beefapi.com:444"]) expect(isBeefAPIEndpoint(base)).toBe(false);
    expect(isBeefAPIEndpoint("https://enterprise.beefapi.com/v1")).toBe(true);
});

test("BYOK partial reference contracts preserve the limits of unspecified media kinds", () => {
    const model = "wan3.0-video";
    const contract = beefAPIVideoContract(model)!;
    const original = contract.maxReferences;
    try {
        contract.maxReferences = {image: 1};
        const capabilityConfig = defaultModelCapabilityConfig("newapi-channel-2", model);
        Object.assign(capabilityConfig.video!.references, {maxImages: 4, maxVideos: 2, maxAudios: 1});
        const channel = createModelChannel({id: "byok", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "newapi-channel-2", capabilityConfig}]});
        const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
        const refs = modelCapabilityConfigFor(config, `byok::${model}`).video!.references;
        expect([refs.maxImages, refs.maxVideos, refs.maxAudios]).toEqual([1, 2, 1]);
    } finally { contract.maxReferences = original; }
});

test("custom channel profiles take their capability from the configured protocol", () => {
    const channel = createModelChannel({id: "studio", baseUrl: "https://api.example.com", apiKey: "synthetic-key", models: ["clip-x"], modelProfiles: [{model: "clip-x", capability: "text", protocol: "newapi-channel-2"}]});
    const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
    const profile = config.channels[0]!.modelProfiles!.find((item) => item.model === "clip-x")!;
    expect(profile).toMatchObject({capability: "video", protocol: "newapi-channel-2"});
});
