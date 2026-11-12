import { expect, test } from "bun:test";
import { BeefTVConnectionActions, mergeManagedBeefTVCatalog, modelConfigChannelPresentation, modelConfigChannelStatusLabel, shouldRefreshBeefTVCatalog, withChannels } from "../src/pages/settings/channel-settings-pane";
import { renderToStaticMarkup } from "react-dom/server";
import { createModelChannel, defaultConfig, resolveModelRequestConfig } from "../src/stores/use-config-store";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-generation-config";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import type { CanvasNodeData } from "../src/types/canvas";

test("removing a channel clears its legacy and assistant selections", () => {
    const removed = createModelChannel({ id: "removed", apiKey: "dummy", models: ["chat"], modelProfiles: [{ model: "chat", capability: "text", protocol: "chat-completion" }] });
    const kept = createModelChannel({ id: "kept", apiKey: "dummy", models: ["other"], modelProfiles: [{ model: "other", capability: "text", protocol: "chat-completion" }] });
    const next = withChannels({ ...defaultConfig, channels: [removed, kept], model: "removed::chat", textModel: "removed::chat", assistantModel: "removed::chat" }, [kept]);
    expect(next.model).toBe("kept::other");
    expect(next.textModel).toBe("kept::other");
    expect(next.assistantModel).toBe("");
});

test("connection actions render immediate progress and a retry after network failure", () => {
    const noop = () => {};
    const props = { busy: false, onConnect: noop, onCancel: noop, onRetry: noop, onDisconnect: noop };
    const connecting = renderToStaticMarkup(<BeefTVConnectionActions {...props} connection={{ state: "connecting", hasCredential: false }} />);
    expect(connecting).toContain("正在连接");
    expect(connecting).toContain("disabled");
    expect(connecting).not.toContain("重新连接");
    const failed = renderToStaticMarkup(<BeefTVConnectionActions {...props} connection={{ state: "connection_error", hasCredential: false }} />);
    expect(failed).toContain("重新连接");
    expect(failed).not.toContain("disabled");
    const disconnected = renderToStaticMarkup(<BeefTVConnectionActions {...props} connection={null} />);
    expect(disconnected).toContain("连接 Topaz 算力");
    const connected = renderToStaticMarkup(<BeefTVConnectionActions {...props} connection={{ state: "connected", hasCredential: true }} />);
    expect(connected).toContain("断开连接");
    expect(connected).not.toContain("账户");
    expect(connected).not.toContain("充值");
});

test("pinned BeefTV is visible and cannot be deleted before models are fetched", () => {
    const channel = createModelChannel({
        id: "beeftv",
        name: "BeefTV",
        baseUrl: "https://beeftv.app",
        apiKey: "",
        models: [],
        pinned: true,
        presetVersion: 1,
    });
    expect(modelConfigChannelPresentation(channel)).toEqual({ builtin: true, deletable: false, adapterLabel: "应用内置适配" });
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 0, dirty: false, error: "" })).toBe("未连接");
});

test("BeefTV status copy reflects enterprise connection state", () => {
    const channel = createModelChannel({ id: "beeftv", apiKey: "", pinned: true, presetVersion: 1 });
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 1, dirty: false, error: "" }, { state: "pending", userCode: "ABCD-EFGH", hasCredential: false })).toBe("请在浏览器中确认 ABCD-EFGH");
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 2, dirty: false, error: "" }, { state: "connected", account: { id: "acct-1", display_name: "Ender" }, hasCredential: true })).toBe("已连接 Ender");
    expect(modelConfigChannelStatusLabel(channel, { status: "idle", revision: 2, dirty: false, error: "" }, { state: "revoked", hasCredential: true })).toBe("连接已失效，请重新连接");
});

test("BeefTV connected transition refreshes the managed catalog", () => {
    expect(shouldRefreshBeefTVCatalog("pending", "connected")).toBe(true);
    expect(shouldRefreshBeefTVCatalog(undefined, "connected")).toBe(true);
    expect(shouldRefreshBeefTVCatalog("connected", "connected")).toBe(false);
    expect(shouldRefreshBeefTVCatalog("connected", "disconnected")).toBe(true);
    expect(shouldRefreshBeefTVCatalog("catalog_failed", "disconnected")).toBe(true);
    expect(shouldRefreshBeefTVCatalog("pending", "pending")).toBe(false);
    expect(shouldRefreshBeefTVCatalog(undefined, "disconnected")).toBe(false);
});

test("BeefTV catalog merge keeps manual providers and user-owned BeefTV fields", () => {
    const current = {
        ...defaultConfig,
        imageModel: "manual::local-image",
        channels: [
            createModelChannel({
                id: "beeftv",
                name: "BeefTV",
                pinned: true,
                enabled: false,
                models: ["stale-image"],
                modelProfiles: [{ model: "stale-image", capability: "image" }],
            }),
            createModelChannel({ id: "manual", name: "工作室渠道", apiKey: "manual-key", models: ["local-image"], modelProfiles: [{ model: "local-image", capability: "image" }] }),
        ],
    };
    const server = {
        ...defaultConfig,
        channels: [
            createModelChannel({
                id: "beeftv",
                name: "BeefTV",
                pinned: true,
                credentialRef: "beeftv",
                hasApiKey: true,
                models: ["enterprise-image"],
                modelProfiles: [{ model: "enterprise-image", capability: "image", protocol: "openai-image" }],
            }),
            createModelChannel({ id: "manual", name: "旧名称", apiKey: "old-key", models: ["old-image"] }),
        ],
    };
    const merged = mergeManagedBeefTVCatalog(current, server);
    const beef = merged.channels.find((channel) => channel.id === "beeftv");
    const manual = merged.channels.find((channel) => channel.id === "manual");
    expect(beef?.models).toEqual(["enterprise-image"]);
    expect(beef?.modelProfiles?.[0]?.protocol).toBe("openai-image");
    expect(beef?.credentialRef).toBe("beeftv");
    expect(beef?.enabled).toBe(false);
    expect(beef?.apiKey).toBe("");
    expect(manual?.name).toBe("工作室渠道");
    expect(manual?.apiKey).toBe("manual-key");
    expect(manual?.models).toEqual(["local-image"]);
    expect(merged.imageModel).toBe("manual::local-image");
});

