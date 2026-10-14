import { expect, test } from "bun:test";
import { channelModelProfile, createModelChannel, defaultConfig, filterModelsByCapability, modelDisplayName, resolveModelChannel } from "../src/stores/use-config-store";

test("model lookup retains channel identity for duplicate names and updates immutable catalog versions", () => {
    const a = { ...createModelChannel({ id: "a", models: ["shared"] }), modelProfiles: [{ model: "shared", capability: "image" as const, displayName: "A" }] };
    const b = { ...createModelChannel({ id: "b", models: ["shared"] }), modelProfiles: [{ model: "shared", capability: "video" as const, displayName: "B" }] };
    const config = { ...defaultConfig, channels: [a, b] };
    expect(resolveModelChannel(config, "shared")).toBe(a);
    expect(modelDisplayName(config, "b::shared")).toBe("B");
    expect(filterModelsByCapability(["a::shared", "b::shared"], "video", config.channels)).toEqual(["b::shared"]);
    const changed = { ...b, modelProfiles: [{ model: "shared", capability: "audio" as const, displayName: "B updated" }] };
    const next = { ...config, channels: [a, changed] };
    expect(modelDisplayName(next, "b::shared")).toBe("B updated");
    expect(filterModelsByCapability(["a::shared", "b::shared"], "video", next.channels)).toEqual([]);
    expect(resolveModelChannel(next, "b::shared")).toBe(changed);
});

test("large catalogs index profiles once instead of scanning every model", () => {
    let visits = 0;
    const models = Array.from({ length: 2000 }, (_, i) => `image-${i}`);
    const modelProfiles = models.map(model => ({ get model() { visits++; return model; }, capability: "image" as const, displayName: model }));
    const channel = { ...createModelChannel({ id: "large", models }), modelProfiles };
    const config = { ...defaultConfig, channels: [channel] };
    const options = models.map(model => `large::${model}`);
    expect(filterModelsByCapability(options, "image", config.channels)).toEqual(options);
    options.forEach(model => expect(modelDisplayName(config, model)).toBe(model.split("::")[1]!));
    expect(visits).toBeLessThanOrEqual(models.length * 2);
    const profiles = [{ model: "image-0", displayName: "refreshed" }];
    expect(channelModelProfile({ ...channel, modelProfiles: profiles }, "image-0")?.displayName).toBe("refreshed");
});
