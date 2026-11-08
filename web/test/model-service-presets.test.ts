import { expect, test } from "bun:test";
import { MODEL_SERVICE_PRESETS, createPluginServiceChannel, createServicePresetChannel, ll2ProtocolsAvailable, pluginServices, mergeSavedServiceChannel, presetCatalogFor, serviceConnectionError, serviceModelProfile, servicePresetFor, modelCatalogRequestURL } from "../src/lib/model-service-presets";
import { modelConnectionResultDetail, testChannelModelConnection } from "../src/lib/model-connection-test";
import { applyFetchedChannelModelCatalog, modelConfigChannelStatusLabel } from "../src/pages/settings/channel-settings-pane";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { configWithoutCachedSecrets, createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { defaultProtocolForCapability, modelProtocolDefinition, type ModelProtocolDefinition } from "../src/lib/model-protocols";
import { serviceCredentialGuide } from "../src/lib/service-credentials";
import { toProviderDefinitions } from "../src/services/api/plugin-catalog";
import { currentModelConnectionReceipt, useModelConnectionTests } from "../src/stores/use-model-connection-tests";

const protocols = [
    ["chat-completion", "text"], ["gemini-generate-content", "text"], ["gemini-image", "image"],
    ["volcengine-ark-video", "video"], ["newapi", "video"],
].map(([value, capability]) => ({ value, capability, enabled: true } as ModelProtocolDefinition));

test("BytePlus import selects Ark without changing third-party or saved protocols", () => {
    const item = { id: "dreamina-seedance-2-0-fast-260128" };
    const channel = createModelChannel({ baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3" });
    expect(serviceModelProfile(channel, item, protocols)).toMatchObject({ protocol: "volcengine-ark-video", capabilityConfig: { video: { resolutions: ["480p", "720p"] } } });
    for (const baseUrl of ["https://ark.ap-southeast.bytepluses.com.example.com/api/v3", "https://other.example.com/v1"]) {
        expect(serviceModelProfile({ ...channel, baseUrl }, item, protocols).protocol).toBeUndefined();
    }
    const saved = { model: item.id, capability: "video" as const, protocol: "newapi" as const };
    expect(serviceModelProfile({ ...channel, modelProfiles: [saved] }, item, protocols)).toEqual(saved);
});

test("persisted boolean video options are normalized without turning false back on", () => {
    const channel = createModelChannel({ id: "custom", models: ["seedance-2.0-mini"], modelProfiles: [{ model: "seedance-2.0-mini", capability: "video", protocol: "newapi" }] });
    for (const enabled of [true, false]) {
        const persisted = JSON.parse(JSON.stringify({ ...defaultConfig, channels: [channel], model: "custom::seedance-2.0-mini", videoGenerateAudio: enabled, videoWatermark: false, videoArkPrivateAssetUpload: true }));
        expect(backendProviderConfig(persisted)).toMatchObject({ videoGenerateAudio: String(enabled), videoWatermark: "false", videoArkPrivateAssetUpload: "true" });
    }
});

test("catalog endpoint metadata classifies opaque video names and selects only installed provider contracts", () => {
    const channel = createModelChannel({ baseUrl: "https://video.example.com/v1" });
    const item = { id: "原生不卡人脸-全参2.5", supportedEndpointTypes: ["full-video"] };
    expect(serviceModelProfile(channel, item, protocols).protocol).toBeUndefined();
    const installed = [...protocols, { value: "full-video", capability: "video", enabled: true } as ModelProtocolDefinition];
    const profile = serviceModelProfile(channel, item, installed);
    expect(profile.capability).toBe("video");
    expect(profile.protocol).toBe("full-video");
    for (const id of ["sd-native-full-2.0", "sd-native-full-2.5", "原生不卡人脸-全参2.0", "原生不卡人脸-全参2.5"]) {
        expect(serviceModelProfile(channel, { id }, installed)).toMatchObject({ capability: "video", protocol: undefined });
    }
    expect(serviceModelProfile({ ...channel, baseUrl: "https://other.example" }, { id: "sd-native-full-2.5" }, installed).protocol).not.toBe("full-video");
    expect(profile.capabilityConfig?.video).toMatchObject({ duration: { min: 4, max: 30 }, resolutions: ["480p", "720p"], references: { maxVideos: 10 } });
    expect(serviceModelProfile(channel, { id: "H3-KS", supportedEndpointTypes: ["openai-video"] }, installed).protocol).toBe("newapi");
    expect(serviceModelProfile({ ...channel, baseUrl: "https://other.example" }, item, installed).protocol).toBe("full-video");
    expect(serviceModelProfile(channel, item, installed.map(p => ({ ...p, enabled: false }))).protocol).toBeUndefined();
});

test("test receipts apply only to the exact tested connection and model profile", () => {
    const channel = createModelChannel({ id: "receipt-channel", apiKey: "synthetic-key", modelProfiles: [{ model: "test", capability: "text", protocol: "chat-completion" }] });
    useModelConnectionTests.getState().record(channel, "test", { success: true, detail: "OK" });
    const receipts = useModelConnectionTests.getState().receipts;
    expect(currentModelConnectionReceipt(receipts, channel, "test")?.success).toBe(true);
    expect(currentModelConnectionReceipt(receipts, { ...channel, apiKey: "changed" }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, baseUrl: "https://other.example" }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, referenceAssetOrigin: "https://assets.example.com" }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, headers: [{ name: "X-Key", value: "other" }] }, "test")).toBeUndefined();
    expect(currentModelConnectionReceipt(receipts, { ...channel, modelProfiles: [{ model: "test", capability: "text", protocol: "openai-response" }] }, "test")).toBeUndefined();
});

