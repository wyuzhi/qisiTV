import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { canvasThemes } from "../src/lib/canvas-theme";
import { CanvasNodePromptPanel } from "../src/components/canvas/canvas-node-prompt-panel";
import { CanvasNodePromptWarnings } from "../src/components/canvas/canvas-node-prompt-panel-controls";
import { InactiveVideoPreview } from "../src/components/canvas/canvas-node-content";
import { buildNodeGenerationContext, resolveCanvasNodeGenerationPreview } from "../src/components/canvas/canvas-node-generation";
import { ModelPicker } from "../src/components/model-picker";
import { VideoSettingsPanel } from "../src/components/video-settings-panel";
import { notifyCanvasPopoverOpen, subscribeCanvasPopoverOpen } from "../src/lib/canvas/canvas-popover-layer";
import { buildVideoGenerationMetadata } from "../src/lib/canvas/canvas-project-generation";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";
import { mergeFetchedChannelModelProfiles } from "../src/lib/channel-model-catalog";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities-image";
import { formatReferenceUploadProgressDetail } from "../src/lib/operation-progress";
import { useAssetStore } from "../src/stores/use-asset-store";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";
import { CanvasNodeType } from "../src/types/canvas";
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

const edgesTo = (targetId: string, sourceIds: string[]) =>
    sourceIds.map((fromNodeId, idx) => ({ id: `e-${targetId}-${idx}`, fromNodeId, toNodeId: targetId }));

function createFixtureConfigs() {
    const beeftvChannel = createModelChannel({
        id: "beeftv",
        name: "BeefTV",
        scope: "system",
        pinned: true,
        credentialRef: "beeftv",
        baseUrl: "https://beeftv.app/v1",
        models: ["minimax-h3-max", "wan3.0-video", "single-frame-video", "single-ref-image", "text-only-image", "multi-ref-image"],
    });
    const singleFrameOnlyItem = {
        ...managedVideoCatalogItem("wan3.0-video"),
        id: "single-frame-video",
        displayName: "Single Frame Video",
        videoCapabilities: {
            ...managedVideoCatalogItem("wan3.0-video").videoCapabilities!,
            operations: ["text_to_video", "image_to_video"],
            ratios: ["auto", "adaptive", "16:9"],
            references: { minImages: 0, maxImages: 1, maxVideos: 0, maxAudios: 0 },
            operationReferences: { image_to_video: { minImages: 1, maxImages: 1, maxVideos: 0, maxAudios: 0 } },
        },
    };
    const baseImgCap = defaultImageCapabilityConfig();
    const singleRefImageItem = {
        id: "single-ref-image",
        displayName: "Single Ref Image",
        modelType: "image" as const,
        supportedEndpointTypes: ["openai-image"],
        imageCapabilitiesVersion: "2026-04-01",
        imageCapabilities: { ...baseImgCap, references: { ...baseImgCap.references, maxImages: 1 } },
    };
    const textOnlyImageItem = {
        id: "text-only-image",
        displayName: "Text Only Image",
        modelType: "image" as const,
        supportedEndpointTypes: ["openai-image"],
        imageCapabilitiesVersion: "2026-04-01",
        imageCapabilities: { ...baseImgCap, references: { ...baseImgCap.references, maxImages: 0 } },
    };
    const multiRefImageItem = {
        id: "multi-ref-image",
        displayName: "Multi Ref Image",
        modelType: "image" as const,
        supportedEndpointTypes: ["openai-image"],
        imageCapabilitiesVersion: "2026-04-01",
        imageCapabilities: { ...baseImgCap, references: { ...baseImgCap.references, maxImages: 4 } },
    };
    beeftvChannel.modelProfiles = mergeFetchedChannelModelProfiles(beeftvChannel, [
        managedVideoCatalogItem("minimax-h3-max"),
        managedVideoCatalogItem("wan3.0-video"),
        singleFrameOnlyItem,
        singleRefImageItem,
        textOnlyImageItem,
        multiRefImageItem,
    ]);
    return {
        h3Config: normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::minimax-h3-max", videoModel: "beeftv::minimax-h3-max" },
        }).config,
        wanConfig: normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::wan3.0-video", videoModel: "beeftv::wan3.0-video" },
        }).config,
        singleFrameConfig: normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::single-frame-video", videoModel: "beeftv::single-frame-video" },
        }).config,
        singleRefImageConfig: normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::single-ref-image", imageModel: "beeftv::single-ref-image" },
        }).config,
        textOnlyImageConfig: normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::text-only-image", imageModel: "beeftv::text-only-image" },
        }).config,
        multiRefImageConfig: normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [beeftvChannel], model: "beeftv::multi-ref-image", imageModel: "beeftv::multi-ref-image" },
        }).config,
    };
}

