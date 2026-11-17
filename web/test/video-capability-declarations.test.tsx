import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";
import { buildReferenceGraph } from "./fixtures/canvas-reference-graph";
import { managedVideoCatalogItem } from "./managed-video-fixture";

const makeImageRefs = (count: number): CanvasResourceReference[] =>
    Array.from({ length: count }, (_, index) => ({
        id: `img-${index + 1}`,
        nodeId: `img-${index + 1}`,
        kind: "image",
        label: `图片${index + 1}`,
        title: `镜头${index + 1}`,
        active: true,
        previewUrl: `https://example.com/img-${index + 1}.png`,
    }));

describe("Video capability declarations & BeefTV route boundaries", () => {
    test("CanvasConfigComposer 与 CanvasConfigNodePanel 遵循显式 middleFrame 与 operationReferences 声明", async () => {
        const { CanvasConfigComposer } = await import("../src/components/canvas/canvas-config-composer");
        const { buildConfigNodeVideoOperationOptions, CanvasConfigNodePanel } = await import("../src/components/canvas/canvas-config-node-panel");
        const { CanvasNodePromptPanel } = await import("../src/components/canvas/canvas-node-prompt-panel");
        const { CanvasH3UnsupportedFrames } = await import("../src/components/canvas/canvas-h3-controls");
        const { CanvasNodeType } = await import("../src/types/canvas");
        const { mergeFetchedChannelModelProfiles } = await import("../src/lib/channel-model-catalog");
        const { defaultModelCapabilityConfig, videoReferencesForOperation } = await import("../src/lib/model-capabilities");
        const { isBeefTVModelRoute, modelCompatibilityError, resolveVideoOperation } = await import("../src/lib/model-selection");
        const { createModelChannel, defaultConfig, normalizeConfigSnapshot } = await import("../src/stores/use-config-store");
        const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

        const wanItem = managedVideoCatalogItem("wan3.0-video");
        const h3MaxOffItem = {
            ...managedVideoCatalogItem("minimax-h3-max"),
            videoCapabilities: { ...managedVideoCatalogItem("minimax-h3-max").videoCapabilities!, middleFrame: false },
        };
        const agnesMidItem = {
            ...wanItem,
            id: "omni-video",
            videoCapabilities: {
                ...wanItem.videoCapabilities!,
                middleFrame: true,
                operationReferences: { image_to_video: { maxImages: 2, maxVideos: 0, maxAudios: 1 } },
            },
        };
        const h3StyleItem = { id: "minimax-h3-max-style-vhs", supportedEndpointTypes: ["openai-video"] };
        const channel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            credentialRef: "beeftv",
            baseUrl: "https://beeftv.app/v1",
            models: ["seedream-5.0", "wan3.0-video", "minimax-h3-max", "omni-video", "minimax-h3-max-style-vhs"],
        });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [
            { id: "seedream-5.0", supportedEndpointTypes: ["openai-image"] },
            wanItem,
            h3MaxOffItem,
            agnesMidItem,
            h3StyleItem,
        ]);
        const nextConfig = normalizeConfigSnapshot({
            config: {
                ...defaultConfig,
                channels: [channel],
                imageModel: "beeftv::seedream-5.0",
                videoModel: "beeftv::wan3.0-video",
            },
        }).config;
        const twoComposerInputs = [
            { nodeId: "img-1", type: "image" as const, title: "分镜1", image: { id: "img-1", name: "1.png", type: "image/png", dataUrl: "https://example.com/1.png", position: { x: 0, y: 0 } } },
            { nodeId: "img-2", type: "image" as const, title: "分镜2", image: { id: "img-2", name: "2.png", type: "image/png", dataUrl: "https://example.com/2.png", position: { x: 0, y: 0 } } },
        ];
        const html = renderToStaticMarkup(
            <CanvasConfigComposer
                config={nextConfig}
                value="主角转身"
                generationMode="video"
                model="beeftv::seedream-5.0"
                metadata={{ model: "beeftv::seedream-5.0", videoEditOperation: "image_to_video" }}
                inputs={twoComposerInputs}
                onChange={() => {}}
                onMetadataChange={() => {}}
                onClose={() => {}}
            />,
        );
        expect(html).toContain("首尾帧");
        expect(html).toContain("全能参考");
        expect(html).toContain("尾帧");

        const agnesMidHtml = renderToStaticMarkup(
            <CanvasConfigComposer
                config={{ ...nextConfig, videoModel: "beeftv::omni-video" }}
                value="镜头推进"
                generationMode="video"
                model="beeftv::omni-video"
                metadata={{ model: "beeftv::omni-video", videoEditOperation: "reference_to_video" }}
                inputs={twoComposerInputs}
                onChange={() => {}}
                onMetadataChange={() => {}}
                onClose={() => {}}
            />,
        );
        expect(agnesMidHtml).toContain("中间帧");

        const h3MaxOffComposerHtml = renderToStaticMarkup(
            <CanvasConfigComposer
                config={{ ...nextConfig, videoModel: "beeftv::minimax-h3-max" }}
                value="镜头推进"
                generationMode="video"
                model="beeftv::minimax-h3-max"
                metadata={{ model: "beeftv::minimax-h3-max", videoEditOperation: "image_to_video" }}
                inputs={twoComposerInputs}
                onChange={() => {}}
                onMetadataChange={() => {}}
                onClose={() => {}}
            />,
        );
        expect(h3MaxOffComposerHtml).not.toContain("中间帧");

        const queryClient = new QueryClient();
        const h3MaxOffNode = {
            id: "vid-node",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 0 },
            width: 240,
            height: 180,
            metadata: {
                model: "beeftv::minimax-h3-max",
                prompt: "测试",
                videoStartFrameNodeId: "img-1",
                videoEndFrameNodeId: "img-2",
            },
        };
        const twoRefs = makeImageRefs(2);
        const h3MaxOffPromptPanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={queryClient}>
                <CanvasNodePromptPanel
                    config={{ ...nextConfig, model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max" }}
                    projectId="proj-1"
                    node={h3MaxOffNode}
                    {...buildReferenceGraph(h3MaxOffNode, twoRefs)}
                    isRunning={false}
                    mentionReferences={twoRefs}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(h3MaxOffPromptPanelHtml).not.toContain("展开参数");

        const agnesMidNode = {
            id: "vid-node-omni",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 0 },
            width: 240,
            height: 180,
            metadata: { model: "beeftv::omni-video", prompt: "测试", videoEditOperation: "reference_to_video" },
        };
        const fiveRefs = makeImageRefs(5);
        const agnesMidPromptPanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={queryClient}>
                <CanvasNodePromptPanel
                    config={{ ...nextConfig, model: "beeftv::omni-video", videoModel: "beeftv::omni-video" }}
                    projectId="proj-1"
                    node={agnesMidNode}
                    {...buildReferenceGraph(agnesMidNode, fiveRefs)}
                    isRunning={false}
                    mentionReferences={fiveRefs}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(agnesMidPromptPanelHtml).toContain("展开参数");
        expect(agnesMidPromptPanelHtml).not.toContain("写入提示词首帧");

        const styleSingleImgOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::minimax-h3-max-style-vhs" },
            { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 },
        );
        expect(styleSingleImgOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(false);

        const styleTwoImgOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::minimax-h3-max-style-vhs" },
            { textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 },
        );
        expect(styleTwoImgOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(true);

        const styleOneAudioOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::minimax-h3-max-style-vhs" },
            { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 1, characterCount: 0 },
        );
        expect(styleOneAudioOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(true);

        const agnesOneAudioOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::omni-video" },
            { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 1, characterCount: 0 },
        );
        expect(agnesOneAudioOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(false);

        const agnesTwoAudioOptions = buildConfigNodeVideoOperationOptions(
            { ...nextConfig, model: "beeftv::omni-video" },
            { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 2, characterCount: 0 },
        );
        expect(agnesTwoAudioOptions.find((item) => item.value === "image_to_video")?.disabled).toBe(true);

        expect(
            resolveVideoOperation(
                { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 2, characterCount: 0 },
                "image_to_video",
                { ...managedVideoCatalogItem("minimax-h3").videoCapabilities!, operationReferences: { image_to_video: { maxImages: 2 } } },
                "beeftv::minimax-h3",
                true,
            ),
        ).toBe("image_to_video");
        expect(
            resolveVideoOperation(
                { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 2, characterCount: 0 },
                "image_to_video",
                { ...managedVideoCatalogItem("minimax-h3").videoCapabilities!, operationReferences: {} },
                "beeftv::minimax-h3",
                true,
            ),
        ).toBe("image_to_video");
        expect(
            resolveVideoOperation(
                { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 1, characterCount: 0 },
                "image_to_video",
                managedVideoCatalogItem("minimax-h3").videoCapabilities!,
                "custom::minimax-h3",
                false,
            ),
        ).toBe("reference_to_video");

        const customDupChannel = createModelChannel({
            id: "custom-dup",
            name: "Custom Dup",
            baseUrl: "https://custom.example/v1",
            models: ["minimax-h3-max", "kling-video-v3"],
        });
        const beeftvWithKlingChannel = createModelChannel({
            ...channel,
            models: [...channel.models, "kling-video-v3"],
        });
        expect(isBeefTVModelRoute("minimax-h3-max")).toBe(false);
        expect(isBeefTVModelRoute("minimax-h3-max", defaultConfig)).toBe(false);
        expect(isBeefTVModelRoute("minimax-h3-max", { ...defaultConfig, baseUrl: "https://beeftv.app/v1" })).toBe(true);
        expect(isBeefTVModelRoute("minimax-h3-max", nextConfig)).toBe(false);
        expect(isBeefTVModelRoute("kling-video-v3", { ...nextConfig, channels: [beeftvWithKlingChannel, customDupChannel] })).toBe(false);
        expect(isBeefTVModelRoute("minimax-h3-max", { ...nextConfig, channels: [customDupChannel, beeftvWithKlingChannel] })).toBe(false);
        expect(isBeefTVModelRoute("custom::removed-model", nextConfig)).toBe(false);
        expect(isBeefTVModelRoute("beeftv::removed-model", nextConfig)).toBe(false);
        expect(isBeefTVModelRoute("beeftv::wan3.0-video", nextConfig)).toBe(true);

        const baseUnversionedCap = defaultModelCapabilityConfig("newapi-channel-2", "minimax-h3-max");
        const unversionedBeeftvChannel = createModelChannel({
            id: "my-beeftv",
            name: "My BeefTV",
            baseUrl: "https://beeftv.app/v1",
            models: ["minimax-h3-max", "minimax-h3"],
        });
        unversionedBeeftvChannel.modelProfiles = [
            {
                model: "minimax-h3-max",
                capability: "video",
                protocol: "newapi-channel-2",
                capabilitySource: "user",
                capabilityConfig: {
                    ...baseUnversionedCap,
                    video: { ...baseUnversionedCap.video!, middleFrame: false, operationReferences: {} },
                },
            },
            {
                model: "minimax-h3",
                capability: "video",
                protocol: "newapi-channel-2",
                capabilitySource: "user",
                capabilityConfig: {
                    ...baseUnversionedCap,
                    video: {
                        ...baseUnversionedCap.video!,
                        references: { ...baseUnversionedCap.video!.references, maxAudios: 3 },
                        operationReferences: { image_to_video: { maxImages: 2 } },
                    },
                },
            },
        ];
        const unversionedNormalized = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [unversionedBeeftvChannel], model: "my-beeftv::minimax-h3-max", videoModel: "my-beeftv::minimax-h3-max" },
        }).config;
        const normalizedH3Max = unversionedNormalized.channels[0]!.modelProfiles!.find((p) => p.model === "minimax-h3-max")!.capabilityConfig!.video!;
        expect(normalizedH3Max.middleFrame).toBe(false);
        expect(normalizedH3Max.operationReferences).toEqual({});
        const normalizedH3 = unversionedNormalized.channels[0]!.modelProfiles!.find((p) => p.model === "minimax-h3")!.capabilityConfig!.video!;
        expect(normalizedH3.operationReferences).toEqual({ image_to_video: { maxImages: 2 } });
        expect(videoReferencesForOperation(normalizedH3, "image_to_video").maxAudios).toBe(3);

        const frameOnlyMax9Cap = defaultModelCapabilityConfig("openai-videos", "frame9-video");
        frameOnlyMax9Cap.video = {
            ...frameOnlyMax9Cap.video!,
            operations: ["text_to_video", "image_to_video"],
            references: { ...frameOnlyMax9Cap.video!.references, maxImages: 9, maxVideos: 0, maxAudios: 0 },
        };
        const frame9Channel = createModelChannel({
            id: "custom-frame9",
            name: "Custom Frame9",
            baseUrl: "https://custom.example/v1",
            models: ["frame9-video"],
        });
        frame9Channel.modelProfiles = [
            { model: "frame9-video", capability: "video", protocol: "openai-videos", capabilitySource: "user", capabilityConfig: frameOnlyMax9Cap },
        ];
        const frame9Config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [frame9Channel], model: "custom-frame9::frame9-video", videoModel: "custom-frame9::frame9-video" },
        }).config;
        const threeImagesInput = { textCount: 1, imageCount: 3, videoCount: 0, audioCount: 0, characterCount: 0 };
        expect(resolveVideoOperation(threeImagesInput, undefined, frameOnlyMax9Cap.video, "custom-frame9::frame9-video", false)).toBe("reference_to_video");
        expect(resolveVideoOperation(threeImagesInput, "reference_to_video", frameOnlyMax9Cap.video, "beeftv::minimax-h3-max-turbo", true)).toBe("reference_to_video");
        expect(modelCompatibilityError(frame9Config, "custom-frame9::frame9-video", { capability: "video", input: threeImagesInput })).toBe("最多支持 2 张参考图");

        expect(
            renderToStaticMarkup(
                <CanvasH3UnsupportedFrames
                    model="beeftv::minimax-h3-max"
                    metadata={{ videoMiddleFrameNodeId: "img-2", videoMiddleFrameTime: 2.5 }}
                    middleFrameSupported
                    endFrameSupported
                    onChange={() => {}}
                />,
            ),
        ).toBe("");
        expect(
            renderToStaticMarkup(
                <CanvasH3UnsupportedFrames
                    model="beeftv::minimax-h3-max"
                    metadata={{ videoMiddleFrameNodeId: "img-2", videoMiddleFrameTime: 2.5 }}
                    middleFrameSupported={false}
                    endFrameSupported
                    onChange={() => {}}
                />,
            ),
        ).toContain("清除不支持的帧设置");

        const liveH3MaxChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            apiKey: "synthetic-ui-test-key",
            baseUrl: "https://beeftv.app/v1",
            models: ["minimax-h3-max"],
        });
        liveH3MaxChannel.modelProfiles = mergeFetchedChannelModelProfiles(liveH3MaxChannel, [managedVideoCatalogItem("minimax-h3-max")]);
        const liveH3MaxConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [liveH3MaxChannel], model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max", videoSeconds: "5" },
        }).config;
        const offH3MaxChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            apiKey: "synthetic-ui-test-key",
            baseUrl: "https://beeftv.app/v1",
            models: ["minimax-h3-max"],
        });
        offH3MaxChannel.modelProfiles = mergeFetchedChannelModelProfiles(offH3MaxChannel, [h3MaxOffItem]);
        const offH3MaxConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [offH3MaxChannel], model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max", videoSeconds: "5" },
        }).config;
        const h3MidMetadata = {
            generationMode: "video" as const,
            model: "beeftv::minimax-h3-max",
            prompt: "测试",
            videoStartFrameNodeId: "img-1",
            videoMiddleFrameNodeId: "img-2",
            videoEndFrameNodeId: "img-3",
            videoMiddleFrameTime: 2.5,
        };
        const threeRefs = makeImageRefs(3);
        const supportedNode = { id: "vid-h3-on", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: h3MidMetadata };
        const supportedPromptPanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={queryClient}>
                <CanvasNodePromptPanel
                    config={liveH3MaxConfig}
                    projectId="proj-1"
                    node={supportedNode}
                    {...buildReferenceGraph(supportedNode, threeRefs)}
                    isRunning={false}
                    mentionReferences={threeRefs}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(supportedPromptPanelHtml).toContain("展开参数");
        expect(supportedPromptPanelHtml).not.toContain("写入提示词首帧");

        const unsupportedNode = { id: "vid-h3-off", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: h3MidMetadata };
        const unsupportedPromptPanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={queryClient}>
                <CanvasNodePromptPanel
                    config={offH3MaxConfig}
                    projectId="proj-1"
                    node={unsupportedNode}
                    {...buildReferenceGraph(unsupportedNode, threeRefs)}
                    isRunning={false}
                    mentionReferences={threeRefs}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(unsupportedPromptPanelHtml).not.toContain("展开参数");

        const supportedConfigNodeHtml = renderToStaticMarkup(
            <CanvasConfigNodePanel
                config={liveH3MaxConfig}
                node={{ id: "cfg-h3-on", type: CanvasNodeType.Config, title: "Config", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: h3MidMetadata }}
                isRunning={false}
                inputSummary={{ textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 }}
                onConfigChange={() => {}}
                onGenerate={() => {}}
                onComposerToggle={() => {}}
            />,
        );
        expect(supportedConfigNodeHtml).toContain("提示词增强");
        expect(supportedConfigNodeHtml).not.toContain("清除不支持的帧设置");

        const unsupportedConfigNodeHtml = renderToStaticMarkup(
            <CanvasConfigNodePanel
                config={offH3MaxConfig}
                node={{ id: "cfg-h3-off", type: CanvasNodeType.Config, title: "Config", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: h3MidMetadata }}
                isRunning={false}
                inputSummary={{ textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 }}
                onConfigChange={() => {}}
                onGenerate={() => {}}
                onComposerToggle={() => {}}
            />,
        );
        expect(unsupportedConfigNodeHtml).toContain("提示词增强");
        expect(unsupportedConfigNodeHtml).toContain("清除不支持的帧设置");
    });
});
