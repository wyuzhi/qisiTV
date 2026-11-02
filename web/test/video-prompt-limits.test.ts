import { expect, test } from "bun:test";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { modelCapabilityDefaultsForService, OFFICIAL_LIKEAI_BASE_URL, QISI_API_BASE_URL, qisiModelCapabilities } from "../src/lib/likeai-service";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";

test("qisi API and official LikeAI preserve their independently declared prompt contracts", () => {
    const qisiDefaults = modelCapabilityDefaultsForService("likeai-video", "doubao_seedance_2_5", QISI_API_BASE_URL);
    const officialDefaults = modelCapabilityDefaultsForService("likeai-video", "doubao_seedance_2_5", OFFICIAL_LIKEAI_BASE_URL);
    expect(qisiDefaults.video!.references.promptMaxChars).toBe(20000);
    expect(officialDefaults.video!.references.promptMaxChars).toBe(0);
    const edited = qisiModelCapabilities("doubao_seedance_2_5");
    edited.video!.references.promptMaxChars = 8000;
    const config: AiConfig = {
        ...defaultConfig,
        channels: [{
            id: "channel", name: "qisi API", apiFormat: "likeai", apiKey: "", baseUrl: QISI_API_BASE_URL,
            models: ["doubao_seedance_2_5"], interfaceType: "likeai-video",
            modelProfiles: [{ model: "doubao_seedance_2_5", capability: "video", protocol: "likeai-video", capabilityConfig: edited, billingMode: "per_second", unitPriceMicrocredits: 0 }],
        }],
    };
    expect(modelCapabilityConfigFor(config, "channel::doubao_seedance_2_5").video!.references.promptMaxChars).toBe(8000);
});
