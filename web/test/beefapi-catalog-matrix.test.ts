import { expect, test } from "bun:test";
import { managedVideoCatalogItem } from "./managed-video-fixture";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import catalog from "../../fixtures/model-catalog/beefapi-20261013.json";
import { mergeFetchedChannelModelProfiles } from "../src/lib/channel-model-catalog";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "../src/stores/use-config-store";

test("the fetched BeefAPI catalog routes every generation family after refresh and reload", () => {
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://beeftv.app", models: catalog.map(m => m.id) });
    const fetched = catalog.map(m => {
        try { return managedVideoCatalogItem(m.id); } catch { return { id: m.id, supportedEndpointTypes: m.supported_endpoint_types }; }
    });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [{ ...channel, modelProfiles: mergeFetchedChannelModelProfiles(channel, fetched) }] } }).config;
    expect(catalog).toHaveLength(47);
    const profiles = config.channels[0]!.modelProfiles!;
    for (const item of catalog) {
        if (item.id === "hy-asr-3.0-preview") { expect(profiles.find(p => p.model === item.id)).toBeUndefined(); continue; }
        const capability = item.id.includes("image") ? "image" : /speech|music/.test(item.id) ? "audio" : /video|seedance|minimax-h3/.test(item.id) ? "video" : "text";
        const profile = profiles.find(p => p.model === item.id)!;
        if (capability === "video" && !profile?.videoCapabilitiesVersion) {
            if (profile?.capability === "video") expect(modelCapabilityConfigFor(config, `beefapi::${item.id}`).videoCapabilitiesUnavailable).toBeUndefined();
            continue;
        }
        expect(profile.capability).toBe(capability);
        expect(resolveModelRequestConfig(config, `beefapi::${item.id}`).interfaceType).toBe(profile.protocol);
    }
});

test("hosted Kling uses server resolutions and duration controls", () => {
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://beeftv.app", models: ["kling-video-v3"] });
    channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [managedVideoCatalogItem("kling-video-v3")]);
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
    const video = config.channels[0]!.modelProfiles![0]!.capabilityConfig!.video!;
    expect(video.resolutions).toEqual(["720p"]);
    expect(video.duration.min).toBe(3);
    expect(video.duration.default).toBe(5);
    expect(video.ratios).toEqual(["16:9", "9:16", "1:1"]);
});
