import { expect, test } from "bun:test";
import { canonicalModelProtocol, modelProtocolDefinition, modelProtocolDefinitionFor, type ModelProtocolDefinition } from "../src/lib/model-protocols";
import { createVendorPresetChannel, serviceModelProfile, vendorPresetFor, vendorPresets } from "../src/lib/model-service-presets";
import { createModelChannel } from "../src/stores/use-config-store";

const chat: ModelProtocolDefinition = {
    value: "chat-completion", label: "OpenAI Chat Completions", capability: "text", create: "POST /chat/completions", contentType: "application/json", media: "", enabled: true,
    aliases: ["deepseek-chat", "openrouter-chat"],
    presets: [{ id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com" }, { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api" }],
};
const image: ModelProtocolDefinition = { value: "openai-image", label: "OpenAI Images", capability: "image", create: "POST /v1/images/generations", contentType: "application/json", media: "", enabled: true };
const protocols = [chat, image];

test("a model saved with a retired vendor id shows as the current interface and saves the current id", () => {
    expect(modelProtocolDefinition("deepseek-chat", protocols)?.value).toBe("chat-completion");
    expect(canonicalModelProtocol("deepseek-chat", protocols)).toBe("chat-completion");
    // An id nobody knows is the user's own contract and stays untouched.
    expect(canonicalModelProtocol("my-own-protocol", protocols)).toBe("my-own-protocol");
    const channel = createModelChannel({ id: "ds", baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-flash"], modelProfiles: [{ model: "deepseek-v4-flash", capability: "text", protocol: "deepseek-chat" }] });
    expect(serviceModelProfile(channel, { id: "deepseek-v4-flash" }, protocols)).toMatchObject({ protocol: "chat-completion", capability: "text" });
});

test("an alias only matches the capability it serves", () => {
    expect(modelProtocolDefinitionFor("deepseek-chat", "text", protocols)?.value).toBe("chat-completion");
    expect(modelProtocolDefinitionFor("deepseek-chat", "image", protocols)).toBeUndefined();
});

test("vendor presets come from the interface catalog and preselect the interface", () => {
    const presets = vendorPresets(protocols);
    expect(presets.map((preset) => preset.label)).toEqual(["DeepSeek", "OpenRouter"]);
    const channel = createVendorPresetChannel(presets[1], "or");
    expect(channel).toMatchObject({ id: "or", name: "OpenRouter", baseUrl: "https://openrouter.ai/api", interfaceType: "chat-completion", apiFormat: "openai" });
    expect(vendorPresetFor({ baseUrl: "https://openrouter.ai/api/" }, presets)?.id).toBe("openrouter");
    expect(vendorPresetFor({ baseUrl: "https://example.com/v1" }, presets)).toBeUndefined();
    // A text model added to a preset connection gets the preset's interface without asking.
    expect(serviceModelProfile(channel, { id: "deepseek/deepseek-v4", modelType: "text" }, protocols).protocol).toBe("chat-completion");
    // A disabled interface offers no presets.
    expect(vendorPresets([{ ...chat, enabled: false }])).toEqual([]);
});