// 升级前存的官方服务叫 beefapi。重连后旧服务从设置里去掉；老画布节点里的 beefapi::模型
// 要按现在的官方服务生成，不能落到全局默认（可能是用户自己的服务，会扣别家的费）。
test("after reconnecting, old canvas nodes generate with the new official service", () => {
    const oldOfficial = createModelChannel({ id: "beefapi", name: "BeefTV", pinned: true, credentialRef: "beefapi-enterprise", models: ["seedream-x"] });
    const own = createModelChannel({ id: "channel-2", name: "我的服务", apiKey: "k", baseUrl: "https://own.example.com", models: ["own-image"], modelProfiles: [{ model: "own-image", capability: "image", protocol: "openai-image" }] });
    const current = { ...defaultConfig, channels: [oldOfficial, own], imageModel: "channel-2::own-image" };
    const server = {
        ...defaultConfig,
        channels: [
            createModelChannel({ id: "beeftv", name: "BeefTV", pinned: true, legacyIds: ["beefapi"], credentialRef: "beeftv", hasApiKey: true, models: ["seedream-x"], modelProfiles: [{ model: "seedream-x", capability: "image", protocol: "volcengine-ark-image" }] }),
            createModelChannel({ id: "channel-2", name: "我的服务", baseUrl: "https://own.example.com", models: ["own-image"], modelProfiles: [{ model: "own-image", capability: "image", protocol: "openai-image" }] }),
        ],
    };
    const merged = mergeManagedBeefTVCatalog(current, server);
    expect(merged.channels.map((channel) => channel.id)).toEqual(["beeftv", "channel-2"]);
    const node = { id: "n1", type: "image", title: "首帧", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: "beefapi::seedream-x" } } as unknown as CanvasNodeData;
    const generation = buildGenerationConfig(merged, node, "image");
    const request = resolveModelRequestConfig(generation, generation.model);
    expect(request.model).toBe("seedream-x");
    expect(request.credentialRef).toBe("beeftv");
    expect(request.baseUrl).not.toBe("https://own.example.com");
});

// 旧版存的助手和默认模型是 beefapi::模型。重连去掉旧服务时，它们要换成新官方服务里的同名模型，
// 不能被清空或换成目录第一个模型。
test("reconnecting keeps the assistant and default models saved under the old official service", () => {
    const oldOfficial = createModelChannel({ id: "beefapi", name: "BeefTV", pinned: true, credentialRef: "beefapi-enterprise", models: ["chat-b"] });
    const current = { ...defaultConfig, channels: [oldOfficial], assistantModel: "beefapi::chat-b", textModel: "beefapi::chat-b", model: "beefapi::chat-b" };
    const official = createModelChannel({ id: "beeftv", name: "BeefTV", pinned: true, legacyIds: ["beefapi"], credentialRef: "beeftv", hasApiKey: true, models: ["chat-a", "chat-b"], modelProfiles: [{ model: "chat-a", capability: "text", protocol: "chat-completion" }, { model: "chat-b", capability: "text", protocol: "chat-completion" }] });
    const merged = mergeManagedBeefTVCatalog(current, { ...defaultConfig, channels: [official] });
    expect(merged.assistantModel).toBe("beeftv::chat-b");
    expect(merged.textModel).toBe("beeftv::chat-b");
    expect(merged.model).toBe("beeftv::chat-b");
});


// 能力判断也要按服务现在的条目读：别的服务排在前面、有同名模型时，旧引用仍读官方服务的能力。
test("capabilities of an old official model reference come from the official service", () => {
    const withMaxImages = (maxImages: number) => {
        const capabilityConfig = defaultModelCapabilityConfig("openai-image", "shared-image");
        capabilityConfig.image!.references.maxImages = maxImages;
        return { model: "shared-image", capability: "image" as const, protocol: "openai-image", capabilityConfig, imageCapabilitiesVersion: "test-1" };
    };
    const own = createModelChannel({ id: "channel-2", name: "我的服务", apiKey: "k", models: ["shared-image"], modelProfiles: [withMaxImages(0)] });
    const official = createModelChannel({ id: "beeftv", name: "BeefTV", pinned: true, legacyIds: ["beefapi"], credentialRef: "beeftv", hasApiKey: true, models: ["shared-image"], modelProfiles: [withMaxImages(8)] });
    const config = { ...defaultConfig, channels: [own, official] };
    expect(modelCapabilityConfigFor(config, "beefapi::shared-image").image?.references.maxImages).toBe(8);
    expect(modelCapabilityConfigFor(config, "channel-2::shared-image").image?.references.maxImages).toBe(0);
});
