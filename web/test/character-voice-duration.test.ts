import { expect, spyOn, test } from "bun:test";
import { hydrateNodeGenerationContext, type NodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import * as projects from "../src/services/api/projects";
import * as resources from "../src/services/api/resources";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { assertVideoCapability } from "../src/services/api/video-validation";

test("stored character voice keeps duration through canvas hydration and preflight", async () => {
    const character = spyOn(projects, "getProjectCharacter").mockResolvedValue({
        asset: { id: "character-1", title: "爸爸" },
        character: { versionId: "version-1", definition: {}, representations: [], voice: { profile: { sampleResourceId: "voice-1" }, instructions: "" } },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
    const resource = spyOn(resources, "getResource").mockResolvedValue({ id: "voice-1", mimeType: "audio/mpeg", objectKey: "voice.mp3", durationMs: 2500, size: 1234 } as resources.RemoteResource);
    try {
        const context: NodeGenerationContext = {
            prompt: "test",
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            characterReferences: [{ nodeId: "character-node", assetId: "character-1" }],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
            textCount: 1,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
        const hydrated = await hydrateNodeGenerationContext(context, "canvas-1", "project-1", "video", true);
        expect(hydrated.referenceAudios[0]?.durationMs).toBe(2500);
        expect(hydrated.referenceAudios[0]?.bytes).toBe(1234);
        const model = "seedance-2.5";
        const profile = modelCapabilityConfigFor({ channels: [{ id: "beef", models: [model], modelProfiles: [{ model, protocol: "newapi-channel-2" }] }] }, `beef::${model}`).video!;
        expect(() => assertVideoCapability(profile, [], [], hydrated.referenceAudios, "5")).not.toThrow();
    } finally {
        character.mockRestore();
        resource.mockRestore();
    }
});
