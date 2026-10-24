import { expect, test } from "bun:test";
import { assistantModelOptions, MANAGED_ASSISTANT_MODELS, resolveAssistantModel } from "@/lib/assistant-model";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { mergeManagedBeefAPICatalog } from "@/pages/settings/channel-settings-pane";

const models = [...MANAGED_ASSISTANT_MODELS, "gpt-6.1-sol", "qwen3.8-flash"];
const channel = createModelChannel({ id: "beefapi", pinned: true, models, modelProfiles: models.map(model => ({ model, capability: "text", protocol: "chat-completion" })) });
const config = { ...defaultConfig, channels: [channel], textModel: "beefapi::qwen3.8-flash" };

test("assistant follows a custom default text model without modelProfiles", () => {
    const custom = createModelChannel({ id: "newapi-local", apiFormat: "openai", models: ["deepseek-v4-flash:free", "unclassified-model"] });
    for (const textModel of ["deepseek-v4-flash:free", "newapi-local::deepseek-v4-flash:free"]) {
        const c = { ...defaultConfig, channels: [custom], textModel };
        expect(assistantModelOptions(c)).toEqual(["newapi-local::deepseek-v4-flash:free"]);
        expect(resolveAssistantModel(c)).toBe("newapi-local::deepseek-v4-flash:free");
        expect(resolveAssistantModel({ ...c, assistantModel: "newapi-local::unclassified-model" })).toBe("");
    }
});

test("models-only fallback keeps channel and explicit profile restrictions", () => {
    const custom = createModelChannel({ id: "custom", models: ["local-text"] });
    const c = { ...defaultConfig, channels: [custom], textModel: "custom::local-text" };
    for (const update of [
        { enabled: false }, { scope: "system" as const }, { pinned: true }, { credentialRef: "managed" },
        { apiFormat: "gemini" as const }, { interfaceType: "openai-image" },
        { modelProfiles: [{ model: "local-text", capability: "image" as const, protocol: "openai-image" }] },
        { modelProfiles: [{ model: "local-text", capability: "text" as const, protocol: "unsupported" }] },
    ]) {
        expect(resolveAssistantModel({ ...c, channels: [{ ...custom, ...update }] })).toBe("");
    }
    for (const update of [{ apiFormat: "claude" as const }, { interfaceType: "responses" }]) {
        expect(resolveAssistantModel({ ...c, channels: [{ ...custom, ...update }] })).toBe("custom::local-text");
    }
});

test("managed assistant list is curated and requires actual catalog membership", () => {
    expect(assistantModelOptions(config)).toEqual(MANAGED_ASSISTANT_MODELS.map(m => `beefapi::${m}`));
    expect(assistantModelOptions({ ...config, channels: [{ ...channel, models: models.filter(m => m !== "gpt-6.1-sol") }] })).not.toContain("beefapi::gpt-6.1-sol");
    expect(resolveAssistantModel(config)).toBe("");
    expect(resolveAssistantModel({ ...config, assistantModel: "beefapi::qwen3.8-flash", textModel: "beefapi::gpt-6-astra" })).toBe("");
});

test("custom channels remain unrestricted and explicit missing models do not silently fall back", () => {
    const custom = { ...channel, id: "custom", pinned: false };
    const c = { ...config, channels: [custom], textModel: "custom::qwen3.8-flash" };
    expect(assistantModelOptions(c)).toContain("custom::qwen3.8-flash");
    expect(resolveAssistantModel(c)).toBe("custom::qwen3.8-flash");
    expect(resolveAssistantModel({ ...c, assistantModel: "custom::missing" })).toBe("");
});

test("managed aliases must resolve to an available text profile", () => {
    const alias = { ...channel, models: ["opus-catalog"], modelAliases: { "claude-opus-5-5": "opus-catalog" }, modelProfiles: [{ model: "opus-catalog", capability: "text" as const, protocol: "claude-api" as const }] };
    expect(assistantModelOptions({ ...config, channels: [alias] })).toEqual(["beefapi::opus-catalog"]);
});

test("managed Gemini can follow the default text model without replacing an explicit assistant choice", () => {
    const gemini = { ...config, textModel: "beefapi::gemini-3.8-flash", assistantModel: "" };
    expect(resolveAssistantModel(gemini)).toBe("beefapi::gemini-3.8-flash");
    expect(resolveAssistantModel({ ...gemini, assistantModel: "beefapi::claude-opus-5-5" })).toBe("beefapi::claude-opus-5-5");
    const removed = { ...channel, models: models.filter(model => model !== "gemini-3.8-flash") };
    expect(resolveAssistantModel({ ...gemini, channels: [removed] })).toBe("");
});

test("authorization adopts server default once while ordinary refresh preserves user choice", () => {
    const current = { ...config, assistantModel: "beefapi::claude-opus-5-5" };
    const server = { ...config, assistantModel: "beefapi::gpt-6-astra" };
    expect(mergeManagedBeefAPICatalog(current, server, true).assistantModel).toBe(server.assistantModel);
    expect(mergeManagedBeefAPICatalog(current, server).assistantModel).toBe(current.assistantModel);
});
