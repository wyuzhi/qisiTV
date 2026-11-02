import { describe, expect, test } from "bun:test";

import { imageResponseFormatSelectable, resolveImageResponseFormat, type ImageCapabilityConfig } from "../src/lib/model-capabilities";

function profileWith(responseFormat: ImageCapabilityConfig["responseFormat"]) {
    return { responseFormat } as ImageCapabilityConfig;
}

describe("图片 response_format 取值", () => {
    test("未开启时不发送该参数", () => {
        expect(resolveImageResponseFormat(profileWith({ supported: false, value: "url" }))).toBeNull();
    });

    test("没选过取值时按 b64_json 发送，老渠道行为不变", () => {
        expect(resolveImageResponseFormat(profileWith({ supported: true }))).toBe("b64_json");
    });

    test("选了 url 就发送 url", () => {
        expect(resolveImageResponseFormat(profileWith({ supported: true, value: "url" }))).toBe("url");
    });

    test("只有走通用 OpenAI 图片请求的渠道才允许选 url", () => {
        expect(imageResponseFormatSelectable("openai-image", "third-party-image")).toBe(true);
        expect(imageResponseFormatSelectable("openai-image", "hy-image-v3")).toBe(false);
        expect(imageResponseFormatSelectable("grok-image", "grok-2-image")).toBe(false);
    });

    test("Seedream 走专用请求体，不提供这个选择器", () => {
        expect(imageResponseFormatSelectable("openai-image", "seedream-4-5-251128")).toBe(false);
        expect(imageResponseFormatSelectable("openai-image", "seedream-4-0-250828")).toBe(false);
        expect(imageResponseFormatSelectable("openai-image", "vendor::seedream-5-0-pro-260225")).toBe(false);
    });
});