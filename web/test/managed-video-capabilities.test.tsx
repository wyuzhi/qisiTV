import { expect, test } from "bun:test";
import { managedVideoCatalogItem } from "./managed-video-fixture";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel } from "../src/components/video-settings-panel";
import { canvasThemes } from "../src/lib/canvas-theme";
import { mergeFetchedChannelModelProfiles, sanitizeChannelModelCatalogItem } from "../src/lib/channel-model-catalog";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor, sanitizeServerVideoCapability } from "../src/lib/model-capabilities";
import { hasDeclaredModelCapability, modelCompatibilityError, resolveModelGenerationDefaults } from "../src/lib/model-selection";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import { creationReferenceLimitsFor, reconcileCreationAttachmentLimit } from "../src/pages/create/creation-references";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, type ModelChannel } from "../src/stores/use-config-store";

const catalog = ["managed-video-catalog.json", "managed-video-catalog-live.json"].flatMap((name) => JSON.parse(readFileSync(new URL(`../../backend/internal/beefapi/testdata/${name}`, import.meta.url), "utf8")).data) as Array<{ id: string; video_capabilities: unknown; video_capabilities_version?: string }>;
const supplied = catalog.filter((item) => item.video_capabilities_version && item.video_capabilities);

function configured(channel: ModelChannel, model: string) {
    return { ...defaultConfig, channels: [channel], model: `${channel.id}::${model}`, videoModel: `${channel.id}::${model}` };
}

test("real API video declarations survive catalog merge, hydration and control lookup", () => {
    expect(supplied.length).toBeGreaterThan(5);
    for (const item of supplied) {
        for (const model of [item.id, `unknown-${item.id.length}`]) {
            const channel = createModelChannel({ id: "beefapi", pinned: true, credentialRef: "beefapi-enterprise", baseUrl: "https://beeftv.app", models: [model] });
            const video = sanitizeServerVideoCapability(item.video_capabilities)!;
            channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [{ id: model, supportedEndpointTypes: ["openai-video"], videoCapabilities: video, videoCapabilitiesVersion: item.video_capabilities_version }]);
            const config = normalizeConfigSnapshot({ config: configured(channel, model) }).config;
            expect(modelCapabilityConfigFor(config, `beefapi::${model}`).video).toEqual(video);
        }
    }
});

test("explicit server zero and false values cannot be repaired from the model name", () => {
    const model = "seedance-2.5";
    const video = defaultModelCapabilityConfig("openai-videos", "unknown").video!;
    video.references = { ...video.references, maxImages: 0, maxVideos: 0, maxAudios: 0, maxImageBytes: 0, maxVideoBytes: 0, maxAudioBytes: 0, minAudioDurationSeconds: 0, minVideoPixels: 0 };
    video.duration = { selection: "range", min: 1, max: 3, step: 1, default: 1 };
    video.generateAudio = { supported: false, default: false };
    video.taskTypeConstraints = false;
    const channel = createModelChannel({ id: "beefapi", pinned: true, baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{ model, capability: "video", protocol: "openai-videos", videoCapabilitiesVersion: "server-v2", capabilityConfig: { version: 1, video } }] });
    const config = normalizeConfigSnapshot({ config: configured(channel, model) }).config;
    expect(modelCapabilityConfigFor(config, config.model).video).toEqual(video);
    const html = renderToStaticMarkup(<VideoSettingsPanel config={config} theme={canvasThemes.dark} onConfigChange={() => {}} />);
    expect(html).toContain('min="1"');
    expect(html).not.toContain("生成声音");
    for (const protocol of ["newapi", "volcengine-jimeng-video"] as const) {
        config.channels[0].modelProfiles![0].protocol = protocol;
        const controls = renderToStaticMarkup(<VideoSettingsPanel config={config} theme={canvasThemes.dark} onConfigChange={() => {}} />);
        expect(controls).toContain("分辨率");
        expect(controls).toContain('min="1"');
    }
    expect(modelCompatibilityError(config, config.model, { capability: "video", videoSeconds: "1" })).toBe("");
});

