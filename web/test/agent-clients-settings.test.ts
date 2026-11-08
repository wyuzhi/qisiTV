import { describe, expect, test } from "bun:test";

import { assistantModelOptions, normalizeAssistantModel, resolveAssistantModel } from "@/lib/assistant-model";
import { agentClientLastUsedLabel, agentClientModeLabel, agentClientModeSummary, agentClientSetupBlock, agentIntegrationAction, agentIntegrationHint, agentIntegrationStatusLabel } from "@/pages/agents/agent-client-presentation";
import { connectAgentIntegration, createAgentClient, disconnectAgentIntegration, listAgentClients, revokeAgentClient, type AgentIntegration } from "@/services/api/agent-clients";
import { ApiError, apiClient } from "@/services/api/request";
import { createModelChannel, defaultConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

type Recorded = { method?: string; url?: string; data?: unknown };

async function withStubbedApi<T>(envelope: unknown, status: number, run: (recorded: Recorded[]) => Promise<T>) {
    const original = apiClient.request;
    const recorded: Recorded[] = [];
    apiClient.request = (async (config: Recorded) => {
        recorded.push({ method: config.method, url: config.url, data: config.data });
        if (status >= 400) {
            throw { isAxiosError: true, message: `Request failed with status code ${status}`, response: { status, data: envelope, headers: {} } };
        }
        return { data: envelope, status, headers: {} };
    }) as typeof apiClient.request;
    try {
        return await run(recorded);
    } finally {
        apiClient.request = original;
    }
}

describe("外部 Agent 接入 API", () => {
    test("旧版只读连接保持只读提示，新连接使用全部创作工具", () => {
        expect(agentClientModeLabel("read-only")).toBe("旧版只读连接");
        expect(agentClientModeSummary("read-only")).toContain("重新连接");
        expect(agentClientModeLabel("read-write")).toBe("全部创作工具");
    });
    test("列表按信封解包，并同时给出已连接客户端和命令行工具状态", async () => {
        const data = {
            clients: [{ id: "c-1", label: "Codex", kind: "codex", mode: "read-only", createdAt: "2026-09-20T02:00:00Z", lastUsedAt: null }],
            cli: { path: "/Applications/BeefTV.app/Contents/Resources/beeftv", available: true, installCommand: "ln -s /x/beeftv /usr/local/bin/beeftv" },
        };
        await withStubbedApi({ code: 0, data, msg: "ok" }, 200, async (recorded) => {
            await expect(listAgentClients()).resolves.toEqual(data);
            expect(recorded[0]).toMatchObject({ method: "get", url: "/agent-clients" });
        });
    });

    test("创建只提交类型，并解包出一次性接入内容", async () => {
        const data = {
            client: { id: "c-2", label: "Cursor", kind: "cursor", mode: "read-write", createdAt: "2026-09-20T02:00:00Z", lastUsedAt: null },
            token: "secret-token",
            setup: { kind: "cursor", title: "Cursor", json: '{"mcpServers":{}}' },
        };
        await withStubbedApi({ code: 0, data, msg: "ok" }, 200, async (recorded) => {
            await expect(createAgentClient({ kind: "cursor" })).resolves.toEqual(data);
            expect(recorded[0]).toMatchObject({ method: "post", url: "/agent-clients", data: { kind: "cursor" } });
        });
    });

    test("断开对 id 做路径转义，并解包 revoked", async () => {
        await withStubbedApi({ code: 0, data: { revoked: true }, msg: "ok" }, 200, async (recorded) => {
            await expect(revokeAgentClient("c 3/4")).resolves.toEqual({ revoked: true });
            expect(recorded[0]).toMatchObject({ method: "delete", url: "/agent-clients/c%203%2F4" });
        });
    });

    test("后端还没有这个能力时抛出可识别的 404，页面据此显示空态", async () => {
        await withStubbedApi({ code: 40401, data: null, msg: "not found", reason: "not_found" }, 404, async () => {
            const thrown = await listAgentClients().catch((error) => error);
            expect(thrown).toBeInstanceOf(ApiError);
            expect(thrown).toMatchObject({ status: 404, reason: "not_found" });
        });
    });

    test("一键接入只提交类型，断开对类型做路径转义", async () => {
        const integration = { kind: "claude", name: "Claude Code", detected: true, connected: true, skillInstalled: true, needsRetry: false } as const;
        await withStubbedApi({ code: 0, data: { integration }, msg: "ok" }, 200, async (recorded) => {
            await expect(connectAgentIntegration("claude")).resolves.toEqual({ integration });
            await expect(disconnectAgentIntegration("codex")).resolves.toEqual({ integration });
            expect(recorded[0]).toMatchObject({ method: "post", url: "/agent-clients/integrations", data: { kind: "claude" } });
            expect(recorded[1]).toMatchObject({ method: "delete", url: "/agent-clients/integrations/codex" });
        });
    });

    test("列表返回的一键接入状态原样解包", async () => {
        const integrations = [{ kind: "codex", name: "Codex", detected: false, connected: false, skillInstalled: false, needsRetry: false }];
        await withStubbedApi({ code: 0, data: { clients: [], cli: { path: "", available: false, installCommand: "" }, integrations }, msg: "ok" }, 200, async () => {
            const result = await listAgentClients();
            expect(result.integrations).toEqual(integrations);
        });
    });

    test("断开成功后把无法自动移除的说明一并解包", async () => {
        const integration = { kind: "codex", name: "Codex", detected: true, connected: false, skillInstalled: false, needsRetry: false } as const;
        const warning = "BeefTV 已停止接受 Codex 的访问。Codex 里的 BeefTV 连接没能自动移除，可以在它的 MCP 设置里手动删除。";
        await withStubbedApi({ code: 0, data: { integration, warning }, msg: "ok" }, 200, async () => {
            await expect(disconnectAgentIntegration("codex")).resolves.toEqual({ integration, warning });
        });
    });
});

describe("接入内容按客户端类型选命令或配置", () => {
    test("Claude Desktop 使用配置文件而非 Claude Code 命令", () => {
        const block = agentClientSetupBlock({ kind: "claude-desktop", title: "T", json: '{"mcpServers":{"beeftv":{}}}' });
        expect(block?.format).toBe("json");
        expect(block?.instruction).toContain("保留已有服务");
        expect(block?.instruction).toContain("完全退出");
        expect(block?.instruction).not.toContain("终端运行");
    });
    test("codex / claude 展示终端命令", () => {
        for (const kind of ["codex", "claude"] as const) {
            const block = agentClientSetupBlock({ kind, title: "T", command: "beeftv mcp add", json: '{"mcpServers":{}}' });
            expect(block).toMatchObject({ text: "beeftv mcp add", format: "command" });
            expect(block?.instruction).toContain("PowerShell");
        }
    });

    test("cursor 展示配置并指向 ~/.cursor/mcp.json", () => {
        const block = agentClientSetupBlock({ kind: "cursor", title: "T", command: "beeftv mcp add", json: '{"mcpServers":{"beeftv":{}}}' });
        expect(block).toMatchObject({ text: '{"mcpServers":{"beeftv":{}}}', format: "json", instruction: "粘贴到 ~/.cursor/mcp.json。" });
    });

    test("其他 MCP 客户端展示配置，指引不提 Cursor 的路径", () => {
        const block = agentClientSetupBlock({ kind: "other", title: "T", json: '{"mcpServers":{}}' });
        expect(block?.format).toBe("json");
        expect(block?.instruction).not.toContain(".cursor");
    });

    test("只给到另一种形式时按实际内容展示，不留空白", () => {
        expect(agentClientSetupBlock({ kind: "codex", title: "T", json: '{"mcpServers":{}}' })).toMatchObject({ format: "json" });
        expect(agentClientSetupBlock({ kind: "cursor", title: "T", command: "beeftv mcp add" })).toMatchObject({ format: "command" });
        expect(agentClientSetupBlock({ kind: "codex", title: "T" })).toBeNull();
        expect(agentClientSetupBlock(undefined)).toBeNull();
    });
});

describe("一键接入的按钮状态", () => {
    const base: AgentIntegration = { kind: "claude", name: "Claude Code", detected: true, connected: false, skillInstalled: false, needsRetry: false };

    test("未检测到时只说明怎么出现，不显示可点的接入", () => {
        const integration = { ...base, detected: false };
        expect(agentIntegrationStatusLabel(integration)).toBe("未检测到");
        expect(agentIntegrationAction(integration)).toBe("unavailable");
        expect(agentIntegrationHint(integration)).toBe("没有检测到 Claude Code 的命令行。安装后打开一次，再回到这里。");
    });

    test("配置还在但这次没检测到 Agent 时，仍能断开 BeefTV 写入的配置", () => {
        const integration = { ...base, detected: false, connected: true, skillInstalled: true };
        expect(agentIntegrationStatusLabel(integration)).toBe("已接入");
        expect(agentIntegrationAction(integration)).toBe("disconnect");
        expect(agentIntegrationHint(integration)).toBe("已接入，但这次没有检测到 Claude Code。重新打开或重新安装 Claude Code 后就会生效。");
    });

    test("上一次没有清理完时显示需要重试，并给出断开这个动作", () => {
        const integration = { ...base, connected: true, skillInstalled: true, needsRetry: true };
        expect(agentIntegrationStatusLabel(integration)).toBe("需要重试");
        expect(agentIntegrationAction(integration)).toBe("disconnect");
        expect(agentIntegrationHint(integration)).toBe("上一次没有清理完连接。再点一次断开即可重试。");
    });

    test("检测到但未接入时说明会发生什么", () => {
        expect(agentIntegrationStatusLabel(base)).toBe("未接入");
        expect(agentIntegrationAction(base)).toBe("connect");
        expect(agentIntegrationHint(base)).toBe("接入后会在 Claude Code 里添加 BeefTV，并装好一份画布使用说明。");
    });

    test("已接入时显示断开，并说明打开就能用", () => {
        const integration = { ...base, connected: true, skillInstalled: true };
        expect(agentIntegrationStatusLabel(integration)).toBe("已接入");
        expect(agentIntegrationAction(integration)).toBe("disconnect");
        expect(agentIntegrationHint(integration)).toBe("已接入。打开 Claude Code 就能使用 BeefTV 画布。");
    });

    test("配置写入了但使用说明缺失时如实提示，不假装完成", () => {
        const integration = { ...base, kind: "codex" as const, name: "Codex", connected: true, skillInstalled: false };
        expect(agentIntegrationHint(integration)).toBe("已接入，但使用说明没有写入。请检查对应技能目录里是否已有同名内容。");
    });
});

describe("最近使用时间", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");

    test("没用过就说没用过", () => {
        expect(agentClientLastUsedLabel(null, now)).toBe("还没用过");
        expect(agentClientLastUsedLabel("", now)).toBe("还没用过");
        expect(agentClientLastUsedLabel("not-a-date", now)).toBe("还没用过");
    });

    test("按相对时间收敛到一句话", () => {
        expect(agentClientLastUsedLabel("2026-09-29T11:59:30Z", now)).toBe("刚刚");
        expect(agentClientLastUsedLabel("2026-09-29T11:30:00Z", now)).toBe("30 分钟前");
        expect(agentClientLastUsedLabel("2026-09-29T06:00:00Z", now)).toBe("6 小时前");
        expect(agentClientLastUsedLabel("2026-09-26T12:00:00Z", now)).toBe("3 天前");
        expect(agentClientLastUsedLabel("2026-01-05T12:00:00Z", now)).toContain("2026");
    });
});

