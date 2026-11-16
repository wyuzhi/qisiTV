import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { canvasThemes } from "../src/lib/canvas-theme";
import { ConnectedReferenceShelf, VideoReferenceModeSwitch } from "../src/components/canvas/canvas-node-reference-shelf";
import { findPromptFirstFrameNodeId, resolveVideoReferenceCapabilities, resolveVideoReferenceModeState, stripPromptFirstFrameClauses } from "../src/lib/canvas/video-reference-mode";
import { managedVideoCatalogItem } from "./managed-video-fixture";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";

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

describe("resolveVideoReferenceModeState", () => {
    test("1–2 张参考图默认进入首尾帧模式并推导首帧/尾帧角色，支持切换到全能参考", () => {
        const oneImageState = resolveVideoReferenceModeState({
            references: makeImageRefs(1),
        });
        expect(oneImageState.mode).toBe("frames");
        expect(oneImageState.canSelectFrames).toBe(true);
        expect(oneImageState.canSelectAll).toBe(true);
        expect(oneImageState.startFrameNodeId).toBe("img-1");
        expect(oneImageState.endFrameNodeId).toBeUndefined();

        const twoImageState = resolveVideoReferenceModeState({
            references: makeImageRefs(2),
        });
        expect(twoImageState.mode).toBe("frames");
        expect(twoImageState.canSelectFrames).toBe(true);
        expect(twoImageState.startFrameNodeId).toBe("img-1");
        expect(twoImageState.endFrameNodeId).toBe("img-2");

        const switchedToAll = resolveVideoReferenceModeState({
            references: makeImageRefs(2),
            metadata: { videoEditOperation: "reference_to_video" },
        });
        expect(switchedToAll.mode).toBe("all");
        expect(switchedToAll.canSelectFrames).toBe(true);
        expect(switchedToAll.startFrameNodeId).toBeUndefined();
        expect(switchedToAll.endFrameNodeId).toBeUndefined();
    });

    test("3 张及以上参考图或包含视频/音频时自动锁定全能参考并给出禁用原因", () => {
        const fiveImageState = resolveVideoReferenceModeState({
            references: makeImageRefs(5),
        });
        expect(fiveImageState.mode).toBe("all");
        expect(fiveImageState.canSelectFrames).toBe(false);
        expect(fiveImageState.framesDisabledReason).toContain("1–2 张图");

        const videoRefState = resolveVideoReferenceModeState({
            references: [
                ...makeImageRefs(1),
                { nodeId: "vid-1", kind: "video", label: "视频1", title: "参考视频", active: true },
            ],
        });
        expect(videoRefState.mode).toBe("all");
        expect(videoRefState.canSelectFrames).toBe(false);
        expect(videoRefState.framesDisabledReason).toContain("参考视频");

        const characterRefState = resolveVideoReferenceModeState({
            references: [
                ...makeImageRefs(1),
                { nodeId: "char-1", kind: "character", label: "角色1", title: "主角卡", active: true },
            ],
        });
        expect(characterRefState.mode).toBe("all");
        expect(characterRefState.canSelectFrames).toBe(false);
        expect(characterRefState.framesDisabledReason).toContain("角色卡");

        const noRefVideoModelState = resolveVideoReferenceModeState({
            references: makeImageRefs(1),
            referenceVideoSupported: false,
            endFrameSupported: false,
        });
        expect(noRefVideoModelState.mode).toBe("frames");
        expect(noRefVideoModelState.canSelectAll).toBe(false);
        expect(noRefVideoModelState.endFrameSupported).toBe(false);
        expect(
            renderToStaticMarkup(
                <VideoReferenceModeSwitch state={noRefVideoModelState} theme={canvasThemes.dark} onChange={() => {}} />,
            ),
        ).toBe("");

        // 万相 3.0 / Kling v3 / H3 Max Turbo / 带版本号 H3 等统一驱动首尾帧、全能参考与中间帧开关
        const wanCaps = resolveVideoReferenceCapabilities("beeftv::wan3.0-video", managedVideoCatalogItem("wan3.0-video").videoCapabilities, true);
        expect(wanCaps).toEqual({
            maxFrameImages: 2,
            endFrameSupported: true,
            referenceVideoSupported: true,
            maxFrameAudios: 0,
            middleFrameSupport: "unsupported",
            middleFrameSupported: false,
        });
        const wanWithAudioState = resolveVideoReferenceModeState({
            metadata: { videoEditOperation: "image_to_video", videoStartFrameNodeId: "img-1" },
            references: [
                ...makeImageRefs(2),
                { nodeId: "aud-1", kind: "audio", label: "音频1", title: "旁白", active: true },
            ],
            ...wanCaps,
        });
        expect(wanWithAudioState.mode).toBe("all");
        expect(wanWithAudioState.canSelectFrames).toBe(false);

        const klingCaps = resolveVideoReferenceCapabilities("beeftv::kling-video-v3", managedVideoCatalogItem("kling-video-v3").videoCapabilities, true);
        expect(klingCaps).toEqual({
            maxFrameImages: 1,
            endFrameSupported: false,
            referenceVideoSupported: false,
            maxFrameAudios: 0,
            middleFrameSupport: "unsupported",
            middleFrameSupported: false,
        });

        const h3TurboCaps = resolveVideoReferenceCapabilities("beeftv::minimax-h3-max-turbo", managedVideoCatalogItem("minimax-h3-max-turbo").videoCapabilities, true);
        expect(h3TurboCaps).toEqual({
            maxFrameImages: 2,
            endFrameSupported: true,
            referenceVideoSupported: false,
            maxFrameAudios: 1,
            middleFrameSupport: "unsupported",
            middleFrameSupported: false,
        });

        // 真实线上目录 minimax-h3（省略 operationReferences）保留首尾帧最多 1 段音频，2 段音频升为全能参考
        const h3LiveCaps = resolveVideoReferenceCapabilities("beeftv::minimax-h3", managedVideoCatalogItem("minimax-h3").videoCapabilities, true);
        expect(h3LiveCaps).toEqual({
            maxFrameImages: 2,
            endFrameSupported: true,
            referenceVideoSupported: true,
            maxFrameAudios: 1,
            middleFrameSupport: "unsupported",
            middleFrameSupported: false,
        });
        const h3OneAudioState = resolveVideoReferenceModeState({
            references: [...makeImageRefs(1), { nodeId: "aud-1", kind: "audio", label: "音频1", title: "对白", active: true }],
            h3Model: true,
            ...h3LiveCaps,
        });
        expect(h3OneAudioState.mode).toBe("frames");
        expect(h3OneAudioState.canSelectFrames).toBe(true);
        const h3TwoAudioState = resolveVideoReferenceModeState({
            references: [
                ...makeImageRefs(1),
                { nodeId: "aud-1", kind: "audio", label: "音频1", title: "对白", active: true },
                { nodeId: "aud-2", kind: "audio", label: "音频2", title: "环境音", active: true },
            ],
            h3Model: true,
            ...h3LiveCaps,
        });
        expect(h3TwoAudioState.mode).toBe("all");
        expect(h3TwoAudioState.canSelectFrames).toBe(false);

        // 真实线上目录 minimax-h3-max（省略 middleFrame）从契约补齐中间帧支持；显式 middleFrame: false 强制关闭
        const h3MaxLiveCaps = resolveVideoReferenceCapabilities("beeftv::minimax-h3-max", managedVideoCatalogItem("minimax-h3-max").videoCapabilities, true);
        expect(h3MaxLiveCaps.middleFrameSupport).toBe("supported");
        expect(h3MaxLiveCaps.middleFrameSupported).toBe(true);
        const h3MaxExplicitOffCaps = resolveVideoReferenceCapabilities(
            "beeftv::minimax-h3-max",
            { ...managedVideoCatalogItem("minimax-h3-max").videoCapabilities!, middleFrame: false },
            true,
        );
        expect(h3MaxExplicitOffCaps.middleFrameSupport).toBe("unsupported");
        expect(h3MaxExplicitOffCaps.middleFrameSupported).toBe(false);

        // 自定义/BYOK 渠道同名模型不套用 BeefTV 渠道契约
        const customH3MaxCaps = resolveVideoReferenceCapabilities("custom::minimax-h3-max", managedVideoCatalogItem("minimax-h3").videoCapabilities, true);
        expect(customH3MaxCaps.middleFrameSupport).toBe("unsupported");
        expect(customH3MaxCaps.middleFrameSupported).toBe(false);
        expect(customH3MaxCaps.maxFrameAudios).toBe(0);
        const customKlingCaps = resolveVideoReferenceCapabilities(
            "custom::kling-video-v3",
            {
                ...managedVideoCatalogItem("kling-video-v3").videoCapabilities!,
                references: { ...managedVideoCatalogItem("kling-video-v3").videoCapabilities!.references, maxImages: 2, maxAudios: 1 },
            },
            true,
        );
        expect(customKlingCaps.maxFrameImages).toBe(2);
        expect(customKlingCaps.endFrameSupported).toBe(true);
        expect(customKlingCaps.maxFrameAudios).toBe(1);

        // 显式部分或空 operationReferences 继承模型级 references 上限，不回退到契约上限
        const partialOpRefCaps = resolveVideoReferenceCapabilities(
            "beeftv::minimax-h3",
            { ...managedVideoCatalogItem("minimax-h3").videoCapabilities!, operationReferences: { image_to_video: { maxImages: 2 } } },
            true,
        );
        expect(partialOpRefCaps.maxFrameAudios).toBe(3);
        const emptyOpRefCaps = resolveVideoReferenceCapabilities(
            "beeftv::minimax-h3",
            { ...managedVideoCatalogItem("minimax-h3").videoCapabilities!, operationReferences: {} },
            true,
        );
        expect(emptyOpRefCaps.maxFrameAudios).toBe(3);
    });
});