test("native provider models use installed native adapters and never invent a missing adapter", () => {
    const gemini = createModelChannel({ baseUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini" });
    expect(serviceModelProfile(gemini, { id: "gemini-pro" }, protocols).protocol).toBe("gemini-generate-content");
    expect(serviceModelProfile(gemini, { id: "gemini-image" }, protocols).protocol).toBe("gemini-image");
    expect(serviceModelProfile(gemini, { id: "veo-video" }, protocols).protocol).toBeUndefined();
    const ark = createModelChannel({ baseUrl: "https://ark.cn-beijing.volces.com/api/v3" });
    expect(serviceModelProfile(ark, { id: "endpoint-abc" }, protocols, "video").protocol).toBe("volcengine-ark-video");
    const regionalArk = { ...ark, baseUrl: "https://ark.cn-shanghai.volces.com/api/v3" };
    expect(serviceModelProfile(regionalArk, { id: "endpoint-abc" }, protocols, "video").protocol).toBe("volcengine-ark-video");
    const unrelated = { ...ark, baseUrl: "https://ark.cn-shanghai.volces.com.example.org/api/v3" };
    expect(serviceModelProfile(unrelated, { id: "endpoint-abc" }, protocols, "video").protocol).toBeUndefined();
});

test("external video protocols require an explicit contract and keep user selections", () => {
    const channel = createModelChannel({ baseUrl: "https://www.whatstoken.ai/v1" });
    const installed = [...protocols, { value: "video-generations-json", capability: "video", enabled: true } as ModelProtocolDefinition];
    for (const id of ["seedance-2.5", "sora-2", "veo-video", "opaque"]) {
        expect(serviceModelProfile(channel, { id }, installed, "video").protocol).toBeUndefined();
    }
    expect(serviceModelProfile(channel, { id: "seedance-2.5", supportedEndpointTypes: ["openai"] }, installed).protocol).toBeUndefined();
    expect(serviceModelProfile(channel, { id: "seedance-2.5", supportedEndpointTypes: [" video-generations-json "] }, installed).protocol).toBe("video-generations-json");
    expect(serviceModelProfile(channel, { id: "seedance-2.5", supportedEndpointTypes: ["video-generations-json"] }, protocols).protocol).toBeUndefined();
    const configured = { ...channel, modelProfiles: [{ model: "seedance-2.5", capability: "video" as const, protocol: "volcengine-ark-video" }] };
    expect(serviceModelProfile(configured, { id: "seedance-2.5" }, installed).protocol).toBe("volcengine-ark-video");
    expect(serviceModelProfile({ ...channel, baseUrl: "https://api.openai.com/v1" }, { id: "sora-2" }, installed).protocol).toBe("newapi");
});

test("saving a model inherits an enabled channel protocol of the same capability without mutating its draft", () => {
    const channel = createModelChannel({ baseUrl: "https://video.example.com/v1", interfaceType: "video-generations-json", modelProfiles: [{ model: "seedance-2.5", capability: "video" }] });
    const installed = [...protocols, { value: "video-generations-json", capability: "video", enabled: true } as ModelProtocolDefinition];
    expect(serviceModelProfile(channel, { id: "seedance-2.5" }, installed).protocol).toBe("video-generations-json");
    expect(channel.modelProfiles?.[0]?.protocol).toBeUndefined();
    expect(serviceModelProfile(channel, { id: "seedance-2.5" }, protocols).protocol).toBeUndefined();
    expect(serviceModelProfile(channel, { id: "seedance-2.5" }, installed.map((p) => ({ ...p, enabled: false }))).protocol).toBeUndefined();
    expect(serviceModelProfile({ ...channel, interfaceType: "chat-completion" }, { id: "seedance-2.5" }, installed).protocol).toBeUndefined();
    expect(serviceModelProfile(channel, { id: "sd-native-full-2.5" }, installed).protocol).toBe("video-generations-json");
});

test("refresh keeps selected/manual models and user capability limits", () => {
    const config = defaultModelCapabilityConfig("newapi", "video-manual")!;
    const channel = createModelChannel({ id: "custom", models: ["video-manual"], modelProfiles: [{ model: "video-manual", capability: "video", protocol: "newapi", capabilityConfig: config }] });
    const next = applyFetchedChannelModelCatalog(channel, { models: ["video-manual", "new-model"], catalog: [{ id: "video-manual", modelType: "text" }, { id: "new-model" }] });
    expect(next.models).toEqual(["video-manual"]);
    expect(next.modelProfiles?.find((p) => p.model === "video-manual")).toEqual(channel.modelProfiles![0]);
});

test("a plugin service becomes one provider choice whose listed models use the plugin interface", () => {
    const comfy = { value: "comfyui-app", label: "ComfyUI", capability: "image", enabled: true, module: true, authType: "none", baseUrl: "http://127.0.0.1:8188" } as ModelProtocolDefinition;
    const services = pluginServices([...protocols, comfy, { ...comfy }, { ...comfy, value: "off", enabled: false }]);
    expect(services.map((item) => item.value)).toEqual(["comfyui-app"]);

    const channel = createPluginServiceChannel(comfy, "comfy");
    expect(channel).toMatchObject({ id: "comfy", name: "ComfyUI", baseUrl: "http://127.0.0.1:8188", interfaceType: "comfyui-app" });
    // 本机 ComfyUI 不要密钥：还没选模型时也能直接读取模型。
    expect(serviceConnectionError(channel, { protocols: [comfy] })).toBe("");
    expect(serviceCredentialGuide(channel, [comfy]).apiKeyHelp).toBe("这个服务不用密钥，可以留空。");
    expect(serviceConnectionError(createPluginServiceChannel({ ...comfy, authType: "bearer" }, "keyed"), { protocols: [{ ...comfy, authType: "bearer" }] })).toBe("请填写 API Key");

    expect(serviceModelProfile(channel, { id: "portrait.app.json", modelType: "image" }, [...protocols, comfy])).toMatchObject({ capability: "image", protocol: "comfyui-app" });
});

test("a plugin interface that makes images and videos is one service, and both kinds of model use it", () => {
    const item = { id: "comfyui", version: "0.1.0", name: "ComfyUI", vendor: "ComfyUI", categories: ["image", "video"], scopes: ["user.custom-channel"], enabled: true, module: true, authType: "none", baseUrl: "http://127.0.0.1:8188" };
    expect(toProviderDefinitions(item).map((definition) => `${definition.value}:${definition.capability}`)).toEqual(["comfyui:image", "comfyui:video"]);
    expect(toProviderDefinitions(item, "video").map((definition) => definition.capability)).toEqual(["video"]);
    expect(toProviderDefinitions(item, "audio")).toEqual([]);

    const available = [...protocols, ...toProviderDefinitions(item)];
    const services = pluginServices(available);
    expect(services.map((service) => service.value)).toEqual(["comfyui"]);
    const channel = createPluginServiceChannel(services[0], "comfy");
    expect(serviceModelProfile(channel, { id: "invert.app.json", modelType: "image" }, available)).toMatchObject({ capability: "image", protocol: "comfyui" });
    expect(serviceModelProfile(channel, { id: "clip.json", modelType: "video" }, available)).toMatchObject({ capability: "video", protocol: "comfyui" });
});

test("connection validation rejects full endpoints and embedded credentials", () => {
    const channel = createModelChannel({ baseUrl: "https://api.example.com/v1", apiKey: "synthetic-key" });
    expect(serviceConnectionError(channel)).toBe("");
    expect(modelCatalogRequestURL(channel)).toBe("https://api.example.com/v1/models");
    expect(serviceConnectionError({ ...channel, baseUrl: "https://api.example.com/v1/chat/completions" })).not.toBe("");
    expect(serviceConnectionError({ ...channel, baseUrl: "https://secret@api.example.com" })).not.toBe("");
    expect(serviceConnectionError({ ...channel, referenceAssetOrigin: "https://assets.example.com" })).toBe("");
    expect(serviceConnectionError({ ...channel, referenceAssetOrigin: "http://10.0.0.8:9000" })).toBe("");
    expect(serviceConnectionError({ ...channel, referenceAssetOrigin: "https://assets.example.com:444" })).toBe("");
    for (const referenceAssetOrigin of ["https://assets.example.com/path", "https://user@assets.example.com", "https://assets.example.com?key=value", "http://assets.example.com#sig"]) {
        expect(serviceConnectionError({ ...channel, referenceAssetOrigin })).not.toBe("");
    }
});

test("API key is optional only when every selected protocol auth is none", () => {
    const channel = createModelChannel({ baseUrl: "http://127.0.0.1:11434", apiKey: "", models: ["llama3"], modelProfiles: [{ model: "llama3", capability: "text", protocol: "ollama-chat", authType: "none" }] });
    const ollama = { value: "ollama-chat", capability: "text", enabled: true, authType: "none" } as ModelProtocolDefinition;
    const bearer = { value: "ollama-chat", capability: "text", enabled: true, authType: "bearer" } as ModelProtocolDefinition;
    expect(serviceConnectionError(channel)).toBe("");
    expect(serviceConnectionError(channel, { protocols: [ollama] })).toBe("");
    expect(serviceConnectionError(channel, { protocols: [bearer] })).not.toBe("");
    expect(serviceConnectionError({ ...channel, apiKey: "" }, { requireCredential: false })).toBe("");
    expect(serviceConnectionError(createModelChannel({ baseUrl: "https://api.example.com/v1", apiKey: "" }))).toBe("请填写 API Key");
    expect(serviceConnectionError(createModelChannel({ baseUrl: "https://api.example.com/v1", apiKey: "" }), { requireCredential: false })).toBe("");
    const mixed = createModelChannel({ baseUrl: "http://127.0.0.1:11434", apiKey: "", models: ["llama3", "gpt"], modelProfiles: [{ model: "llama3", capability: "text", protocol: "ollama-chat", authType: "none" }, { model: "gpt", capability: "text", protocol: "chat-completion" }] });
    expect(serviceConnectionError(mixed, { protocols: [ollama, ...protocols] })).toBe("请填写 API Key");
    expect(modelConfigChannelStatusLabel(channel, { status: "saved", revision: 1, dirty: false, error: "" })).toBe("已保存 · 尚未测试");
});

test("explicit asset origin survives channel creation and generation request assembly", () => {
    const channel = createModelChannel({ id: "custom", baseUrl: "https://api.example.com/v1", referenceAssetOrigin: " https://assets.example.com ", models: ["sd-native-full-2.5"], modelProfiles: [{ model: "sd-native-full-2.5", capability: "video", protocol: "full-video" }] });
    const config = { ...defaultConfig, channels: [channel], model: "custom::sd-native-full-2.5" };
    expect(channel.referenceAssetOrigin).toBe("https://assets.example.com");
    expect(backendProviderConfig(config)).toMatchObject({ referenceAssetOrigin: channel.referenceAssetOrigin, interfaceType: "full-video" });
});

test("saved credentials do not imply tested generation and browser cache omits all credential copies", () => {
    const channel = createModelChannel({ id: "manual", apiKey: "synthetic-key", secretKey: "synthetic-secret", headers: [{ name: "X-Key", value: "synthetic-header" }] });
    expect(modelConfigChannelStatusLabel(channel, { status: "saved", revision: 1, dirty: false, error: "" })).toBe("已保存 · 尚未测试");
    const config = { ...defaultConfig, apiKey: "synthetic-root", channels: [channel] };
    expect(JSON.stringify(configWithoutCachedSecrets(config))).not.toContain("synthetic-");
    expect(config.channels[0].apiKey).toBe("synthetic-key");
});

test("generation test uses production config including headers and waits for a final output", async () => {
    const capabilityConfig = defaultModelCapabilityConfig("newapi", "test-video")!;
    capabilityConfig.video!.duration = { selection: "enum", values: [8, 4, 12], default: 8 };
    capabilityConfig.video!.resolutions = ["1080", "720"];
    const channel = createModelChannel({ id: "manual", apiKey: "synthetic-key", models: ["test-video"], headers: [{ name: "X-Project", value: "test-project" }], modelProfiles: [{ model: "test-video", capability: "video", protocol: "newapi", capabilityConfig }] });
    let resolve!: (value: { video: { dataUrl: string; storageKey: string } }) => void;
    const completion = new Promise<{ video: { dataUrl: string; storageKey: string } }>((r) => { resolve = r; });
    let done = false;
    const testResult = testChannelModelConnection(channel, "test-video", "video", "newapi", async (options) => {
        expect(options.config.videoSeconds).toBe("4");
        expect(options.config.vquality).toBe("720");
        const request = backendProviderConfig(options.config);
        expect(request).toMatchObject({ headers: channel.headers, model: "test-video", apiKey: "synthetic-key", interfaceType: "newapi" });
        return completion;
    }).then((value) => { done = true; return value; });
    await Promise.resolve();
    expect(done).toBe(false);
    resolve({ video: { storageKey: "resource:generated", dataUrl: "" } });
    expect(await testResult).toContain("已完成视频生成");
    expect(() => modelConnectionResultDetail({}, "video")).toThrow("没有返回可用结果");
    expect(() => modelConnectionResultDetail({ text: " " }, "text")).toThrow();
});

test("video test uses configured range defaults and ranks K resolutions above ordinary P tiers", async () => {
    const capabilityConfig = defaultModelCapabilityConfig("newapi", "test-video")!;
    capabilityConfig.video!.resolutions = ["2K", "768P"];
    const channel = createModelChannel({ apiKey: "synthetic", modelProfiles: [{ model: "test-video", capability: "video", protocol: "newapi", capabilityConfig }] });
    await testChannelModelConnection(channel, "test-video", "video", "newapi", async ({ config }) => {
        expect(config.videoSeconds).toBe(String(capabilityConfig.video!.duration.default));
        expect(config.videoSeconds).not.toBe("1");
        expect(config.vquality).toBe("768P");
        return { video: { storageKey: "fixture", dataUrl: "" } };
    });
});

test("official OpenAI and Gemini presets stop advertising discontinued video APIs", () => {
    const presets = new Map(MODEL_SERVICE_PRESETS.map((preset) => [preset.id, preset.subtitle]));
    for (const id of ["openai", "gemini"]) {
        const subtitle = presets.get(id as "openai" | "gemini") || "";
        expect(subtitle).toContain("已停用");
        expect(subtitle).not.toMatch(/·\s*(Veo\s*)?视频\s*$/);
    }
    expect(presets.get("compatible")).toContain("中转");
    expect(presets.get("ll2")).toContain("视频");
    expect(presets.get("ark")).toContain("Seedance 视频");
});

test("LL2 service preset resolves all 6 LL2 protocols when plugin is enabled and fails closed when disabled", () => {
    const ll2Protocols = [
        ...protocols,
        ...["ll2-seedance-video", "ll2-vidu-video", "ll2-minimax-video", "ll2-super-vega-video", "ll2-auto-hd-video"].map(
            (value) => ({ value, capability: "video", authType: "bearer", enabled: true } as ModelProtocolDefinition),
        ),
    ];
    expect(ll2ProtocolsAvailable(ll2Protocols)).toBe(true);
    expect(ll2ProtocolsAvailable(protocols)).toBe(false);

    const channel = createServicePresetChannel("ll2", "ll2-test", ll2Protocols);
    const catalog = presetCatalogFor("ll2");
    expect(servicePresetFor(channel)).toBe("ll2");
    expect(channel.name).toBe("LL2 (DMC)");
    expect(channel.baseUrl).toBe("https://api.ll2.cn");
    expect(channel.models).toHaveLength(9);
    expect(catalog).toHaveLength(9);

    const resolvedProtocols = new Set(
        catalog.map((item) => serviceModelProfile(channel, item, ll2Protocols).protocol),
    );
    expect([...resolvedProtocols].sort()).toEqual([
        "chat-completion",
        "ll2-auto-hd-video",
        "ll2-minimax-video",
        "ll2-seedance-video",
        "ll2-super-vega-video",
        "ll2-vidu-video",
    ]);

    // When the LL2 plugin is disabled/missing, video models must not resolve to unavailable ll2-* protocols.
    const withoutPlugin = catalog.map((item) => serviceModelProfile(channel, item, protocols));
    expect(withoutPlugin.find((profile) => profile.capability === "text")?.protocol).toBe("chat-completion");
    for (const videoProfile of withoutPlugin.filter((profile) => profile.capability === "video")) {
        expect(videoProfile.protocol).toBeUndefined();
    }

    // Switching back to another preset clears LL2 preset models.
    const switched = createServicePresetChannel("compatible", "ll2-test", ll2Protocols);
    expect(switched.models).toEqual([]);
    expect(presetCatalogFor("compatible")).toEqual([]);
});

test("mergeSavedServiceChannel prioritizes exact channel id, collapses duplicate LL2 channels, and remaps model selections", () => {
    const ch1 = createModelChannel({ id: "ll2-first", name: "LL2 (DMC)", baseUrl: "https://api.ll2.cn", apiKey: "k1", models: ["deepseek-v4.1-flash"] });
    const ch2 = createModelChannel({ id: "ll2-second", name: "LL2 (DMC) #2", baseUrl: "https://api.ll2.cn", apiKey: "k2", models: ["viduq3-pro"] });
    const latest = {
        ...defaultConfig,
        channels: [ch1, ch2],
        model: "ll2-first::deepseek-v4.1-flash",
        videoModel: "ll2-second::viduq3-pro",
        assistantModel: "ll2-first::deepseek-v4.1-flash",
        mediaReviewModel: "ll2-second::viduq3-pro",
    };

    // Editing ch2 (exact match on id="ll2-second") keeps "ll2-second", collapses "ll2-first",
    // remaps models supported by ch2, and clears selections not offered by ch2
    const editedCh2 = { ...ch2, models: ["deepseek-v4.1-flash", "viduq3-pro"], apiKey: "k2-updated" };
    const mergedFromEdit = mergeSavedServiceChannel(latest, editedCh2);
    expect(mergedFromEdit.channels).toHaveLength(1);
    expect(mergedFromEdit.channels[0].id).toBe("ll2-second");
    expect(mergedFromEdit.channels[0].apiKey).toBe("k2-updated");
    expect(mergedFromEdit.baseConfig.model).toBe("ll2-second::deepseek-v4.1-flash");
    expect(mergedFromEdit.baseConfig.assistantModel).toBe("ll2-second::deepseek-v4.1-flash");
    expect(mergedFromEdit.baseConfig.videoModel).toBe("ll2-second::viduq3-pro");

    // When the surviving channel does NOT offer the removed channel's model, remapModel clears it instead of pointing to a missing model
    const mergedNarrow = mergeSavedServiceChannel(latest, { ...ch2, models: ["viduq3-pro"] });
    expect(mergedNarrow.baseConfig.assistantModel).toBe("");
    expect(mergedNarrow.baseConfig.videoModel).toBe("ll2-second::viduq3-pro");

    // Adding a brand new LL2 channel (no exact id match) collapses into existing "ll2-first"
    const brandNew = createModelChannel({ id: "ll2-brand-new", name: "LL2 (DMC)", baseUrl: "https://api.ll2.cn", apiKey: "k3", models: ["MiniMax-H3"] });
    const mergedFromNew = mergeSavedServiceChannel({ ...latest, channels: [ch1] }, brandNew);
    expect(mergedFromNew.channels).toHaveLength(1);
    expect(mergedFromNew.channels[0].id).toBe("ll2-first");
    expect(mergedFromNew.channels[0].apiKey).toBe("k3");
});

test("legacy LL2 auto-hd profile upgrades expired testVideoUrl and removes unsupported 720p resolution", () => {
    const ll2Protocols = [
        ...protocols,
        { value: "ll2-auto-hd-video", capability: "video", authType: "bearer", enabled: true } as ModelProtocolDefinition,
    ];
    const legacyChannel = createModelChannel({
        id: "ll2",
        baseUrl: "https://api.ll2.cn",
        models: ["auto-hd"],
        modelProfiles: [
            {
                model: "auto-hd",
                capability: "video",
                protocol: "ll2-auto-hd-video",
                defaultOptions: {
                    testVideoUrl: "https://h3-gz-public-1483601991.cos.ap-guangzhou.myqcloud.com/outputs/expired.mp4",
                },
                capabilityConfig: {
                    version: 1,
                    video: {
                        duration: { selection: "enum", values: [5], default: 5 },
                        ratios: [],
                        defaultRatio: "",
                        resolutions: ["720p", "1080p", "2k", "4k"],
                        defaultResolution: "720p",
                        generateAudio: { supported: false, default: false },
                        watermark: { supported: false, default: false },
                        operations: ["reference_to_video"],
                        defaultOperation: "reference_to_video",
                    },
                },
            },
        ],
    });
    const upgraded = serviceModelProfile(legacyChannel, { id: "auto-hd", modelType: "video" }, ll2Protocols);
    expect(upgraded.defaultOptions?.testVideoUrl).toContain("help-static-aliyun-doc.aliyuncs.com");
    expect(upgraded.capabilityConfig?.video?.resolutions).toEqual(["1080p", "2k", "4k"]);
    expect(upgraded.capabilityConfig?.video?.defaultResolution).toBe("1080p");

    // Non-LL2 channel sharing a model name must not have its resolutions rewritten on config hydration
    const nonLL2Channel = createModelChannel({
        id: "ark-custom",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        models: ["doubao-seedance-2-0"],
        modelProfiles: [
            {
                model: "doubao-seedance-2-0",
                capability: "video",
                protocol: "volcengine-ark-video",
                capabilityConfig: {
                    version: 1,
                    video: {
                        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
                        ratios: ["16:9"],
                        defaultRatio: "16:9",
                        resolutions: ["480p", "720p", "1080p"],
                        defaultResolution: "1080p",
                        generateAudio: { supported: true, default: true },
                        watermark: { supported: true, default: false },
                        operations: ["text_to_video"],
                        defaultOperation: "text_to_video",
                    },
                },
            },
        ],
    });
    const hydrated = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [nonLL2Channel] } }).config;
    expect(hydrated.channels[0].modelProfiles?.[0]?.capabilityConfig?.video?.resolutions).toEqual(["480p", "720p", "1080p"]);
});

test("a retired interface is not offered again but still names a saved choice", () => {
    const item = { id: "old-video", version: "1.0.0", name: "旧视频接口", vendor: "Test", categories: ["video"], scopes: ["user.custom-channel"], enabled: true, retired: true, create: "POST /v1/old" };
    const [definition] = toProviderDefinitions(item);
    expect(definition.enabled).toBe(false);
    expect(defaultProtocolForCapability("video", [definition])).not.toBe("old-video");
    expect(modelProtocolDefinition("old-video", [definition])?.label).toBe("旧视频接口");
});