describe("Video & Canvas generation polish regressions", () => {
    test("H3 双图带音频默认补齐首帧/尾帧角色，上传进度文案与媒体文件扩展名保持干净", () => {
        const { h3Config } = createFixtureConfigs();
        const twoImageNodes = ["img-1", "img-2"].map((id, index) => ({
            id,
            name: `${id}.png`,
            type: "image/png",
            dataUrl: `https://example.com/${id}.png`,
            position: { x: index * 10, y: 0 },
        }));
        const h3TwoFramesWithAudio = buildVideoGenerationMetadata(
            {
                id: "vid-h3-pair",
                type: CanvasNodeType.Video,
                title: "Video",
                position: { x: 0, y: 100 },
                width: 100,
                height: 100,
                metadata: { model: "beeftv::minimax-h3-max" },
            },
            {
                referenceImages: twoImageNodes,
                referenceVideos: [],
                referenceAudios: [{ id: "aud-1", name: "voice.mp3", type: "audio/mpeg", url: "https://example.com/voice.mp3" }],
            },
            h3Config,
        );
        expect(h3TwoFramesWithAudio.videoEditOperation).toBe("image_to_video");
        expect(h3TwoFramesWithAudio.videoStartFrameNodeId).toBe("img-1");
        expect(h3TwoFramesWithAudio.videoEndFrameNodeId).toBe("img-2");

        expect(formatReferenceUploadProgressDetail("transferring", "reference")).toBe("正在上传参考素材");
        expect(formatReferenceUploadProgressDetail("processing", "first_frame")).toBe("正在确认首帧参考图");
        expect(formatReferenceUploadProgressDetail("preparing", "reference_audio")).toBe("正在准备参考音频");
        expect(formatReferenceUploadProgressDetail("transferring", "source")).toBe("正在上传源素材");
        expect(formatReferenceUploadProgressDetail("transferring", "edit_source")).toBe("正在上传编辑源图");

        const mediaNodes = [
            { id: "aud-node", type: CanvasNodeType.Audio, title: "sample.mp3", position: { x: 0, y: 0 }, width: 120, height: 80, metadata: { content: "https://example.com/sample.mp3" } },
            { id: "aud-bare", type: CanvasNodeType.Audio, title: "voice", position: { x: 0, y: 50 }, width: 120, height: 80, metadata: { content: "https://example.com/voice" } },
            { id: "vid-node", type: CanvasNodeType.Video, title: "clip.mp4", position: { x: 0, y: 100 }, width: 120, height: 80, metadata: { content: "https://example.com/clip.mp4" } },
            { id: "target-vid", type: CanvasNodeType.Video, title: "Target", position: { x: 200, y: 0 }, width: 320, height: 180, metadata: {} },
        ];
        const genCtx = buildNodeGenerationContext(
            "target-vid",
            mediaNodes,
            [
                { id: "c1", fromNodeId: "aud-node", toNodeId: "target-vid" },
                { id: "c2", fromNodeId: "aud-bare", toNodeId: "target-vid" },
                { id: "c3", fromNodeId: "vid-node", toNodeId: "target-vid" },
            ],
            "@[node:aud-node] @[node:aud-bare] @[node:vid-node]",
            [],
        );
        expect(genCtx.referenceAudios[0]?.name).toBe("sample.mp3");
        expect(genCtx.referenceAudios[1]?.name).toBe("voice.mp3");
        expect(genCtx.referenceVideos[0]?.name).toBe("clip.mp4");
    });

    test("视频节点与 buildNodeGenerationContext 共享全量连线媒体计数，超限模型内联提示并禁用生成", () => {
        const { h3Config, singleFrameConfig } = createFixtureConfigs();
        const fiveImageNodes = Array.from({ length: 5 }, (_, idx) => ({
            id: `img-${idx + 1}`,
            type: CanvasNodeType.Image,
            title: `镜头${idx + 1}`,
            position: { x: idx * 20, y: 0 },
            width: 120,
            height: 80,
            metadata: { content: `https://example.com/img-${idx + 1}.png` },
        }));

        const incompatibleNode = {
            id: "vid-incompatible",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::single-frame-video", prompt: "测试镜头" },
        };
        const twoRefs = makeImageRefs(2);
        const incompatiblePanelHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={incompatibleNode}
                    {...buildReferenceGraph(incompatibleNode, twoRefs)}
                    config={singleFrameConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={twoRefs}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(incompatiblePanelHtml).toContain("最多支持 1 张参考图");
        expect(incompatiblePanelHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const h3VideoTarget = {
            id: "vid-h3-subset",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::minimax-h3-max", prompt: "@[node:img-1] @[node:img-2] 推镜" },
        };
        const h3GraphNodes = [h3VideoTarget, ...fiveImageNodes];
        const h3GraphEdges = edgesTo("vid-h3-subset", fiveImageNodes.map((n) => n.id));
        expect(buildNodeGenerationContext("vid-h3-subset", h3GraphNodes, h3GraphEdges, h3VideoTarget.metadata.prompt, [], true, { preserveMediaBindings: true }).imageCount).toBe(5);
        const h3OverLimitHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={h3VideoTarget}
                    referenceNodes={h3GraphNodes}
                    referenceConnections={h3GraphEdges}
                    config={h3Config}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={makeImageRefs(5)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(h3OverLimitHtml).toContain("最多支持 2 张参考图");
        expect(h3OverLimitHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const textNode = {
            id: "txt-1",
            type: CanvasNodeType.Text,
            title: "分镜脚本",
            position: { x: 100, y: 0 },
            width: 160,
            height: 80,
            metadata: { content: "夜景雨巷" },
        };
        const videoTextTarget = {
            id: "vid-text-only",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::single-frame-video", prompt: "@[node:txt-1] 按分镜生成" },
        };
        const videoTextNodes = [videoTextTarget, ...fiveImageNodes, textNode];
        const videoTextEdges = edgesTo("vid-text-only", [...fiveImageNodes.map((n) => n.id), "txt-1"]);
        expect(buildNodeGenerationContext("vid-text-only", videoTextNodes, videoTextEdges, videoTextTarget.metadata.prompt, [], true, { preserveMediaBindings: true }).imageCount).toBe(5);
        const videoTextOverLimitHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={videoTextTarget}
                    referenceNodes={videoTextNodes}
                    referenceConnections={videoTextEdges}
                    config={singleFrameConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={[
                        ...makeImageRefs(5),
                        { id: "txt-1", nodeId: "txt-1", kind: "text", label: "文本1", title: "分镜脚本", text: "夜景雨巷", active: true },
                    ]}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(videoTextOverLimitHtml).toContain("最多支持 1 张参考图");
        expect(videoTextOverLimitHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);
    });

    test("生图显式 @ 子集/嵌套文本、成片节点重生成与素材库 @[asset:id] 超限判定保持精确", () => {
        const { singleFrameConfig, singleRefImageConfig, textOnlyImageConfig } = createFixtureConfigs();
        const fiveImageNodes = Array.from({ length: 5 }, (_, idx) => ({
            id: `img-${idx + 1}`,
            type: CanvasNodeType.Image,
            title: `镜头${idx + 1}`,
            position: { x: idx * 20, y: 0 },
            width: 120,
            height: 80,
            metadata: { content: `https://example.com/img-${idx + 1}.png` },
        }));

        const imageSubsetTarget = {
            id: "img-target-subset",
            type: CanvasNodeType.Image,
            title: "Image",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::single-ref-image", prompt: "@[node:img-1] 局部重绘" },
        };
        const imageSubsetNodes = [imageSubsetTarget, ...fiveImageNodes];
        const imageSubsetEdges = edgesTo("img-target-subset", fiveImageNodes.map((n) => n.id));
        expect(buildNodeGenerationContext("img-target-subset", imageSubsetNodes, imageSubsetEdges, imageSubsetTarget.metadata.prompt, [], false).imageCount).toBe(1);
        const imageSubsetHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={imageSubsetTarget}
                    referenceNodes={imageSubsetNodes}
                    referenceConnections={imageSubsetEdges}
                    config={singleRefImageConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={makeImageRefs(5)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(imageSubsetHtml).not.toContain("最多支持");
        expect(imageSubsetHtml).not.toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const nestedMediaTextNode = {
            id: "txt-nested-img",
            type: CanvasNodeType.Text,
            title: "带图token脚本",
            position: { x: 100, y: 0 },
            width: 160,
            height: 80,
            metadata: { content: "镜头参考 @[node:img-1] 的构图" },
        };
        const imageNestedTarget = {
            id: "img-nested-target",
            type: CanvasNodeType.Image,
            title: "Image",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::text-only-image", prompt: "@[node:txt-nested-img] 生成概念图" },
        };
        const imageNestedNodes = [imageNestedTarget, fiveImageNodes[0]!, nestedMediaTextNode];
        const imageNestedEdges = edgesTo("img-nested-target", ["img-1", "txt-nested-img"]);
        expect(buildNodeGenerationContext("img-nested-target", imageNestedNodes, imageNestedEdges, imageNestedTarget.metadata.prompt, [], false).imageCount).toBe(0);
        const imageNestedHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={imageNestedTarget}
                    referenceNodes={imageNestedNodes}
                    referenceConnections={imageNestedEdges}
                    config={textOnlyImageConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={[
                        makeImageRefs(1)[0]!,
                        { id: "txt-nested-img", nodeId: "txt-nested-img", kind: "text", label: "文本1", title: "带图token脚本", text: "镜头参考 @[node:img-1] 的构图", active: true },
                    ]}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(imageNestedHtml).not.toContain("最多支持");
        expect(imageNestedHtml).not.toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const selfVideoRegenHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={{
                        id: "vid-self",
                        type: CanvasNodeType.Video,
                        title: "Video",
                        position: { x: 0, y: 0 },
                        width: 320,
                        height: 180,
                        metadata: { model: "beeftv::single-frame-video", prompt: "重新生成新镜头", content: "https://example.com/old.mp4" },
                    }}
                    config={singleFrameConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={[{ id: "vid-self", nodeId: "vid-self", kind: "video", label: "视频1", title: "Video", active: true }]}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(selfVideoRegenHtml).not.toContain("不支持参考视频");
        expect(selfVideoRegenHtml).not.toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const prevAssets = useAssetStore.getState().assets;
        const prevInitialAssets = useAssetStore.getInitialState().assets;
        try {
            const now = "2026-11-12T00:00:00.000Z";
            const mockAssets = ["asset-1", "asset-2"].map((id, idx) => ({
                id,
                kind: "image" as const,
                title: `素材图${idx + 1}`,
                coverUrl: `https://example.com/${id}.png`,
                tags: [],
                createdAt: now,
                updatedAt: now,
                data: { dataUrl: `https://example.com/${id}.png`, width: 512, height: 512, bytes: 1024, mimeType: "image/png" },
            }));
            useAssetStore.getInitialState().assets = mockAssets;
            useAssetStore.setState({ assets: mockAssets });
            const assetOverflowHtml = renderToStaticMarkup(
                <QueryClientProvider client={new QueryClient()}>
                    <CanvasNodePromptPanel
                        node={{
                            id: "vid-asset-overflow",
                            type: CanvasNodeType.Video,
                            title: "Video",
                            position: { x: 0, y: 0 },
                            width: 320,
                            height: 180,
                            metadata: { model: "beeftv::single-frame-video", prompt: "@[asset:asset-1] @[asset:asset-2] 双图运动" },
                        }}
                        config={singleFrameConfig}
                        projectId="proj-1"
                        isRunning={false}
                        mentionReferences={[]}
                        onPromptChange={() => {}}
                        onConfigChange={() => {}}
                        onGenerate={() => {}}
                    />
                </QueryClientProvider>,
            );
            expect(assetOverflowHtml).toContain("最多支持 1 张参考图");
            expect(assetOverflowHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);
        } finally {
            useAssetStore.getInitialState().assets = prevInitialAssets;
            useAssetStore.setState({ assets: prevAssets });
        }
    });

    test("待处理转换节点与错误参考图映射表在面板内提前提示并禁用生成，意外编程异常不被吞成用户预检提示", () => {
        const { h3Config, wanConfig, multiRefImageConfig } = createFixtureConfigs();
        const imgSrc = {
            id: "img-src",
            type: CanvasNodeType.Image,
            title: "原图",
            position: { x: 0, y: 0 },
            width: 120,
            height: 80,
            metadata: { content: "https://example.com/src.png" },
        };
        const pendingConversion = {
            id: "conv-1",
            type: CanvasNodeType.MediaConversion,
            title: "线稿转换",
            position: { x: 140, y: 0 },
            width: 160,
            height: 100,
            metadata: { mediaConversion: { operation: "canny", status: "processing" as const } },
        };
        const videoTarget = {
            id: "vid-conv-target",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 320, y: 0 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::minimax-h3-max", prompt: "按线稿运动" },
        };
        const convNodes = [videoTarget, imgSrc, pendingConversion];
        const convEdges = [
            { id: "e-src-conv", fromNodeId: "img-src", toNodeId: "conv-1" },
            { id: "e-conv-vid", fromNodeId: "conv-1", toNodeId: "vid-conv-target" },
        ];
        expect(resolveCanvasNodeGenerationPreview(videoTarget, "video", "按线稿运动", convNodes, convEdges, []).preflightError).toContain(
            "转换节点「线稿转换」仍在处理中",
        );
        const pendingConvHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={videoTarget}
                    referenceNodes={convNodes}
                    referenceConnections={convEdges}
                    config={h3Config}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={[]}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(pendingConvHtml).toContain("转换节点「线稿转换」仍在处理中，完成后才能执行下游生成");
        expect(pendingConvHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const twoImgs = [1, 2].map((idx) => ({
            id: `img-${idx}`,
            type: CanvasNodeType.Image,
            title: `镜头${idx}`,
            position: { x: idx * 20, y: 0 },
            width: 120,
            height: 80,
            metadata: { content: `https://example.com/img-${idx}.png` },
        }));
        const badTableTarget = {
            id: "img-bad-table",
            type: CanvasNodeType.Image,
            title: "Image",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::multi-ref-image", prompt: "| IMAGE 1 | @镜头2 |\n合成海报" },
        };
        const badTableNodes = [badTableTarget, ...twoImgs];
        const badTableEdges = edgesTo("img-bad-table", ["img-1", "img-2"]);
        expect(resolveCanvasNodeGenerationPreview(badTableTarget, "image", badTableTarget.metadata.prompt, badTableNodes, badTableEdges, []).preflightError).toContain(
            "IMAGE 1 对应图片2",
        );
        expect(resolveCanvasNodeGenerationPreview(badTableTarget, "image", "@图片9 悬空引用", [badTableTarget], [], []).preflightError).toBe("");
        expect(() => buildNodeGenerationContext("img-bad-table", [badTableTarget], [], "@图片9 悬空引用", [], false)).toThrow("没有对应的画布资源");

        const brokenNode = {
            id: "img-broken",
            type: CanvasNodeType.Image,
            title: "Broken",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            get metadata(): never {
                throw new TypeError("unexpected builder failure");
            },
        };
        expect(() => resolveCanvasNodeGenerationPreview(brokenNode, "image", "测试", [brokenNode], [], [])).toThrow(
            new TypeError("unexpected builder failure"),
        );

        const badTableHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={badTableTarget}
                    referenceNodes={badTableNodes}
                    referenceConnections={badTableEdges}
                    config={multiRefImageConfig}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={makeImageRefs(2)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(badTableHtml).toContain("IMAGE 1 对应图片2");
        expect(badTableHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const videoBadTableTarget = {
            id: "vid-bad-table",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::minimax-h3-max", prompt: "| IMAGE 1 | @镜头2 |\n推镜" },
        };
        const videoBadTableHtml = renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasNodePromptPanel
                    node={videoBadTableTarget}
                    referenceNodes={[videoBadTableTarget, ...twoImgs]}
                    referenceConnections={edgesTo("vid-bad-table", ["img-1", "img-2"])}
                    config={h3Config}
                    projectId="proj-1"
                    isRunning={false}
                    mentionReferences={makeImageRefs(2)}
                    onPromptChange={() => {}}
                    onConfigChange={() => {}}
                    onGenerate={() => {}}
                />
            </QueryClientProvider>,
        );
        expect(videoBadTableHtml).toContain("IMAGE 1 对应图片2");
        expect(videoBadTableHtml).toMatch(/aria-label="生成"[^>]*disabled=""|disabled=""[^>]*aria-label="生成"/);

        const threeImgs = [1, 2, 3].map((idx) => ({
            id: `img-${idx}`,
            type: CanvasNodeType.Image,
            title: `镜头${idx}`,
            position: { x: idx * 20, y: 0 },
            width: 120,
            height: 80,
            metadata: { content: `https://example.com/img-${idx}.png` },
        }));
        const omniReorderTarget = {
            id: "vid-omni-table",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 120 },
            width: 320,
            height: 180,
            metadata: { model: "beeftv::wan3.0-video", prompt: "@[node:img-2] 主角出场\n| IMAGE 1 | @镜头1 |" },
        };
        const omniNodes = [omniReorderTarget, ...threeImgs];
        const omniEdges = edgesTo("vid-omni-table", ["img-1", "img-2", "img-3"]);
        expect(resolveCanvasNodeGenerationPreview(omniReorderTarget, "video", omniReorderTarget.metadata.prompt, omniNodes, omniEdges, [], wanConfig).preflightError).toContain(
            "IMAGE 1 对应图片2",
        );
        expect(resolveCanvasNodeGenerationPreview(omniReorderTarget, "video", "@[node:img-2] 主角出场\n| IMAGE 1 | @[node:img-2] |", omniNodes, omniEdges, [], wanConfig).preflightError).toBe("");

        const warningsHtml = renderToStaticMarkup(
            <CanvasNodePromptWarnings
                config={multiRefImageConfig}
                currentModelCompatibilityError=""
                livePreflightError="转换节点仍在处理中"
                persistedPreflightError="上次提交失败原因"
                needsRecoverySection
                theme={canvasThemes.dark}
                onOpenGenerationHistory={() => {}}
                onCreateGenerationReplacement={() => {}}
            />,
        );
        expect(warningsHtml).toContain("转换节点仍在处理中");
        expect(warningsHtml).toContain("未开始生成：上次提交失败原因");
        expect(warningsHtml).toContain("查看生成历史");
        expect(warningsHtml).toContain("新建节点继续");
    });

    test("ModelPicker 告警、浮层互斥、无封面播放按钮与 auto/adaptive 比例展示", () => {
        const { singleFrameConfig } = createFixtureConfigs();

        const pickerWarningHtml = renderToStaticMarkup(
            <ModelPicker
                config={singleFrameConfig}
                value="beeftv::single-frame-video"
                capability="video"
                requirements={{ capability: "video", input: { textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 } }}
                onChange={() => {}}
            />,
        );
        expect(pickerWarningHtml).toContain('aria-invalid="true"');
        expect(pickerWarningHtml).toContain("最多支持 1 张参考图");

        const hadWindow = "window" in globalThis;
        const previousWindow = (globalThis as { window?: unknown }).window;
        if (!hadWindow || !previousWindow) {
            (globalThis as { window?: unknown }).window = new EventTarget();
        }
        try {
            let closedCount = 0;
            const unsubscribe = subscribeCanvasPopoverOpen("video-settings", () => {
                closedCount += 1;
            });
            notifyCanvasPopoverOpen("video-settings");
            expect(closedCount).toBe(0);
            notifyCanvasPopoverOpen("model-picker");
            expect(closedCount).toBe(1);
            unsubscribe();
            notifyCanvasPopoverOpen("model-picker");
            expect(closedCount).toBe(1);
        } finally {
            if (!hadWindow) delete (globalThis as { window?: unknown }).window;
            else (globalThis as { window?: unknown }).window = previousWindow;
        }

        const inactiveVideoHtml = renderToStaticMarkup(
            <InactiveVideoPreview
                node={{
                    id: "vid-inactive",
                    type: CanvasNodeType.Video,
                    title: "测试成片",
                    position: { x: 0, y: 0 },
                    width: 320,
                    height: 180,
                    metadata: { content: "https://example.com/out.mp4" },
                }}
                theme={canvasThemes.dark}
                hoverEnabled={false}
                onPlay={() => {}}
            />,
        );
        expect(inactiveVideoHtml).toContain('aria-label="播放 测试成片"');
        expect(inactiveVideoHtml).not.toContain("absolute left-1/2 top-1/2");
        expect(inactiveVideoHtml.indexOf('aria-label="播放 测试成片"')).toBeLessThan(inactiveVideoHtml.indexOf('title="测试成片"'));

        const autoAndAdaptiveSettingsHtml = renderToStaticMarkup(
            <VideoSettingsPanel config={singleFrameConfig} theme={canvasThemes.dark} onConfigChange={() => {}} />,
        );
        expect(autoAndAdaptiveSettingsHtml.match(/>自适应</g)?.length).toBe(2);
        expect(autoAndAdaptiveSettingsHtml).not.toContain(">auto<");
        expect(autoAndAdaptiveSettingsHtml).not.toContain(">adaptive<");
        expect(autoAndAdaptiveSettingsHtml.match(/rounded-\[2px\]/g)?.length).toBe(1);
    });
});