describe("stripPromptFirstFrameClauses", () => {
    test("识别并清理历史提示词开头或句中遗留的「作为首帧」子句", () => {
        const refs = makeImageRefs(5);
        const withImg5 = "@[node:img-5] 作为首帧，镜头推进，树藤疯狂生长";
        expect(findPromptFirstFrameNodeId(withImg5, refs)).toBe("img-5");
        expect(stripPromptFirstFrameClauses(withImg5)).toBe("镜头推进，树藤疯狂生长");

        const midSentencePrompt = "镜头推进，@[node:img-1] 作为首帧，树藤疯狂生长";
        expect(findPromptFirstFrameNodeId(midSentencePrompt, refs)).toBe("img-1");
        expect(stripPromptFirstFrameClauses(midSentencePrompt)).toBe("镜头推进，树藤疯狂生长");

        const withAlias = "@iMaGe1 作为首帧，镜头推进";
        expect(findPromptFirstFrameNodeId(withAlias, refs)).toBe("img-1");
        expect(stripPromptFirstFrameClauses(withAlias)).toBe("镜头推进");

        const withShortZhAlias = "镜头推进，@图2 作为首帧，保持构图";
        expect(findPromptFirstFrameNodeId(withShortZhAlias, refs)).toBe("img-2");
        expect(stripPromptFirstFrameClauses(withShortZhAlias)).toBe("镜头推进，保持构图");

        const multilineLeading = "\n@iMaGe1 作为首帧\n镜头推进";
        expect(stripPromptFirstFrameClauses(multilineLeading)).toBe("镜头推进");
        const midNewline = "景别切换\n@iMaGe1 作为首帧\n镜头推进";
        expect(stripPromptFirstFrameClauses(midNewline)).toBe("景别切换\n镜头推进");
    });
});