test("a missing or invalid directory keeps a previous version but never invents a first declaration", async () => {
    const model = "seedance-2.0";
    const video = sanitizeServerVideoCapability(supplied[0].video_capabilities)!;
    const channel = createModelChannel({ id: "beefapi", pinned: true, baseUrl: "https://beeftv.app", models: [model], modelProfiles: [{ model, capability: "video", protocol: "openai-videos", videoCapabilitiesVersion: "keep", capabilityConfig: { version: 1, video } }] });
    for (const fields of [{}, { videoCapabilities: video, videoCapabilitiesVersion: " " }, { videoCapabilities: {} as typeof video, videoCapabilitiesVersion: "bad" }]) {
        for (const supportedEndpointTypes of [["openai-video"], ["openai"], []]) {
            const next = mergeFetchedChannelModelProfiles(channel, [{ id: model, supportedEndpointTypes, ...fields }]);
            expect(next[0].videoCapabilitiesVersion).toBe("keep");
            expect(next[0].capabilityConfig?.video).toEqual(video);
            expect(next[0]).toMatchObject({ capability: "video", protocol: "openai-videos" });
        }
    }
    const fresh = createModelChannel({ ...channel, modelProfiles: [{ model, capability: "video", protocol: "openai-videos", capabilityConfig: defaultModelCapabilityConfig("newapi", model) }] });
    const config = configured(fresh, model);
    expect(modelCapabilityConfigFor(config, config.model).videoCapabilitiesUnavailable).toBeUndefined();
    expect(modelCompatibilityError(config, config.model, { capability: "video" })).toBe("");
    const html = renderToStaticMarkup(<VideoSettingsPanel config={config} theme={canvasThemes.dark} onConfigChange={() => {}} />);
    expect(html).toContain("分辨率");
    const attachments = [{ id: "old-image", type: "image/png", name: "original.png", url: "https://storage.example/original.png" }];
    const references = [{ id: "old-image", attachmentId: "old-image", label: "原图", kind: "image" as const }];
    const kept = reconcileCreationAttachmentLimit(attachments, references, creationReferenceLimitsFor("video", modelCapabilityConfigFor(config, config.model), { videoReferencesDeclared: false }));
    expect(kept.attachments).toBe(attachments);
    expect(kept.removedReferences).toHaveLength(0);
    const explicit = { videoSeconds: "9", size: "9:16", vquality: "1080p" };
    expect(resolveModelGenerationDefaults(config, config.model, "video", explicit)).toMatchObject({ videoSeconds: "9", size: "9:16", vquality: "1080" });
    await expect(prepareBackendGenerationTask({ mode: "video", prompt: "scene", config })).resolves.toMatchObject({ type: "canvas_video" });
    fresh.modelProfiles = mergeFetchedChannelModelProfiles(fresh, [{ id: model, modelType: "video", videoCapabilities: video, videoCapabilitiesVersion: "new" }]);
    expect(modelCapabilityConfigFor(config, config.model).videoCapabilitiesUnavailable).toBeUndefined();
    expect(modelCapabilityConfigFor(config, config.model).video).toEqual(video);
});

test("unversioned catalog payload is not labeled as a server declaration", () => {
    const video = sanitizeServerVideoCapability(supplied[0].video_capabilities)!;
    const normalized = sanitizeChannelModelCatalogItem({ id: "video", videoCapabilities: video, videoCapabilitiesVersion: " " });
    expect(normalized?.videoCapabilities).toBeUndefined();
});

test("custom BYOK channels retain local Seedance capability defaults", () => {
    const channel = createModelChannel({ id: "custom", baseUrl: "https://example.com", models: ["seedance-2.0"], interfaceType: "newapi" });
    const config = configured(channel, "seedance-2.0");
    expect(modelCapabilityConfigFor(config, config.model).videoCapabilitiesUnavailable).toBeUndefined();
    expect(modelCapabilityConfigFor(config, config.model).video!.references.maxImages).toBe(9);
});

