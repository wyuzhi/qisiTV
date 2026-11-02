import { expect, test } from "bun:test";
import { protocolAuthType, protocolCredentialKind, serviceCredentialGuide, signatureCredentialHint } from "../src/lib/service-credentials";
import { serviceConnectionError, serviceModelProfile } from "../src/lib/model-service-presets";
import { createModelChannel, type ModelChannel } from "../src/stores/use-config-store";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";

const arkBaseUrl = "https://ark.cn-beijing.volces.com/api/v3";

function channel(overrides: Partial<ModelChannel>): ModelChannel {
    return createModelChannel({ baseUrl: arkBaseUrl, apiKey: "synthetic-key", ...overrides });
}

test("Ark native and Agent Plan keys are named apart and cannot share one connection", () => {
    const native = channel({ models: ["doubao-seedance-2.5"], modelProfiles: [{ model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-video" }] });
    expect(serviceCredentialGuide(native)).toMatchObject({ kind: "ark-native", apiKeyLabel: "方舟 API Key" });
    expect(serviceCredentialGuide(native).apiKeyHelp).toContain("Agent Plan 专属 Key 不要填在这里");

    const plan = channel({ baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", models: ["doubao-seedance-2.5"], modelProfiles: [{ model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-agent-plan-video" }] });
    expect(serviceCredentialGuide(plan)).toMatchObject({ kind: "ark-agent-plan", apiKeyLabel: "Agent Plan 专属 Key" });
    expect(serviceCredentialGuide(plan).apiKeyHelp).toContain("多扣费");

    const mixed = channel({
        models: ["doubao-seedance-2.5", "doubao-seedance-2.0"],
        modelProfiles: [
            { model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-video" },
            { model: "doubao-seedance-2.0", capability: "video", protocol: "volcengine-ark-agent-plan-video" },
        ],
    });
    const guide = serviceCredentialGuide(mixed);
    expect(guide.kind).toBe("mixed");
    expect(guide.conflict).toContain("请拆成两个连接");
    expect(serviceConnectionError(mixed)).toBe(guide.conflict!);
});

test("a generic text model follows the Ark path it is pointed at, so the two keys cannot hide behind it", () => {
    // 文本协议本身不说明是哪一类 Key：地址在 /api/v3 就是普通方舟 Key。
    const nativeText = channel({ models: ["doubao-seed"], modelProfiles: [{ model: "doubao-seed", capability: "text", protocol: "chat-completion" }] });
    expect(serviceCredentialGuide(nativeText)).toMatchObject({ kind: "ark-native", apiKeyLabel: "方舟 API Key" });

    // 同一个文本协议指向 /api/plan/v3 时是 Agent Plan Key。
    const planText = channel({ baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", models: ["doubao-seed"], modelProfiles: [{ model: "doubao-seed", capability: "text", protocol: "chat-completion" }] });
    expect(serviceCredentialGuide(planText)).toMatchObject({ kind: "ark-agent-plan", apiKeyLabel: "Agent Plan 专属 Key" });

    // 普通文本 + Agent Plan 视频，放在同一台主机上就是真混用。
    const mixed = channel({
        models: ["doubao-seed", "doubao-seedance-2.5"],
        modelProfiles: [
            { model: "doubao-seed", capability: "text", protocol: "chat-completion" },
            { model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-agent-plan-video" },
        ],
    });
    expect(serviceCredentialGuide(mixed).kind).toBe("mixed");

    // 同一个地址下，普通文本和普通视频不算混用。
    const sameKeys = channel({
        models: ["doubao-seed", "doubao-seedance-2.5"],
        modelProfiles: [
            { model: "doubao-seed", capability: "text", protocol: "chat-completion" },
            { model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-video" },
        ],
    });
    expect(serviceCredentialGuide(sameKeys).kind).toBe("ark-native");
});

test("protocols that need no credential do not count as a second credential", () => {
    const none = { value: "ollama-chat", capability: "text", enabled: true, authType: "none" } as ModelProtocolDefinition;
    const jimeng = { value: "volcengine-jimeng-video", capability: "video", enabled: true, authType: "volcengine-v4" } as ModelProtocolDefinition;
    const mixed = channel({
        baseUrl: "https://visual.volcengineapi.com",
        models: ["jimeng_t2v_v30", "llama3"],
        modelProfiles: [
            { model: "jimeng_t2v_v30", capability: "video", protocol: "volcengine-jimeng-video" },
            { model: "llama3", capability: "text", protocol: "ollama-chat", authType: "none" },
        ],
    });
    expect(protocolCredentialKind("ollama-chat", "none")).toBe("none");
    // 无鉴权模型不占用这份凭证，因此不是混用。
    expect(serviceCredentialGuide(mixed, [none, jimeng])).toMatchObject({ kind: "signature", apiKeyLabel: "Access Key（AK）" });
});

test("Jimeng protocols ask for Access Key plus Secret Key and refuse a half credential", () => {
    const protocols = [{ value: "volcengine-jimeng-video", capability: "video", enabled: true, authType: "volcengine-v4" } as ModelProtocolDefinition];
    const jimeng = channel({
        baseUrl: "https://visual.volcengineapi.com",
        models: ["jimeng_t2v_v30"],
        modelProfiles: [{ model: "jimeng_t2v_v30", capability: "video", protocol: "volcengine-jimeng-video" }],
    });
    const guide = serviceCredentialGuide(jimeng, protocols);
    expect(guide).toMatchObject({ kind: "signature", apiKeyLabel: "Access Key（AK）", secretKeyLabel: "Secret Key（SK）", secretKeyRequired: true });
    expect(guide.apiKeyHelp).toContain("AK/SK");
    // 协议目录没有加载时，靠固定的协议 ID 仍要认出「两个密钥」。
    expect(serviceCredentialGuide(jimeng).kind).toBe("signature");
    expect(serviceConnectionError(jimeng, { protocols })).toContain("请填写 Secret Key（SK）");
    expect(serviceConnectionError({ ...jimeng, secretKey: "synthetic-secret" }, { protocols })).toBe("");
    // 外部工作区回读配置时密钥是空串（backend/internal/handler/business_config.go 的
    // redactExternalConfig），能不能留空只认后端回的 hasSecretKey，不靠「连接已经存在」推断。
    const redacted = { ...jimeng, apiKey: "refilled-ak", secretKey: "", hasApiKey: true, hasSecretKey: undefined };
    // 已保存的普通 API Key 连接改成即梦协议：后端只有 apiKey，没有 SK 可沿用，必须让用户填。
    expect(serviceConnectionError(redacted, { protocols })).toContain("请填写 Secret Key（SK）");
    // 后端确实存过 SK 时（hasSecretKey）才允许留空。
    expect(serviceConnectionError({ ...redacted, hasSecretKey: true }, { protocols })).toBe("");
    expect(signatureCredentialHint("volcengine-v4")).toContain("「高级设置」");
    expect(signatureCredentialHint("bearer")).toBeUndefined();
});

test("credentials are judged on the profiles that will actually be saved", () => {
    // 旧连接：文本模型没写过 profile，视频模型已经选了 Agent Plan。草稿上只看得到一种 Key。
    const protocols = [
        { value: "chat-completion", capability: "text", enabled: true, authType: "bearer" },
        { value: "volcengine-ark-agent-plan-video", capability: "video", enabled: true, authType: "bearer" },
    ] as ModelProtocolDefinition[];
    const legacy = channel({
        models: ["doubao-seed", "doubao-seedance-2.5"],
        modelProfiles: [{ model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-agent-plan-video", authType: "bearer" }],
    });
    expect(legacy.interfaceType).toBeUndefined();
    expect(serviceConnectionError(legacy, { protocols })).toBe("");
    // save() 会把这些 profile 补齐后提交，凭证必须按补齐后的结果判断。
    const profiles = legacy.models.map((id) => serviceModelProfile(legacy, { id }, protocols));
    expect(profiles.find((profile) => profile.model === "doubao-seed")?.protocol).toBe("chat-completion");
    const submitted = { ...legacy, modelProfiles: profiles };
    expect(serviceConnectionError(submitted, { protocols })).toContain("请拆成两个连接");
});

test("the runtime protocol catalog decides the auth type, not the cached value", () => {
    // 目录说这个协议要 AK/SK 时，配置里缓存的旧 authType 不能把它盖掉。
    expect(protocolAuthType("volcengine-jimeng-video", "bearer", [{ value: "volcengine-jimeng-video", capability: "video", enabled: true, authType: "volcengine-v4" } as ModelProtocolDefinition])).toBe("volcengine-v4");
    // 目录没有这个协议时（未安装），才退回配置里记录的值。
    expect(protocolAuthType("volcengine-jimeng-video", "bearer", [])).toBe("bearer");
    const jimeng = channel({
        baseUrl: "https://visual.volcengineapi.com",
        models: ["jimeng_t2v_v30"],
        modelProfiles: [{ model: "jimeng_t2v_v30", capability: "video", protocol: "volcengine-jimeng-video", authType: "bearer" }],
    });
    const protocols = [{ value: "volcengine-jimeng-video", capability: "video", enabled: true, authType: "volcengine-v4" } as ModelProtocolDefinition];
    expect(serviceCredentialGuide(jimeng, protocols)).toMatchObject({ kind: "signature", secretKeyRequired: true });
});

test("an Ark connection without a chosen protocol explains both key kinds", () => {
    expect(serviceCredentialGuide(channel({ models: [] })).apiKeyHelp).toContain("普通方舟 Key 配 /api/v3");
    expect(serviceCredentialGuide(channel({ baseUrl: "https://api.example.com/v1", models: [] })).apiKeyHelp).not.toContain("Agent Plan");
    // 即梦只看域名就要说清是 Access Key + Secret Key，不等用户挑协议。
    const jimengHost = serviceCredentialGuide(channel({ baseUrl: "https://visual.volcengineapi.com", models: [] }));
    expect(jimengHost).toMatchObject({ kind: "signature", apiKeyLabel: "Access Key（AK）", secretKeyRequired: true });
    // 选了普通方舟协议以后只留这一种的说明，不再重复两类 Key 的对比。
    const ark = serviceCredentialGuide(channel({ models: ["seedance-2.5"], modelProfiles: [{ model: "seedance-2.5", capability: "video", protocol: "volcengine-ark-video" }] }));
    expect(ark.apiKeyHelp).toContain("Agent Plan 专属 Key 不要填在这里");
});

test("credential kinds follow the protocol, not the vendor name on the model", () => {
    expect(protocolCredentialKind("volcengine-ark-agent-plan-image")).toBe("ark-agent-plan");
    expect(protocolCredentialKind("volcengine-ark-image")).toBe("ark-native");
    expect(protocolCredentialKind("tencent-hunyuan-video")).toBe("signature");
    expect(protocolCredentialKind("chat-completion", "bearer")).toBe("standard");
    expect(protocolCredentialKind(undefined)).toBeUndefined();
    // 一份密钥只服务一个签名体系：腾讯云和火山的签名并存时必须拆开。
    const mixedSignature = channel({
        baseUrl: "https://example.invalid",
        models: ["hunyuan", "jimeng"],
        modelProfiles: [
            { model: "hunyuan", capability: "video", protocol: "tencent-hunyuan-video" },
            { model: "jimeng", capability: "video", protocol: "volcengine-jimeng-video" },
        ],
    });
    const conflict = serviceCredentialGuide(mixedSignature).conflict || "";
    expect(conflict).toContain("Access Key（AK）");
    expect(conflict).toContain("SecretId");
    expect(conflict).toContain("请拆成两个连接");
});


test("AK/SK cannot share one connection with bearer credentials", () => {
    for (const baseUrl of ["https://api.example.com/v1", arkBaseUrl, "https://ark.cn-beijing.volces.com/api/plan/v3"]) {
        const mixed = channel({
            baseUrl, secretKey: "synthetic-secret",
            models: ["text", "jimeng"],
            modelProfiles: [
                { model: "text", capability: "text", protocol: "chat-completion" },
                { model: "jimeng", capability: "video", protocol: "volcengine-jimeng-video" },
            ],
        });
        expect(serviceCredentialGuide(mixed).kind).toBe("mixed");
        expect(serviceConnectionError(mixed)).toContain("请拆成两个连接");
    }
});
