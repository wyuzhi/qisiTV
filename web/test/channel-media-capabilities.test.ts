import { expect, test } from "bun:test";
import { catalogModelMapping, mergeFetchedChannelModelProfiles, sanitizeChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import { sanitizeMediaCapabilities } from "@/lib/media-capabilities";
import type { ModelChannel } from "@/stores/use-config-store";

const fields = {
    audio: { operations: ["synthesize"], options: ["voice", "speed"], reference_kinds: [], max_outputs: 1, prompt_max_chars: 5000 },
    upscale: { operations: ["upscale"], options: ["upscale_factor"], reference_kinds: ["image", "video"], max_outputs: 1 },
};

test("opaque model keeps versioned media controls through catalog import and saved profile", () => {
    const item = sanitizeChannelModelCatalogItem({ id: "opaque-fixture", mediaCapabilities: fields, mediaCapabilitiesVersion: "fixture-sha" })!;
    expect(item.mediaCapabilities?.audio?.promptMaxChars).toBe(5000);
    expect(item.mediaCapabilities?.upscale?.referenceKinds).toEqual(["image", "video"]);
    expect(catalogModelMapping(item)).toEqual({ capability: "audio", protocol: "openai-audio" });
    const channel = { id: "beefapi", interfaceType: "openai-image", models: [] } as unknown as ModelChannel;
    const [profile] = mergeFetchedChannelModelProfiles(channel, [item]);
    expect(profile.capability).toBe("audio");
    expect(profile.mediaCapabilities).toEqual(item.mediaCapabilities);
    expect(profile.mediaCapabilitiesVersion).toBe("fixture-sha");
    const replayed = sanitizeMediaCapabilities(JSON.parse(JSON.stringify(profile.mediaCapabilities)));
    expect(replayed).toEqual(item.mediaCapabilities);
});

test("missing current advertisement removes cached media authority", () => {
    const item = sanitizeChannelModelCatalogItem({ id: "opaque-fixture", modelType: "audio", mediaCapabilities: fields, mediaCapabilitiesVersion: "old" })!;
    const base = { id: "beefapi", interfaceType: "openai-audio", models: [item.id] } as unknown as ModelChannel;
    const profiles = mergeFetchedChannelModelProfiles(base, [item]);
    const [next] = mergeFetchedChannelModelProfiles({ ...base, modelProfiles: profiles }, [{ id: item.id, modelType: "audio" }]);
    expect(next.mediaCapabilities).toBeUndefined();
    expect(next.mediaCapabilitiesVersion).toBeUndefined();
    expect(sanitizeChannelModelCatalogItem({ id: item.id, mediaCapabilities: fields })?.mediaCapabilities).toBeUndefined();
});

test("invalid media records cannot manufacture supported defaults", () => {
    for (const value of [null, [], { audio: {} }, { audio: { ...fields.audio, max_outputs: 0 } }, { audio: { ...fields.audio, options: "voice" } }, { audio: { ...fields.audio, reference_kinds: ["unknown"] } }]) {
        expect(sanitizeMediaCapabilities(value)).toBeUndefined();
    }
});