test("operation-specific counts preserve attachments and reject an incompatible explicit submission", async () => {
    const item = managedVideoCatalogItem("wan3.0-video");
    const video = item.videoCapabilities!;
    expect(video.references.maxImages).toBe(10);
    expect(video.operationReferences?.image_to_video).toMatchObject({ maxImages: 2, maxVideos: 0, maxAudios: 0 });
    const channel = createModelChannel({ id: "beefapi", models: [item.id], credentialRef: "beefapi-enterprise", baseUrl: "https://beeftv.app" });
    channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [item]);
    const config = { ...configured(channel, item.id), videoSeconds: "5" };
    const images = Array.from({ length: 3 }, (_, i) => ({ id: `ref-${i}`, name: `ref-${i}`, type: "image/png", dataUrl: "", storageKey: `resource:ref-${i}` }));
    const metadata = { videoEditOperation: "image_to_video" };
    expect(modelCompatibilityError(config, config.model, { capability: "video", input: { imageCount: 3, videoCount: 0, audioCount: 0, characterCount: 0, textCount: 1 } })).toBe("");
    expect(modelCompatibilityError(config, config.model, { capability: "video", videoOperation: "image_to_video", input: { imageCount: 3, videoCount: 0, audioCount: 0, characterCount: 0, textCount: 1 } })).toContain("2 张参考图");
    await expect(prepareBackendGenerationTask({ mode: "video", prompt: "scene", config, referenceImages: images, metadata })).resolves.toMatchObject({ type: "canvas_video" });
    const kept = reconcileCreationAttachmentLimit(images, [], creationReferenceLimitsFor("video", modelCapabilityConfigFor(config, config.model)));
    expect(kept.attachments).toBe(images);
    const noVideo = [{ id: "clip", name: "clip", url: "https://example.com/clip.mp4" }];
    for (const operationReferences of [{ image_to_video: { maxImages: 2.5 } }, { image_to_video: { minImages: 3, maxImages: 2 } }, { unknown: { maxImages: 2 } }]) {
        expect(sanitizeServerVideoCapability({ ...video, operationReferences })).toBeNull();
    }
});

test("a managed model without any profile falls back to default video controls without blocking", () => {
    const channel = createModelChannel({ id: "beefapi", models: ["seedance-2.5", "hy-image-v3"], baseUrl: "https://beeftv.app" });
    const config = configured(channel, "seedance-2.5");
    const capability = modelCapabilityConfigFor(config, "beefapi::seedance-2.5");
    expect(capability.videoCapabilitiesUnavailable).toBeUndefined();
    expect(capability.video!.resolutions.length).toBeGreaterThan(0);
    expect(hasDeclaredModelCapability(config, "beefapi::hy-image-v3", "image")).toBe(false);
    expect(modelCompatibilityError(config, "beefapi::hy-image-v3", { capability: "image", input: { textCount: 1, imageCount: 6, videoCount: 0, audioCount: 0, characterCount: 0 } })).toBe("");
});

test("Seedance 2.5 exposes 480P draft preview switch and task payload carries videoDraft", async () => {
    const channel = createModelChannel({ id: "beefapi", pinned: true, interfaceType: "newapi", models: ["seedance-2.5"], baseUrl: "https://beeftv.app" });
    const config = { ...configured(channel, "seedance-2.5"), videoDraft: "true" };
    const capability = modelCapabilityConfigFor(config, "beefapi::seedance-2.5");
    expect(capability.video?.draft).toEqual({ supported: true, default: false });
    expect(capability.video?.resolutions).toContain("480p");
    const html = renderToStaticMarkup(<VideoSettingsPanel config={config} theme={canvasThemes.dark} onConfigChange={() => {}} />);
    expect(html).toContain("样片预览 (480P)");
    const prepared = await prepareBackendGenerationTask({ mode: "video", prompt: "scene", config });
    expect(prepared.input.config?.videoDraft).toBe("true");
    expect(prepared.input.config?.vquality).toBe("480p");
});
