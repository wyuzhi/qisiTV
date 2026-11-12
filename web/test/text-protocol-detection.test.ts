import { expect, test } from "bun:test";

import type { ModelProtocolDefinition } from "../src/lib/model-protocols";
import { testChannelModelConnection } from "../src/lib/model-connection-test";
import { channelWithTextProtocol, textProtocolCandidates } from "../src/pages/settings/text-protocol-detection";
import { createModelChannel, resolveModelRequestConfig, type AiConfig } from "../src/stores/use-config-store";

const definition = (value: string, capability: ModelProtocolDefinition["capability"], enabled = true): ModelProtocolDefinition => ({
    value, label: value, capability, create: "POST /x", contentType: "application/json", media: "", enabled,
});

test("detection tries the format in use first, only enabled text formats, and at most four requests", () => {
    const protocols = [
        definition("chat-completion", "text"),
        definition("openai-response", "text"),
        definition("image-format", "image"),
        definition("messages-format", "text"),
        definition("retired-format", "text", false),
        definition("plugin-a", "text"),
        definition("plugin-b", "text"),
    ];
    expect(textProtocolCandidates(protocols, "openai-response").map((item) => item.value)).toEqual(["openai-response", "chat-completion", "messages-format", "plugin-a"]);
});

test("a single text format leaves nothing to choose between", () => {
    expect(textProtocolCandidates([definition("chat-completion", "text"), definition("image-format", "image")], "chat-completion")).toHaveLength(1);
});

test("each detection run sends the candidate format, even on a Gemini-format channel whose model has none", async () => {
    const channel = createModelChannel({ id: "gemini-gateway", baseUrl: "https://gateway.example.com", apiKey: "dummy", apiFormat: "gemini", models: ["chat-model"] });
    const sent: Array<string | undefined> = [];
    const runTask = async (input: { config: AiConfig }) => {
        sent.push(resolveModelRequestConfig(input.config, input.config.textModel).interfaceType);
        return { text: "OK" };
    };
    for (const protocol of ["chat-completion", "openai-response"]) {
        await testChannelModelConnection(channelWithTextProtocol(channel, "chat-model", protocol), "chat-model", "text", protocol, runTask as never);
    }
    expect(sent).toEqual(["chat-completion", "openai-response"]);
});
