import { expect, test } from "bun:test";
import { buildCanvasGenerationRequirements, buildGenerationConfig, preferredMediaGeneratorMetadata, resolvedCanvasGenerationRequirements } from "@/lib/canvas/canvas-generation-config";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { modelCompatibilityError } from "@/lib/model-selection";
import { defaultConfig, normalizeConfigSnapshot, type AiConfig } from "@/stores/use-config-store";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const input = { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 };
const node: CanvasNodeData = { id: "target", type: CanvasNodeType.Video, title: "target", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: "channel::cinema-text", seconds: "5", size: "16:9", generateAudio: "false", watermark: "false" } };

function config(): AiConfig {
    const profiles = [
        { model: "cinema-text", displayName: "Cinema", operation: "text_to_video", images: 0 },
        { model: "cinema-image", displayName: "Cinema", operation: "image_to_video", images: 1 },
        { model: "other-image", displayName: "Other product", operation: "image_to_video", images: 9 },
    ].map(({ operation, images, ...model }) => {
        const capabilityConfig = defaultModelCapabilityConfig();
        capabilityConfig.video!.operations = [operation];
        capabilityConfig.video!.references.maxImages = images;
        return { ...model, capability: "video" as const, capabilityConfig, capabilitySource: "user" as const };
    });
    return { ...defaultConfig, channels: [{ id: "channel", name: "Test", baseUrl: "https://example.test", apiKey: "fixture", apiFormat: "openai", models: profiles.map(profile => profile.model), modelProfiles: profiles }], videoModel: "channel::cinema-text", videoSeconds: "10", videoGenerateAudio: "true", videoWatermark: "true" };
}

test("preview and resolved selection use node duration and the same display-model group", () => {
    const global = config();
    const preview = buildCanvasGenerationRequirements(global, node, "video", input);
    expect(preview.videoSeconds).toBe("5");
    expect(preview.options).toMatchObject({ videoSeconds: 5, videoGenerateAudio: false, videoWatermark: false });
    const resolved = buildGenerationConfig(global, node, "video", preview);
    expect(resolved.model).toBe("channel::cinema-image");
    expect(modelCompatibilityError(resolved, resolved.model, buildCanvasGenerationRequirements(resolved, node, "video", input))).toBe("");
    expect(global.videoModel).toBe("channel::cinema-text");
    expect(node.metadata?.model).toBe("channel::cinema-text");
});

test("incompatible references never select a different display-model product", () => {
    const global = config();
    const twoImages = { ...input, imageCount: 2 };
    const requirements = buildCanvasGenerationRequirements(global, node, "video", twoImages);
    const resolved = buildGenerationConfig(global, node, "video", requirements);
    expect(resolved.model).toBe("channel::cinema-text");
    expect(modelCompatibilityError(resolved, resolved.model, requirements)).not.toBe("");
});

test("character preview reserves minimum capacity while resolved input uses actual images", () => {
    const global = config();
    const preview = buildCanvasGenerationRequirements(global, node, "video", { ...input, imageCount: 0, characterCount: 1 });
    const resolved = buildCanvasGenerationRequirements(global, node, "video", { ...input, imageCount: 2, characterCount: 0 });
    expect(preview.input).toMatchObject({ imageCount: 0, characterCount: 1 });
    expect(resolved.input).toMatchObject({ imageCount: 2, characterCount: 0 });
});

test("image preview uses canvas count and transparent background instead of unrelated global count", () => {
    const global = { ...defaultConfig, count: "1", canvasImageCount: "4", transparentBackground: "true" };
    const imageNode = { ...node, type: CanvasNodeType.Image, metadata: { transparentBackground: "false" } };
    expect(buildCanvasGenerationRequirements(global, imageNode, "image", input).options).toMatchObject({ count: 4, transparentBackground: false });
});

test("workflow requirements do not apply model-only request options", () => {
    expect(buildCanvasGenerationRequirements({ ...config(), taskWorkflowProvider: "runninghub" }, node, "video", input).options).toBeUndefined();
});

test("resolved requirements retain admitted defaults rather than restoring raw node or canvas values", () => {
    const resolved = { ...defaultConfig, count: "2", canvasImageCount: "4", size: "3:2" };
    const imageNode = { ...node, type: CanvasNodeType.Image, metadata: { count: 9, size: "1:1" } };
    expect(resolvedCanvasGenerationRequirements(resolved, imageNode, "image", input).options).toMatchObject({ count: 2, size: "3:2" });
});

for (const savedModel of [false, true]) {
    for (const mode of ["image", "video"] as const) {
        test(`new ${mode} nodes preserve parameters supported by another same-name model, saved model: ${savedModel}`, () => {
            const previous = useCreationPreferencesStore.getState().preferences;
            try {
                const profiles = ["low", "high"].map((tier) => {
                    const capabilityConfig = defaultModelCapabilityConfig(mode === "image" ? "openai-image" : "openai-videos");
                    const size = tier === "low" ? "1024x1024" : "4096x4096";
                    capabilityConfig.image!.size = { parameter: "size", values: [size], default: size, allowCustom: false };
                    capabilityConfig.video!.duration = { selection: "enum", values: [tier === "low" ? 5 : 10], default: tier === "low" ? 5 : 10 };
                    return { model: `${mode}-${tier}`, displayName: "Same product", capability: mode, protocol: mode === "image" ? "openai-image" as const : "openai-videos" as const, capabilityConfig, capabilitySource: "user" as const };
                });
                const global = normalizeConfigSnapshot({ config: {
                    ...defaultConfig,
                    imageModel: "channel::image-low",
                    videoModel: "channel::video-low",
                    channels: [{ id: "channel", name: "Fixture", baseUrl: "https://example.test", apiKey: "fixture", apiFormat: "openai", models: profiles.map(profile => profile.model), modelProfiles: profiles }],
                } }).config;
                useCreationPreferencesStore.setState({ preferences: {
                    [mode]: { ...(savedModel ? { model: `channel::${mode}-low` } : {}), ...(mode === "image" ? { ratio: "4096x4096" } : { seconds: "10" }) },
                } });
                const restored = preferredMediaGeneratorMetadata(global, mode);
                expect(restored.model).toBe(`channel::${mode}-high`);
                expect(mode === "image" ? restored.size : restored.seconds).toBe(mode === "image" ? "4096x4096" : "10");
                const generated = buildGenerationConfig(global, { ...node, type: mode === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, metadata: restored }, mode);
                expect(generated.model).toBe(`channel::${mode}-high`);
                expect(mode === "image" ? generated.size : generated.videoSeconds).toBe(mode === "image" ? "4096x4096" : "10");

                useCreationPreferencesStore.setState({ preferences: { [mode]: { ...(savedModel ? { model: `channel::${mode}-low` } : {}), ...(mode === "image" ? { ratio: "8192x8192" } : { seconds: "20" }) } } });
                const unsupported = preferredMediaGeneratorMetadata(global, mode);
                expect(mode === "image" ? unsupported.size : unsupported.seconds).toBe(mode === "image" ? "1024x1024" : "5");
            } finally {
                useCreationPreferencesStore.setState({ preferences: previous });
            }
        });
    }
}
