import { expect, test } from "bun:test";

import { configWithoutCachedSecrets, normalizeConfigSnapshot, type AiConfig } from "@/stores/use-config-store";

const legacy = { apiKey: "rh-key", walletApiKey: "rh-wallet", uploadApiKey: "rh-upload", workflows: [] };

test("the old RunningHub keys do not survive into caches or the saved workspace config", () => {
    const normalized = normalizeConfigSnapshot({ config: { runningHub: legacy } as unknown as AiConfig }).config;
    expect(JSON.stringify(normalized)).not.toContain("rh-");

    const cached = configWithoutCachedSecrets({ ...normalized, runningHub: legacy } as AiConfig);
    expect(JSON.stringify(cached)).not.toContain("rh-");
});
