import { expect, test } from "bun:test";

import { channelTextProtocols } from "../src/pages/settings/use-channel-request-urls";
import { createModelChannel } from "../src/stores/use-config-store";

test("only text models contribute the interface formats whose request addresses are shown", () => {
    const channel = createModelChannel({
        id: "gateway",
        baseUrl: "https://gateway.example.com/api/v3",
        apiKey: "dummy",
        models: ["chat-a", "chat-b", "reasoner", "picture", "unconfigured-chat"],
        modelProfiles: [
            { model: "chat-a", capability: "text", protocol: "chat-completion" },
            { model: "chat-b", capability: "text", protocol: "chat-completion" },
            { model: "reasoner", capability: "text", protocol: "openai-response" },
            { model: "picture", capability: "image", protocol: "openai-image" },
            { model: "unconfigured-chat", capability: "text" },
        ],
    });
    // 同一接口格式只问一次；没写接口格式的文本模型按文本任务的取法落到默认格式。
    expect(channelTextProtocols(channel).sort()).toEqual(["chat-completion", "openai-response"]);
});

test("a model without its own format shows the address of the channel-level format the task will use", () => {
    const channel = createModelChannel({
        id: "responses-gateway",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "dummy",
        interfaceType: "openai-response",
        models: ["chat-model"],
        modelProfiles: [{ model: "chat-model", capability: "text" }],
    });
    expect(channelTextProtocols(channel)).toEqual(["openai-response"]);
});

test("a channel without text models asks for no request address", () => {
    const channel = createModelChannel({
        id: "images",
        baseUrl: "https://gateway.example.com",
        apiKey: "dummy",
        models: ["picture"],
        modelProfiles: [{ model: "picture", capability: "image", protocol: "openai-image" }],
    });
    expect(channelTextProtocols(channel)).toEqual([]);
});
