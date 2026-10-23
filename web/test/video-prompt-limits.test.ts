import { expect, test } from "bun:test";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor, type ModelCapabilityConfig } from "../src/lib/model-capabilities";
import { modelPromptLengthError } from "../src/lib/model-selection";
import { modelCapabilityDefaultsForService, OFFICIAL_LIKEAI_BASE_URL, QISI_API_BASE_URL, qisiModelCapabilities } from "../src/lib/likeai-service";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";

function configFor(protocol: string, model: string, capabilityConfig?: ModelCapabilityConfig): AiConfig {
    return {
        ...defaultConfig,
        channels: [{
            id: "channel", name: "Test", apiFormat: "openai", apiKey: "", baseUrl: "https://example.com",
            models: [model], interfaceType: protocol,
            modelProfiles: [{ model, capability: "video", protocol, capabilityConfig, billingMode: "per_second", unitPriceMicrocredits: 0 }],
        }],
    };
}

test("documented video limits apply without a saved capability profile and never truncate", () => {
    const cases: [string, string, number][] = [
        ["minimax-video", "MiniMax-H3", 7000],
        ["openai", "sora-2-pro", 32000],
        ["dashscope-wan-video", "wan2.6-t2v", 1500],
        ["dashscope-wan-video", "wan3.0-t2v", 20000],
        ["volcengine-jimeng-video", "jimeng_t2v_v30", 800],
        ["runway-video", "seedance2_5", 15000],
        ["runway-video", "wan3_prime", 20000],
        ["full-video", "custom", 4000],
    ];
    for (const [protocol, model, limit] of cases) {
        const config = configFor(protocol, model);
        const prompt = "镜".repeat(limit + 1);
        expect(modelPromptLengthError(config, "channel::" + model, "video", prompt.slice(1))).toBe("");
        expect(modelPromptLengthError(config, "channel::" + model, "video", prompt)).toContain("不会自动截断");
        expect(prompt.length).toBe(limit + 1);
    }
});

test("UTF-16 video limits count emoji as two units and explicit legacy limits win", () => {
    const config = configFor("runway-video", "gen4.5");
    expect(modelPromptLengthError(config, "channel::gen4.5", "video", "😀".repeat(500))).toBe("");
    expect(modelPromptLengthError(config, "channel::gen4.5", "video", "😀".repeat(501))).toContain("1002 个单位");
    const profile = defaultModelCapabilityConfig("runway-video", "gen4.5");
    profile.video!.references.promptMaxChars = 8000;
    delete profile.video!.references.promptMaxUtf16Units;
    const legacy = configFor("runway-video", "gen4.5", profile);
    expect(modelCapabilityConfigFor(legacy, "channel::gen4.5").video!.references.promptMaxUtf16Units).toBe(0);
    expect(modelPromptLengthError(legacy, "channel::gen4.5", "video", "😀".repeat(8000))).toBe("");
    expect(modelPromptLengthError(legacy, "channel::gen4.5", "video", "😀".repeat(8001))).toContain("8001 个字符");
});

test("LikeAI and unknown routes do not inherit another provider's model-name limits", () => {
    for (const [protocol, model] of [
        ["likeai-video", "doubao_seedance_2_5"],
        ["likeai-video", "wan_video_3_prime"],
        ["likeai-video", "sora-2"],
        ["custom-video", "wan3_prime"],
        ["volcengine-ark-video", "seedance-2.5"],
        ["gemini-veo", "veo-3.1"],
    ]) {
        const config = configFor(protocol!, model!);
        expect(modelPromptLengthError(config, "channel::" + model, "video", "镜".repeat(32001))).toBe("");
    }
    const config = configFor("likeai-video", "doubao_seedance_2_5", qisiModelCapabilities("doubao_seedance_2_5"));
    expect(modelPromptLengthError(config, "channel::doubao_seedance_2_5", "video", "镜".repeat(20000))).toBe("");
    expect(modelPromptLengthError(config, "channel::doubao_seedance_2_5", "video", "镜".repeat(20001))).toContain("最多 20000 个字符");
});

test("resetting qisi API video limits restores its own 20000-character contract", () => {
    const qisiDefaults = modelCapabilityDefaultsForService("likeai-video", "doubao_seedance_2_5", QISI_API_BASE_URL);
    const officialDefaults = modelCapabilityDefaultsForService("likeai-video", "doubao_seedance_2_5", OFFICIAL_LIKEAI_BASE_URL);
    expect(qisiDefaults.video!.references.promptMaxChars).toBe(20000);
    expect(officialDefaults.video!.references.promptMaxChars).toBe(0);
    const edited = qisiModelCapabilities("doubao_seedance_2_5");
    edited.video!.references.promptMaxChars = 8000;
    const config = configFor("likeai-video", "doubao_seedance_2_5", edited);
    expect(modelCapabilityConfigFor(config, "channel::doubao_seedance_2_5").video!.references.promptMaxChars).toBe(8000);
});
