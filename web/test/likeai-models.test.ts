import { expect, test } from "bun:test";
import { mergeFetchedChannelModelProfiles } from "../src/lib/channel-model-catalog";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { createModelChannel, defaultBaseUrlForApiFormat, normalizeConfigSnapshot, defaultConfig } from "../src/stores/use-config-store";

test("LikeAI dynamically imports model types with their real protocols", () => {
    const channel = createModelChannel({ id: "likeai", apiFormat: "likeai", baseUrl: defaultBaseUrlForApiFormat("likeai"), models: ["unseen_image", "unseen_chat", "doubao_seedance_2_5"] });
    const profiles = mergeFetchedChannelModelProfiles(channel, [
        { id: "unseen_image", modelType: "image", supportedEndpointTypes: ["likeai-image"] },
        { id: "unseen_chat", modelType: "text", supportedEndpointTypes: ["likeai-text"] },
        { id: "doubao_seedance_2_5", modelType: "video", supportedEndpointTypes: ["likeai-video"], defaultParameters: { resolution: "720p", durationSeconds: "5" } },
    ]);
    expect(profiles.map((item) => item.protocol)).toEqual(["likeai-image", "likeai-text", "likeai-video"]);
    expect(profiles[2].capabilityConfig?.video?.duration.values).toContain(-1);
    expect(profiles[2].capabilityConfig?.video?.references.maxImages).toBe(30);
    expect(profiles[2].capabilityConfig?.video?.resolutions).toEqual(["480p", "720p"]);
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [{ ...channel, modelProfiles: profiles }] } });
    expect(config.config.channels.find((item) => item.id === "likeai")?.apiFormat).toBe("likeai");
});

test("LikeAI uses image resolution and disables streaming and unsupported masks", () => {
    const image = defaultModelCapabilityConfig("likeai-image", "doubao_seedream_5_pro").image!;
    expect(image.quality.default).toBe("1440p");
    expect(image.quality.values).toEqual(["720p", "1080p", "1440p"]);
    expect(image.references.maskSupported).toBe(false);
    expect(defaultModelCapabilityConfig("likeai-text").text?.streaming).toBe(false);
    expect(defaultModelCapabilityConfig("likeai-video", "tongyi_wan_video_3_prime").video?.references.maxVideos).toBe(5);
});
