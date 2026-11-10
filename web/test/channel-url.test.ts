import { describe, expect, test } from "bun:test";
import { buildApiUrl, joinChannelUrl } from "../src/lib/channel-url";

// 期望值取自 backend/internal/channelurl 的 Join(base, path, "/v1")：
// 浏览器直连渠道和后台生成任务必须拼出同一个地址。
const parityCases: Array<[base: string, path: string, expected: string]> = [
    ["https://host", "/v1/chat/completions", "https://host/v1/chat/completions"],
    ["https://host/api/v1", "/v1/chat/completions", "https://host/v1/chat/completions"],
    ["https://host/api/v3", "/api/v3/images/generations", "https://host/api/v3/images/generations"],
    ["https://api.openai.com", "/v1/chat/completions", "https://api.openai.com/v1/chat/completions"],
    ["https://api.openai.com/v1", "/v1/models", "https://api.openai.com/v1/models"],
    ["https://host/v1", "/models", "https://host/v1/models"],
    ["https://host/api/v1", "/api/v3/chat/completions", "https://host/api/v3/chat/completions"],
    ["https://host/v1beta", "/v1beta/models/x:generateContent", "https://host/v1beta/models/x:generateContent"],
    ["https://host/api/plan/v3", "/api/plan/v3/chat/completions", "https://host/api/plan/v3/chat/completions"],
    ["https://host/v1/query/foo", "/v1/query/foo", "https://host/v1/query/foo"],
    ["https://host/openai/v1", "/v1/images/generations", "https://host/openai/v1/images/generations"],
];

describe("joinChannelUrl 与后端 channelurl.Join 一致", () => {
    for (const [base, path, expected] of parityCases) {
        test(`${base} + ${path}`, () => {
            expect(joinChannelUrl(base, path, "/v1")).toBe(expected);
        });
    }
});

describe("buildApiUrl", () => {
    test("系统代理渠道直接拼相对路径", () => {
        expect(buildApiUrl("/api/ai/system/channel-1", "/models")).toBe("/api/ai/system/channel-1/models");
    });

    test("普通渠道走同一套版本前缀规则", () => {
        expect(buildApiUrl("https://host/api/v1/", "/v1/chat/completions")).toBe("https://host/v1/chat/completions");
    });
});