describe("buildVideoGenerationMetadata default frame roles", () => {
    test("首尾帧模式未显式写入节点 ID 时默认按连接顺序补齐首帧与尾帧，角色图/音频参考或断开旧帧时不误设", async () => {
        const { buildVideoGenerationMetadata } = await import("../src/lib/canvas/canvas-project-generation");
        const { CanvasNodeType } = await import("../src/types/canvas");
        const twoImageNodes = ["img-1", "img-2"].map((id, index) => ({
            id,
            name: `${id}.png`,
            type: "image/png",
            dataUrl: `https://example.com/${id}.png`,
            position: { x: index * 10, y: 0 },
        }));

        const defaultTwoFrameMeta = buildVideoGenerationMetadata(
            {
                id: "vid-1",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5" },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
        );
        expect(defaultTwoFrameMeta.videoEditOperation).toBe("image_to_video");
        expect(defaultTwoFrameMeta.videoStartFrameNodeId).toBe("img-1");
        expect(defaultTwoFrameMeta.videoEndFrameNodeId).toBe("img-2");

        const singleEndFrameMeta = buildVideoGenerationMetadata(
            {
                id: "vid-2",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5", videoEndFrameNodeId: "img-1" },
            },
            { referenceImages: [twoImageNodes[0]!], referenceVideos: [], referenceAudios: [] },
        );
        expect(singleEndFrameMeta.videoEditOperation).toBe("image_to_video");
        expect(singleEndFrameMeta.videoStartFrameNodeId).toBeUndefined();
        expect(singleEndFrameMeta.videoEndFrameNodeId).toBe("img-1");

        const staleFrameDroppedMeta = buildVideoGenerationMetadata(
            {
                id: "vid-stale",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5", videoStartFrameNodeId: "removed-img", videoEndFrameNodeId: "img-1" },
            },
            { referenceImages: [twoImageNodes[0]!], referenceVideos: [], referenceAudios: [] },
        );
        expect(staleFrameDroppedMeta.videoStartFrameNodeId).toBeUndefined();
        expect(staleFrameDroppedMeta.videoEndFrameNodeId).toBe("img-1");

        const withAudioMeta = buildVideoGenerationMetadata(
            {
                id: "vid-audio",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5" },
            },
            { referenceImages: [twoImageNodes[0]!], referenceVideos: [], referenceAudios: [{ id: "aud-1", name: "a.mp3", type: "audio/mpeg", dataUrl: "" }] },
        );
        expect(withAudioMeta.videoStartFrameNodeId).toBeUndefined();

        const withCharacterImageMeta = buildVideoGenerationMetadata(
            {
                id: "vid-char",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::seedance-2.5" },
            },
            {
                referenceImages: [
                    twoImageNodes[0]!,
                    { id: "character-reference-1", sourceNodeId: "char-1", name: "char.png", type: "image/png", dataUrl: "" },
                ],
                referenceVideos: [],
                referenceAudios: [],
            },
        );
        expect(withCharacterImageMeta.videoStartFrameNodeId).toBeUndefined();
        expect(withCharacterImageMeta.videoEndFrameNodeId).toBeUndefined();

        // 从 H3 Max 切到已声明不支持中间帧的模型时清除残留中间帧字段；部分 AiConfig 缺省字段不抛错，未声明自定义渠道保留自定义中间帧
        const { mergeFetchedChannelModelProfiles } = await import("../src/lib/channel-model-catalog");
        const { createModelChannel, defaultConfig, normalizeConfigSnapshot } = await import("../src/stores/use-config-store");
        const { defaultModelCapabilityConfig } = await import("../src/lib/model-capabilities");
        const beeftvChannel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            scope: "system",
            pinned: true,
            credentialRef: "beeftv",
            baseUrl: "https://beeftv.app/v1",
            models: ["wan3.0-video", "minimax-h3-max"],
        });
        beeftvChannel.modelProfiles = mergeFetchedChannelModelProfiles(beeftvChannel, [
            managedVideoCatalogItem("wan3.0-video"),
            managedVideoCatalogItem("minimax-h3-max"),
        ]);
        const declaredWanConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::wan3.0-video", videoModel: "beeftv::wan3.0-video" },
        }).config;

        const switchedFromH3Meta = buildVideoGenerationMetadata(
            {
                id: "vid-from-h3",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: {
                    model: "beeftv::wan3.0-video",
                    videoEditOperation: "image_to_video",
                    videoStartFrameNodeId: "img-1",
                    videoMiddleFrameNodeId: "img-2",
                    videoMiddleFrameTime: 1.8,
                },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
            declaredWanConfig,
        );
        expect(switchedFromH3Meta.videoEditOperation).toBe("image_to_video");
        expect(switchedFromH3Meta.videoStartFrameNodeId).toBe("img-1");
        expect(switchedFromH3Meta.videoMiddleFrameNodeId).toBeUndefined();
        expect(switchedFromH3Meta.videoMiddleFrameTime).toBeUndefined();

        const switchedFromH3OrderMeta = buildVideoGenerationMetadata(
            {
                id: "vid-wan-from-h3-order",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: {
                    model: "beeftv::wan3.0-video",
                    videoEditOperation: "reference_to_video",
                    videoReferenceOrder: ["img-2", "img-1"],
                    videoH3Options: { seed: 9 },
                },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
            declaredWanConfig,
        );
        expect(switchedFromH3OrderMeta.videoEditOperation).toBe("reference_to_video");
        expect(switchedFromH3OrderMeta.videoReferenceOrder).toBeUndefined();
        expect(switchedFromH3OrderMeta.videoH3Options).toBeUndefined();

        const omittedConfigWanMeta = buildVideoGenerationMetadata(
            {
                id: "vid-wan-no-cfg",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: {
                    model: "beeftv::wan3.0-video",
                    videoEditOperation: "reference_to_video",
                    videoReferenceOrder: ["img-2", "img-1"],
                },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
        );
        expect(omittedConfigWanMeta.videoReferenceOrder).toBeUndefined();

        const h3BaseOrderMeta = buildVideoGenerationMetadata(
            {
                id: "vid-h3-base-order",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: {
                    model: "beeftv::minimax-h3",
                    videoEditOperation: "reference_to_video",
                    videoReferenceOrder: ["img-2", "img-1"],
                    videoH3Options: { seed: 5 },
                },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
        );
        expect(h3BaseOrderMeta.videoReferenceOrder).toBeUndefined();
        expect(h3BaseOrderMeta.videoH3Options).toEqual({ seed: 5 });

        const h3MaxOrderMeta = buildVideoGenerationMetadata(
            {
                id: "vid-h3-max-order",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: {
                    model: "beeftv::minimax-h3-max",
                    videoEditOperation: "reference_to_video",
                    videoReferenceOrder: ["img-2", "img-1"],
                },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
        );
        expect(h3MaxOrderMeta.videoReferenceOrder).toEqual(["img-2", "img-1"]);

        const partialConfigMeta = buildVideoGenerationMetadata(
            {
                id: "vid-partial-cfg",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::wan3.0-video", videoEditOperation: "image_to_video", videoStartFrameNodeId: "img-1" },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
            { model: "beeftv::wan3.0-video", videoReturnLastFrame: false } as never,
        );
        expect(partialConfigMeta.videoStartFrameNodeId).toBe("img-1");

        const customChannel = createModelChannel({
            id: "custom",
            name: "Custom",
            baseUrl: "https://custom.example/v1",
            models: ["opaque-video"],
        });
        customChannel.modelProfiles = [
            {
                model: "opaque-video",
                capability: "video",
                protocol: "openai-videos",
                capabilityConfig: defaultModelCapabilityConfig(),
            },
        ];
        const opaqueCustomConfig = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [customChannel], model: "custom::opaque-video", videoModel: "custom::opaque-video" },
        }).config;
        const opaqueCustomMeta = buildVideoGenerationMetadata(
            {
                id: "vid-opaque",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: {
                    model: "custom::opaque-video",
                    videoEditOperation: "reference_to_video",
                    videoStartFrameNodeId: "img-1",
                    videoMiddleFrameNodeId: "img-2",
                    videoMiddleFrameTime: 2.5,
                },
            },
            { referenceImages: twoImageNodes, referenceVideos: [], referenceAudios: [] },
            opaqueCustomConfig,
        );
        expect(opaqueCustomMeta.videoEditOperation).toBe("reference_to_video");
        expect(opaqueCustomMeta.videoMiddleFrameNodeId).toBe("img-2");
        expect(opaqueCustomMeta.videoMiddleFrameTime).toBe(2.5);
    });
});

