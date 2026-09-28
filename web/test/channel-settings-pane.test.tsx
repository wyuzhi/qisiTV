import { expect, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelSettingsPane, channelValidationError, modelConfigChannelStatusLabel, withUpdatedLikeAIChannel } from "../src/pages/settings/channel-settings-pane";
import { fetchPluginProviderCatalog } from "../src/services/api/plugin-catalog";
import { createModelChannel, defaultConfig, likeAIWorkspaceConfig, LIKEAI_BASE_URL, selectableModelsByCapability, useConfigStore } from "../src/stores/use-config-store";

const idle = { status: "idle" as const, revision: 0, dirty: false, error: "" };

test("an empty workspace offers LikeAI without requiring credentials to open the canvas", () => {
    const active = likeAIWorkspaceConfig(defaultConfig);
    expect(active.channels).toHaveLength(1);
    expect(active.channels[0]).toMatchObject({ apiFormat: "likeai", name: "LikeAI", baseUrl: LIKEAI_BASE_URL, apiKey: "", models: [] });
    expect(modelConfigChannelStatusLabel(active.channels[0], idle)).toBe("待填写 API Key");
    expect(defaultConfig.channels).toEqual([]);
});

test("legacy provider imports cannot become selectable models and their stored records survive", () => {
    const old = createModelChannel({ id: "beefapi", pinned: true, models: ["seedance-old"], apiKey: "old-key" });
    const likeai = createModelChannel({ id: "likeai", apiFormat: "likeai", apiKey: "local-key", models: ["doubao_seedance_2_5"] });
    const config = { ...defaultConfig, channels: [old, likeai], videoModel: "beefapi::seedance-old" };
    const active = likeAIWorkspaceConfig(config);
    expect(active.channels.map((channel) => channel.id)).toEqual(["likeai"]);
    expect(selectableModelsByCapability(active, "video")).toEqual(["likeai::doubao_seedance_2_5"]);
    expect(active.videoModel).toBe("likeai::doubao_seedance_2_5");
    expect(config.channels[0]).toBe(old);
    expect(config.channels[0].apiKey).toBe("old-key");
});

test("LikeAI profile projection repairs imported non-LikeAI protocols", () => {
    const channel = createModelChannel({ id: "likeai", apiFormat: "likeai", models: ["video-one"], modelProfiles: [{ model: "video-one", capability: "video", protocol: "newapi" }] });
    expect(likeAIWorkspaceConfig({ ...defaultConfig, channels: [channel] }).channels[0].modelProfiles?.[0].protocol).toBe("likeai-video");
    expect(channel.modelProfiles?.[0].protocol).toBe("newapi");
});

test("editing LikeAI retains other provider records without exposing their models", () => {
    const old = createModelChannel({ id: "legacy", models: ["gpt-image-2"], apiKey: "old-key" });
    const config = { ...defaultConfig, channels: [old], imageModel: "legacy::gpt-image-2" };
    const channel = createModelChannel({ id: "likeai", apiFormat: "likeai", apiKey: "new-key", models: ["doubao_seedream_5_pro"] });
    const next = withUpdatedLikeAIChannel(config, channel);
    expect(next.channels.find((item) => item.id === "legacy")?.apiKey).toBe("old-key");
    expect(next.models).toEqual(["likeai::doubao_seedream_5_pro"]);
    expect(next.imageModel).toBe("likeai::doubao_seedream_5_pro");
});

test("LikeAI credentials can only be submitted to its documented API host", () => {
    const channel = createModelChannel({ apiFormat: "likeai", apiKey: "key", models: ["model"] });
    expect(channelValidationError(channel)).toBe("");
    expect(channelValidationError({ ...channel, baseUrl: "https://example.test/task-api" })).toContain("https://task.likeai.pro/task-api");
    expect(channelValidationError({ ...channel, baseUrl: "https://task.likeai.pro@evil.test/task-api" })).not.toBe("");
    expect(channelValidationError({ ...channel, apiFormat: "openai" })).toContain("仅支持 LikeAI");
    const imported = { ...channel, baseUrl: "https://example.test/task-api" };
    expect(likeAIWorkspaceConfig({ ...defaultConfig, channels: [imported] }).channels[0].baseUrl).toBe(LIKEAI_BASE_URL);
    expect(imported.baseUrl).toBe("https://example.test/task-api");
});

test("LikeAI status reflects local model readiness and failed persistence", () => {
    const channel = createModelChannel({ apiFormat: "likeai", apiKey: "key" });
    expect(modelConfigChannelStatusLabel(channel, idle)).toBe("待拉取模型");
    expect(modelConfigChannelStatusLabel({ ...channel, models: ["model"] }, { ...idle, status: "saved" })).toBe("已保存");
    expect(modelConfigChannelStatusLabel(channel, { ...idle, status: "error" })).toBe("保存失败");
});

test("settings rendering exposes LikeAI and no legacy provider or account actions", () => {
    const original = useConfigStore.getState().config;
    try {
        useConfigStore.setState({ config: { ...defaultConfig, channels: [createModelChannel({ id: "beefapi", name: "BeefAPI", pinned: true })] } });
        const html = renderToStaticMarkup(<App><ChannelSettingsPane /></App>);
        expect(html).toContain("LikeAI API Key");
        expect(html).toContain(LIKEAI_BASE_URL);
        expect(html).toContain('readOnly=""');
        for (const removed of ["BeefAPI", "RunningHub", "OpenAI", "Gemini", "企业钱包", "新增渠道"]) expect(html).not.toContain(removed);
    } finally {
        useConfigStore.setState({ config: original });
    }
});

test("the local model editor offers only LikeAI protocols without a server catalog", async () => {
    expect((await fetchPluginProviderCatalog("user.custom-channel")).map((item) => item.value)).toEqual(["likeai-text", "likeai-image", "likeai-video", "likeai-audio"]);
    expect((await fetchPluginProviderCatalog("user.custom-channel", "video")).map((item) => item.value)).toEqual(["likeai-video"]);
});