function configWithChannels(channels: ModelChannel[], overrides: Partial<AiConfig> = {}): AiConfig {
    return { ...defaultConfig, channels, ...overrides };
}

function channel(id: string, profiles: Array<{ model: string; capability: "text" | "image"; protocol?: string }>, enabled = true): ModelChannel {
    return createModelChannel({
        id,
        name: `渠道 ${id}`,
        enabled,
        models: profiles.map((profile) => profile.model),
        modelProfiles: profiles.map((profile) => ({ model: profile.model, capability: profile.capability, protocol: profile.protocol })),
    });
}

describe("助手模型可选项", () => {
    const config = configWithChannels([
        channel("a", [
            { model: "chat-1", capability: "text", protocol: "chat-completion" },
            { model: "claude-1", capability: "text", protocol: "claude-api" },
            { model: "resp-1", capability: "text", protocol: "responses" },
            { model: "legacy-1", capability: "text", protocol: "openai-completion" },
            { model: "img-1", capability: "image", protocol: "openai-image" },
        ]),
        channel("b", [{ model: "chat-2", capability: "text", protocol: "chat-completion" }], false),
    ]);

    test("只留文本能力且协议受支持的模型，值形如 channelId::modelId", () => {
        expect(assistantModelOptions(config)).toEqual(["a::chat-1", "a::claude-1", "a::resp-1"]);
    });

    test("未启用渠道的模型不出现在可选项里", () => {
        expect(assistantModelOptions(config)).not.toContain("b::chat-2");
    });

    test("文本模型没写协议时按对话协议处理，仍然可选", () => {
        const implicit = configWithChannels([channel("c", [{ model: "chat-3", capability: "text" }])]);
        expect(assistantModelOptions(implicit)).toEqual(["c::chat-3"]);
    });
});