describe("VideoReferenceModeSwitch & ConnectedReferenceShelf UI", () => {
    test("首尾帧模式渲染 [首尾帧 | 全能参考] 切换器、缩略图首帧/尾帧角标与 ⇄ 互换按钮", () => {
        const refs = makeImageRefs(2);
        const state = resolveVideoReferenceModeState({ references: refs });
        const switchHtml = renderToStaticMarkup(
            <VideoReferenceModeSwitch state={state} theme={canvasThemes.dark} onChange={() => {}} />,
        );
        expect(switchHtml).toContain("首尾帧");
        expect(switchHtml).toContain("全能参考");

        const shelfHtml = renderToStaticMarkup(
            <ConnectedReferenceShelf
                references={refs}
                theme={canvasThemes.dark}
                videoModeState={state}
                onInsert={() => {}}
                onVideoMetadataChange={() => {}}
            />,
        );
        expect(shelfHtml).toContain("首帧");
        expect(shelfHtml).toContain("尾帧");
        expect(shelfHtml).toContain("互换首尾帧");
    });

    test("单张参考图已为首帧时角标锁定不可翻转，历史尾帧状态仍可点击恢复首帧", () => {
        const refs = makeImageRefs(1);
        const startState = resolveVideoReferenceModeState({ references: refs });
        const startHtml = renderToStaticMarkup(
            <ConnectedReferenceShelf
                references={refs}
                theme={canvasThemes.dark}
                videoModeState={startState}
                onInsert={() => {}}
                onVideoMetadataChange={() => {}}
            />,
        );
        expect(startHtml).toContain('data-reference-frame-role="first_frame"');
        expect(startHtml).toContain("cursor-default");
        expect(startHtml).not.toContain("切换为尾帧");

        const legacyEndState = resolveVideoReferenceModeState({
            references: refs,
            metadata: { videoEndFrameNodeId: "img-1" },
        });
        const endHtml = renderToStaticMarkup(
            <ConnectedReferenceShelf
                references={refs}
                theme={canvasThemes.dark}
                videoModeState={legacyEndState}
                onInsert={() => {}}
                onVideoMetadataChange={() => {}}
            />,
        );
        expect(endHtml).toContain('data-reference-frame-role="last_frame"');
        expect(endHtml).toContain("cursor-pointer");
    });

    test("全能参考模式不渲染误导性的首帧按钮，改为在自定义命名素材上展示固定槽位角标", () => {
        const refs = makeImageRefs(5);
        const unnamedRef: CanvasResourceReference = {
            id: "img-6",
            nodeId: "img-6",
            kind: "image",
            label: "图片6",
            title: "图片6",
            active: true,
            previewUrl: "https://example.com/img-6.png",
        };
        const state = resolveVideoReferenceModeState({ references: [...refs, unnamedRef] });
        const shelfHtml = renderToStaticMarkup(
            <ConnectedReferenceShelf
                references={[...refs, unnamedRef]}
                theme={canvasThemes.dark}
                videoModeState={state}
                onInsert={() => {}}
            />,
        );
        expect(shelfHtml).not.toContain("data-reference-omni-first-frame");
        expect(shelfHtml).not.toContain("提示词首帧");
        expect(shelfHtml).toContain('data-reference-slot-label="图片1"');
        expect(shelfHtml).toContain('data-reference-slot-label="图片5"');
        // 未自定义标题、displayName 已等于 图片6 的筹码不再重复渲染第二份槽位角标
        expect(shelfHtml).not.toContain('data-reference-slot-label="图片6"');
    });
});