describe("助手模型的保存值", () => {
    const config = configWithChannels([channel("a", [{ model: "chat-1", capability: "text", protocol: "chat-completion" }])], { textModel: "a::chat-1" });

    test("空值表示跟随默认文本模型", () => {
        expect(normalizeAssistantModel(config, "")).toBe("");
        expect(normalizeAssistantModel(config, undefined)).toBe("");
        expect(resolveAssistantModel(config)).toBe("a::chat-1");
    });

    test("保存的是渠道加模型的完整取值", () => {
        expect(normalizeAssistantModel(config, "a::chat-1")).toBe("a::chat-1");
        expect(resolveAssistantModel({ ...config, assistantModel: "a::chat-1" })).toBe("a::chat-1");
    });

    test("指向已消失的渠道或不支持的协议时回落到跟随默认", () => {
        expect(normalizeAssistantModel(config, "gone::chat-1")).toBe("");
        const unsupported = configWithChannels([channel("a", [{ model: "img-1", capability: "image", protocol: "openai-image" }])], { textModel: "" });
        expect(normalizeAssistantModel(unsupported, "a::img-1")).toBe("");
        expect(resolveAssistantModel({ ...unsupported, assistantModel: "a::img-1" })).toBe("");
    });

    test("默认配置带上助手模型字段，默认为空", () => {
        expect(defaultConfig.assistantModel).toBe("");
    });
});
