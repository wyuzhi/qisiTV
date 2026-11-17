import { describe, expect, test } from "bun:test";

import { buildImageToolbarTools } from "@/components/canvas/canvas-image-toolbar-tools";
import { resolveNodeToolbarPlacement, resolveToolbarTools, type ToolContext, type ToolbarHandlers } from "@/lib/canvas/tool-registry";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function createNodeContext(node: CanvasNodeData): ToolContext {
    return {
        selectedCount: 0,
        selectedNodeTypes: new Set(),
        selectedVideoCount: 0,
        canvasTool: "move",
        workspaceMode: "professional",
        isProjectLinked: false,
        canUndo: false,
        canRedo: false,
        node,
        nodeMetadata: node.metadata,
        extractingVideoFrames: false,
        extractingAudio: false,
        trimmingVideo: false,
        mergingVideos: false,
        addPanelOpen: false,
        appearancePanelOpen: false,
        settingsPanelOpen: false,
        handlers: {} as ToolbarHandlers,
    };
}

describe("canvas node toolbar model", () => {
    test("hover history action follows authoritative taskOutcome before legacy error code fallback", () => {
        const node: CanvasNodeData = { id: "history", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, metadata: {
            status: "error", errorDetails: "opaque", taskOutcome: { phase: "failed", regenerate: "allowed", reason: "result_target_unavailable" },
        } };
        const ctx = createNodeContext(node);
        const authoritativeHistory = resolveToolbarTools("node-hover", ctx, null).find((tool) => tool.id === "retry");
        const authoritativeHistoryLabel = authoritativeHistory?.label;
        expect(typeof authoritativeHistoryLabel === "function" ? authoritativeHistoryLabel(ctx) : authoritativeHistoryLabel).toBe("从生成历史取回原结果");

        node.metadata = {
            status: "error",
            errorDetails: "opaque",
            generationErrorCode: "result_target_unavailable",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "task_failed" },
        };
        ctx.nodeMetadata = node.metadata;
        const authoritativeRetry = resolveToolbarTools("node-hover", ctx, null).find((tool) => tool.id === "retry");
        const authoritativeRetryLabel = authoritativeRetry?.label;
        expect(typeof authoritativeRetryLabel === "function" ? authoritativeRetryLabel(ctx) : authoritativeRetryLabel).toBe("重新生成");

        node.metadata = { status: "error", errorDetails: "opaque", generationErrorCode: "result_target_unavailable" };
        ctx.nodeMetadata = node.metadata;
        const legacySaved = resolveToolbarTools("node-hover", ctx, null).find((tool) => tool.id === "retry");
        const legacySavedLabel = legacySaved?.label;
        expect(typeof legacySavedLabel === "function" ? legacySavedLabel(ctx) : legacySavedLabel).toBe("从生成历史取回原结果");
    });

    test("opens the same subtitles action for uploaded audio and video", () => {
        for (const type of [CanvasNodeType.Audio, CanvasNodeType.Video]) {
            const node: CanvasNodeData = { id: "media", type, title: "素材", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { storageKey: "resource:media-fixture" } };
            const ctx = createNodeContext(node);
            const received: CanvasNodeData[] = [];
            ctx.handlers = { onNodeSubtitles: target => received.push(target) } as ToolbarHandlers;
            const action = resolveToolbarTools("node-hover", ctx, null).find(tool => tool.id === "subtitles");
            expect(action).toBeDefined();
            action?.run(ctx);
            expect(received).toEqual([node]);
        }
    });
    test("preserves empty, simple and busy video states", () => {
        const ctx = createNodeContext({ id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: {} });
        const emptyTools = resolveToolbarTools("node-hover", ctx, null);
        expect(emptyTools.some((tool) => tool.id === "extractAudio")).toBe(false);
        expect(emptyTools.some((tool) => tool.id === "uploadVideo")).toBe(false);
        ctx.nodeMetadata = { content: "video.mp4" };
        const uploadedTools = resolveToolbarTools("node-hover", ctx, null);
        expect(resolveNodeToolbarPlacement(uploadedTools.find((tool) => tool.id === "uploadVideo")!, ctx).group).toBe("more");
        ctx.extractingAudio = true;
        const audio = resolveToolbarTools("node-hover", ctx, null).find((tool) => tool.id === "extractAudio")!;
        expect(audio.disabled?.(ctx)).toBe(true);
        ctx.workspaceMode = "simple";
        expect(resolveToolbarTools("node-hover", ctx, null).some((tool) => tool.id === "extractAudio")).toBe(false);
    });

    test("image menu actions remain lazy and keep the original node", () => {
        const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "image.png", freeResize: true } };
        const received: CanvasNodeData[] = [];
        const tools = buildImageToolbarTools(node, { onCrop: (target: CanvasNodeData) => received.push(target) } as never);
        expect(received).toEqual([]);
        tools.find((tool) => tool.id === "crop")!.onClick();
        expect(received).toEqual([node]);
        expect(tools.find((tool) => tool.id === "resize")?.active).toBe(false);
    });

    test("keeps video primary actions compact and moves secondary processing into a menu", () => {
        const ctx = createNodeContext({ id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "video.mp4" } });
        const tools = resolveToolbarTools("node-hover", ctx, null);
        const groups = new Map(tools.map((tool) => [tool.id, resolveNodeToolbarPlacement(tool, ctx).group]));

        expect([...groups].filter(([, group]) => group === "primary").map(([id]) => id)).toEqual(["trimRegenerate", "subtitles"]);
        expect([...groups].filter(([, group]) => group === "process").map(([id]) => id)).toEqual(["extractFrames", "extractAudio"]);
        expect(groups.get("download")).toBe("utility");
        expect(groups.get("timeline")).toBe("workspace");
        expect(groups.get("uploadVideo")).toBe("more");
        expect(groups.get("delete")).toBe("more");
        expect(groups.get("node-lock")).toBe("more");
    });

    test("offers depth capture as a video processing action and dispatches the source node", () => {
        const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "video.mp4" } };
        const received: CanvasNodeData[] = [];
        const ctx = createNodeContext(node);
        ctx.handlers = { onNodeDepthCapture: (target) => received.push(target) } as ToolbarHandlers;

        const tool = resolveToolbarTools("node-hover", ctx, null).find((item) => item.id === "depthCapture");

        expect(tool).toBeDefined();
        expect(tool?.displayLabel).toBe("深度动作捕捉");
        expect(resolveNodeToolbarPlacement(tool!, ctx).group).toBe("more");
        expect(tool?.nodeToolbar?.section).toBe("视频处理");
        tool?.run(ctx);
        expect(received).toEqual([node]);
    });

    test("offers subtitle erase inside video processing menu and dispatches the source video node", () => {
        const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "原片", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "video.mp4" } };
        const received: CanvasNodeData[] = [];
        const ctx = createNodeContext(node);
        ctx.handlers = { onNodeSubtitleErase: (target) => received.push(target) } as ToolbarHandlers;

        const tool = resolveToolbarTools("node-hover", ctx, null).find((item) => item.id === "subtitleErase");

        expect(tool).toBeDefined();
        expect(tool?.displayLabel).toBe("视频去字幕");
        expect(resolveNodeToolbarPlacement(tool!, ctx).group).toBe("more");
        expect(tool?.nodeToolbar?.section).toBe("视频处理");
        tool?.run(ctx);
        expect(received).toEqual([node]);

        const modes: Array<[CanvasNodeData, string | undefined]> = [];
        ctx.handlers = {
            onNodeSubtitleErase: (target, initialType) => modes.push([target, initialType]),
        } as ToolbarHandlers;
        const watermarkTool = resolveToolbarTools("node-hover", ctx, null).find((item) => item.id === "watermarkErase");
        const privacyTool = resolveToolbarTools("node-hover", ctx, null).find((item) => item.id === "privacyProtect");
        expect(watermarkTool?.displayLabel).toBe("视频去水印");
        expect(privacyTool?.displayLabel).toBe("隐私打码");
        watermarkTool?.run(ctx);
        privacyTool?.run(ctx);
        expect(modes).toEqual([
            [node, "watermark"],
            [node, "privacy"],
        ]);
    });

    test("smart erase parameter builder, capability predicates, and SRT/VTT subtitle parser cover all modes", async () => {
        const { buildSmartEraseApiParams } = await import("../src/components/canvas/video-subtitle-erase-dialog");
        const { isDedicatedMediaToolCapability } = await import("../src/lib/media-capabilities");
        const { parseSubtitleText } = await import("../src/lib/timeline/srt-parser");

        const videoCap = (op: string) => ({
            video: { operations: [op], options: [], referenceKinds: ["video" as const], maxOutputs: 1 },
        });
        expect(isDedicatedMediaToolCapability(videoCap("subtitle_erase"))).toBe(true);
        expect(isDedicatedMediaToolCapability(videoCap("watermark_erase"))).toBe(true);
        expect(isDedicatedMediaToolCapability(videoCap("privacy_protect"))).toBe(true);
        expect(isDedicatedMediaToolCapability(videoCap("text_to_video"))).toBe(false);

        const baseState = {
            eraseType: "subtitle" as const,
            eraseMethod: "auto" as const,
            subtitleModel: "standard" as const,
            watermarkModel: "advanced" as const,
            privacyModel: "mosaic" as const,
            privacyTargets: ["face" as const, "plate" as const],
            ocrExtract: true,
            subtitleLang: "zh_en" as const,
            subtitleFormat: "srt" as const,
            translate: true,
            translateDstLang: "en",
            embedAdvancedOpen: true,
            subtitleEmbedId: 10042,
            useOriginalPos: true,
            useOriginalSize: false,
        };
        const subRegion = { x: 0, y: 0.76, width: 1, height: 0.2 };
        const wmRegion = { x: 0.74, y: 0.04, width: 0.22, height: 0.14 };

        expect(buildSmartEraseApiParams("res-1", baseState, subRegion, wmRegion)).toEqual({
            resourceId: "res-1",
            channelId: "beeftv",
            eraseType: "subtitle",
            eraseMethod: "auto",
            subtitleModel: "standard",
            ocrExtract: true,
            subtitleLang: "zh_en",
            subtitleFormat: "srt",
            translate: true,
            translateDstLang: "en",
            subtitleEmbedId: 10042,
            useOriginalPos: true,
            useOriginalSize: false,
        });

        expect(
            buildSmartEraseApiParams(
                "res-custom-full",
                { ...baseState, eraseMethod: "custom", subtitleModel: "standard" },
                subRegion,
                wmRegion,
            ),
        ).toEqual({
            resourceId: "res-custom-full",
            channelId: "beeftv",
            eraseType: "subtitle",
            eraseMethod: "custom",
            subtitleModel: "standard",
            region: { x: 0, y: 0.76, width: 0.9999, height: 0.2 },
        });

        const collapsedEmbedParams = buildSmartEraseApiParams(
            "res-embed-toggle",
            { ...baseState, embedAdvancedOpen: false, subtitleEmbedId: null },
            subRegion,
            wmRegion,
        );
        const expandedEmbedParams = buildSmartEraseApiParams(
            "res-embed-toggle",
            { ...baseState, embedAdvancedOpen: true, subtitleEmbedId: null },
            subRegion,
            wmRegion,
        );
        expect(JSON.stringify(collapsedEmbedParams)).toBe(JSON.stringify(expandedEmbedParams));

        expect(
            buildSmartEraseApiParams(
                "res-mega",
                { ...baseState, eraseMethod: "custom", subtitleModel: "mega" },
                subRegion,
                wmRegion,
            ),
        ).toEqual({
            resourceId: "res-mega",
            channelId: "beeftv",
            eraseType: "subtitle",
            eraseMethod: "auto",
            subtitleModel: "mega",
        });

        expect(
            buildSmartEraseApiParams(
                "res-wm",
                { ...baseState, eraseType: "watermark", eraseMethod: "custom" },
                subRegion,
                wmRegion,
            ),
        ).toEqual({
            resourceId: "res-wm",
            channelId: "beeftv",
            eraseType: "watermark",
            eraseMethod: "custom",
            watermarkModel: "advanced",
            region: wmRegion,
        });

        expect(
            buildSmartEraseApiParams("res-priv", { ...baseState, eraseType: "privacy" }, subRegion, wmRegion),
        ).toEqual({
            resourceId: "res-priv",
            channelId: "beeftv",
            eraseType: "privacy",
            privacyModel: "mosaic",
            privacyTargets: ["face", "plate"],
        });

        const vttEntries = parseSubtitleText(
            "WEBVTT\n\ncue-1\n00:00:00.500 --> 00:00:02.250 line:85% position:50%\n欢迎来到工作台\n\n00:02.500 --> 00:04.000\nWelcome aboard",
        );
        expect(vttEntries).toHaveLength(2);
        expect(vttEntries[0]).toMatchObject({ startMs: 500, endMs: 2250, text: "欢迎来到工作台" });
        expect(vttEntries[1]).toMatchObject({ startMs: 2500, endMs: 4000, text: "Welcome aboard" });

        const { createElement } = await import("react");
        const { renderToStaticMarkup } = await import("react-dom/server");
        const { canvasThemes } = await import("../src/lib/canvas-theme");
        const { VideoSmartEraseControls } = await import("../src/components/canvas/video-smart-erase-controls");
        const { reconcileSmartEraseControlState, resolveSmartEraseCapabilityOptions } = await import(
            "../src/services/api/video-subtitle-erase"
        );

        const restrictedCaps = {
            model: "video-subtitle-erase",
            available: true,
            capabilitiesLoaded: true,
            maxVideoDurationMs: 300_000,
            cloudProcessing: true,
            availableModels: ["video-subtitle-erase"],
            eraseTypes: ["subtitle" as const, "watermark" as const, "privacy" as const],
            eraseMethods: ["auto" as const, "custom" as const],
            subtitleModels: ["standard" as const, "area" as const, "mega" as const],
            translateDstLangs: ["en", "tr", "custom-xx"],
        };
        const resolvedRestricted = resolveSmartEraseCapabilityOptions(restrictedCaps);
        expect(resolvedRestricted.eraseTypes).toEqual(["subtitle"]);
        expect(resolvedRestricted.subtitleModels).toEqual(["standard", "area"]);
        expect(resolvedRestricted.translateDstLangs).toEqual(["en", "tr", "custom-xx"]);
        expect(resolvedRestricted.isSelectionAvailable("subtitle", "standard")).toBe(true);
        expect(resolvedRestricted.isSelectionAvailable("subtitle", "mega")).toBe(false);
        expect(resolvedRestricted.isSelectionAvailable("watermark", "standard")).toBe(false);

        const controlsHtml = renderToStaticMarkup(
            createElement(VideoSmartEraseControls, {
                theme: canvasThemes.light,
                capabilities: restrictedCaps,
                state: { ...baseState, translateDstLang: "tr" },
                onChange: () => {},
            }),
        );
        expect(controlsHtml).not.toContain("去水印");
        expect(controlsHtml).not.toContain("隐私打码");
        expect(controlsHtml).not.toContain("大模型精擦");
        expect(controlsHtml).toContain("土耳其语 (tr)");

        const customLangHtml = renderToStaticMarkup(
            createElement(VideoSmartEraseControls, {
                theme: canvasThemes.light,
                capabilities: restrictedCaps,
                state: { ...baseState, translateDstLang: "custom-xx" },
                onChange: () => {},
            }),
        );
        expect(customLangHtml).toContain("custom-xx");

        const unavailableResolved = resolveSmartEraseCapabilityOptions({
            ...restrictedCaps,
            available: false,
            availableModels: ["video-subtitle-erase"],
        });
        expect(unavailableResolved.available).toBe(false);
        expect(unavailableResolved.isSelectionAvailable("subtitle", "standard")).toBe(false);

        const legacySubtitleOnlyResolved = resolveSmartEraseCapabilityOptions({
            model: "video-subtitle-erase",
            available: true,
            eraseMethods: ["auto", "custom"],
            subtitleModels: ["standard", "area"],
            maxVideoDurationMs: 300_000,
            cloudProcessing: true,
        });
        expect(legacySubtitleOnlyResolved.eraseTypes).toEqual(["subtitle"]);
        expect(legacySubtitleOnlyResolved.isSelectionAvailable("watermark", "standard")).toBe(false);

        const megaOnlyModelsResolved = resolveSmartEraseCapabilityOptions({
            model: "video-subtitle-erase-mega",
            available: true,
            availableModels: ["video-subtitle-erase-mega"],
            eraseMethods: ["auto", "custom"],
            subtitleModels: [],
            maxVideoDurationMs: 300_000,
            cloudProcessing: true,
        });
        expect(megaOnlyModelsResolved.available).toBe(true);
        expect(megaOnlyModelsResolved.eraseTypes).toEqual(["subtitle"]);
        expect(megaOnlyModelsResolved.subtitleModels).toEqual(["mega"]);
        expect(megaOnlyModelsResolved.isSelectionAvailable("subtitle", "mega")).toBe(true);
        expect(megaOnlyModelsResolved.isSelectionAvailable("subtitle", "standard")).toBe(false);
        const reconciledMegaOnly = reconcileSmartEraseControlState(baseState, megaOnlyModelsResolved);
        expect(reconciledMegaOnly.subtitleModel).toBe("mega");
        expect(reconciledMegaOnly.eraseMethod).toBe("auto");
        expect(megaOnlyModelsResolved.isControlStateAvailable(reconciledMegaOnly)).toBe(true);

        const watermarkListOnlyResolved = resolveSmartEraseCapabilityOptions({
            model: "video-subtitle-erase",
            available: true,
            eraseMethods: ["auto", "custom"],
            subtitleModels: [],
            watermarkModels: ["basic"],
            maxVideoDurationMs: 300_000,
            cloudProcessing: true,
        });
        expect(watermarkListOnlyResolved.available).toBe(true);
        expect(watermarkListOnlyResolved.eraseTypes).toEqual(["watermark"]);
        expect(watermarkListOnlyResolved.isSelectionAvailable("watermark", "standard")).toBe(true);
        expect(watermarkListOnlyResolved.isSelectionAvailable("subtitle", "standard")).toBe(false);

        const customOnlyMegaResolved = resolveSmartEraseCapabilityOptions({
            model: "video-subtitle-erase",
            available: true,
            availableModels: ["video-subtitle-erase", "video-subtitle-erase-mega"],
            eraseTypes: ["subtitle"],
            eraseMethods: ["custom"],
            subtitleModels: ["standard", "mega"],
            maxVideoDurationMs: 300_000,
            cloudProcessing: true,
        });
        expect(customOnlyMegaResolved.subtitleModels).toEqual(["standard"]);
        expect(customOnlyMegaResolved.isSelectionAvailable("subtitle", "mega")).toBe(false);
        expect(
            customOnlyMegaResolved.isControlStateAvailable({
                ...baseState,
                eraseType: "subtitle",
                subtitleModel: "mega",
                eraseMethod: "auto",
            }),
        ).toBe(false);

        const subOptionRestrictedCaps = {
            model: "video-subtitle-erase",
            available: true,
            capabilitiesLoaded: true,
            maxVideoDurationMs: 300_000,
            cloudProcessing: true,
            availableModels: ["video-subtitle-erase", "video-watermark-erase", "video-privacy-protect"],
            eraseTypes: ["subtitle" as const, "watermark" as const, "privacy" as const],
            eraseMethods: ["auto" as const],
            subtitleModels: ["standard" as const],
            watermarkModels: ["basic" as const],
            privacyModels: ["mosaic" as const],
            privacyTargets: ["face" as const],
            subtitleLangs: ["multi"],
            subtitleFormats: ["vtt" as const],
            translateDstLangs: ["tr"],
        };
        const resolvedSubOptions = resolveSmartEraseCapabilityOptions(subOptionRestrictedCaps);
        const reconciledWatermark = reconcileSmartEraseControlState(
            { ...baseState, eraseType: "watermark", watermarkModel: "advanced", eraseMethod: "custom" },
            resolvedSubOptions,
        );
        expect(reconciledWatermark.watermarkModel).toBe("basic");
        expect(reconciledWatermark.eraseMethod).toBe("auto");

        const reconciledPrivacy = reconcileSmartEraseControlState(
            { ...baseState, eraseType: "privacy", privacyModel: "blur", privacyTargets: ["face", "plate"] },
            resolvedSubOptions,
        );
        expect(reconciledPrivacy.privacyModel).toBe("mosaic");
        expect(reconciledPrivacy.privacyTargets).toEqual(["face"]);

        expect(
            buildSmartEraseApiParams(
                "res-reconciled-priv",
                { ...baseState, eraseType: "privacy", privacyModel: "blur", privacyTargets: ["face", "plate"] },
                subRegion,
                wmRegion,
                subOptionRestrictedCaps,
            ),
        ).toEqual({
            resourceId: "res-reconciled-priv",
            channelId: "beeftv",
            eraseType: "privacy",
            privacyModel: "mosaic",
            privacyTargets: ["face"],
        });

        expect(
            buildSmartEraseApiParams(
                "res-reconciled-sub",
                { ...baseState, eraseMethod: "custom", subtitleLang: "zh_en", subtitleFormat: "srt", translateDstLang: "en" },
                subRegion,
                wmRegion,
                subOptionRestrictedCaps,
            ),
        ).toEqual({
            resourceId: "res-reconciled-sub",
            channelId: "beeftv",
            eraseType: "subtitle",
            eraseMethod: "auto",
            subtitleModel: "standard",
            ocrExtract: true,
            subtitleLang: "multi",
            subtitleFormat: "vtt",
            translate: true,
            translateDstLang: "tr",
            subtitleEmbedId: 10042,
            useOriginalPos: true,
            useOriginalSize: false,
        });
    });

    test("subtitle erase task predicate and unknown-submission recovery stay operation-scoped and query-only", async () => {
        const {
            canRecoverManagedToolNode,
            isVideoSubtitleEraseNode,
            isVideoSubtitleEraseTask,
            unknownSubmissionMetadata,
        } = await import("../src/lib/canvas/canvas-ai-upscale-task");
        expect(isVideoSubtitleEraseTask({ operation: "media.video.subtitle_erase" })).toBe(true);
        expect(isVideoSubtitleEraseTask({ operation: "media.upscale.video" })).toBe(false);
        expect(isVideoSubtitleEraseTask({ operation: undefined })).toBe(false);

        const unknownMeta = unknownSubmissionMetadata("Network Error");
        expect(unknownMeta.taskOutcome).toBeUndefined();
        const unknownNode: CanvasNodeData = {
            id: "erase-out",
            type: CanvasNodeType.Video,
            title: "原片 · 去字幕",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: {
                ...unknownMeta,
                taskClientOperationId: "op-erase-1",
                videoSubtitleEraseSourceNodeId: "source-video-1",
            },
        };
        expect(isVideoSubtitleEraseNode(unknownNode)).toBe(true);
        expect(canRecoverManagedToolNode(unknownNode)).toBe(true);
        const ctx = createNodeContext(unknownNode);
        const retry = resolveToolbarTools("node-hover", ctx, null).find((item) => item.id === "retry");
        expect(retry).toBeDefined();
        const displayLabel = retry?.displayLabel;
        expect(typeof displayLabel === "function" ? displayLabel(ctx) : displayLabel).toBe("取回原结果");

        const terminalFailedNode: CanvasNodeData = {
            ...unknownNode,
            metadata: {
                status: "error",
                taskId: "task-failed-1",
                taskStatus: "failed",
                taskOutcome: { phase: "failed", regenerate: "allowed", reason: "task_failed" },
                videoSubtitleEraseSourceNodeId: "source-video-1",
            },
        };
        expect(canRecoverManagedToolNode(terminalFailedNode)).toBe(false);
        const failedCtx = createNodeContext(terminalFailedNode);
        const failedRetry = resolveToolbarTools("node-hover", failedCtx, null).find((item) => item.id === "retry");
        expect(failedRetry).toBeDefined();
        const failedDisplayLabel = failedRetry?.displayLabel;
        expect(typeof failedDisplayLabel === "function" ? failedDisplayLabel(failedCtx) : failedDisplayLabel).toBe("重试");
    });

    test("uses the redesigned video terminology from the registry", () => {
        const ctx = createNodeContext({ id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "video.mp4" } });
        const tools = new Map(resolveToolbarTools("node-hover", ctx, null).map((tool) => [tool.id, tool]));
        const displayLabel = (id: string) => {
            const value = tools.get(id)?.displayLabel;
            return typeof value === "function" ? value(ctx) : value;
        };

        expect(displayLabel("subtitles")).toBe("字幕");
        expect(displayLabel("timeline")).toBe("进入剪辑");
        expect(displayLabel("extractFrames")).toBe("关键帧截取");
        expect(displayLabel("extractAudio")).toBe("音视频分离");
    });

    test.each([CanvasNodeType.Audio, CanvasNodeType.Video])("opens the project timeline from a %s node", (type) => {
        const node: CanvasNodeData = { id: "media", type, title: "素材", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { storageKey: "resource:media-fixture" } };
        const ctx = createNodeContext(node);
        const received: CanvasNodeData[] = [];
        ctx.handlers = { onNodeTimeline: (target) => received.push(target) } as ToolbarHandlers;
        const timeline = resolveToolbarTools("node-hover", ctx, null).find((tool) => tool.id === "timeline");
        expect(timeline?.displayLabel).toBe("进入剪辑");
        expect(resolveNodeToolbarPlacement(timeline!, ctx).group).toBe("workspace");
        timeline?.run(ctx);
        expect(received).toEqual([node]);
    });

    test("image-only tools carry presentation metadata instead of relying on component ID lists", () => {
        const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "image.png" } };
        const tools = buildImageToolbarTools(node, {} as never);

        expect(tools.find((tool) => tool.id === "angle")?.group).toBe("viewpoint");
        expect(tools.find((tool) => tool.id === "maskEdit")?.group).toBe("primary");
        expect(tools.some((tool) => tool.id === "superResolve")).toBe(false);
        expect(tools.find((tool) => tool.id === "emotion")?.group).toBe("portrait");
        expect(tools.find((tool) => tool.id === "upscale")?.description).toContain("不是 AI 超分");
        expect(tools.find((tool) => tool.id === "crop")?.section).toBe("构图与尺寸");
        expect(tools.find((tool) => tool.id === "resize")?.active).toBe(true);
        expect(tools.find((tool) => tool.id === "copyPrompt")?.group).toBe("more");
    });

    test("quick-reference predicate covers inline content, storageKey-only, and previewContent media cards while excluding empty or workflow control nodes", async () => {
        const { canQuickReferenceCanvasMediaNode } = await import("../src/lib/canvas/canvas-node-semantics");
        const base = (type: CanvasNodeType, metadata?: CanvasNodeData["metadata"]): CanvasNodeData => ({
            id: "n1",
            type,
            title: "素材",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata,
        });

        expect(canQuickReferenceCanvasMediaNode(base(CanvasNodeType.Image, { storageKey: "image:scope:archived" }))).toBe(true);
        expect(canQuickReferenceCanvasMediaNode(base(CanvasNodeType.Audio, { storageKey: "audio:scope:archived" }))).toBe(true);
        expect(canQuickReferenceCanvasMediaNode(base(CanvasNodeType.Video, { previewContent: "data:image/jpeg;base64,thumb" }))).toBe(true);
        expect(canQuickReferenceCanvasMediaNode(base(CanvasNodeType.Image, { fileUpload: true }))).toBe(false);
        expect(canQuickReferenceCanvasMediaNode(base(CanvasNodeType.Image, {}))).toBe(false);
        expect(canQuickReferenceCanvasMediaNode(base(CanvasNodeType.Text, { content: "hello" }))).toBe(false);
    });

    test("video toolbar keeps extraction actions inline on wide viewports and folds them into 视频处理 on split/compact viewports", async () => {
        const { resolveVideoToolbarSections } = await import("../src/components/canvas/canvas-video-toolbar-tools");
        const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 568, metadata: { storageKey: "resource:vid-1" } };
        const ctx = createNodeContext(node);
        let extractedNode: CanvasNodeData | undefined;
        const presets: string[] = [];
        ctx.handlers = {
            onNodeExtractAudioFromVideo: (target) => { extractedNode = target; },
        } as ToolbarHandlers;
        const registryToolbarTools = resolveToolbarTools("node-hover", ctx, null).map((tool) => {
            const placement = resolveNodeToolbarPlacement(tool, ctx);
            return {
                id: tool.id,
                label: typeof tool.displayLabel === "function" ? tool.displayLabel(ctx) : tool.displayLabel || "",
                icon: null,
                group: placement.group,
                order: placement.order,
                onClick: () => tool.run(ctx),
            };
        });
        const workspaceTools = registryToolbarTools.filter((tool) => tool.group === "workspace");

        const wide = resolveVideoToolbarSections({
            containerWidth: 1080,
            registryToolbarTools,
            workspaceTools,
            hasQuickReference: true,
            canDraftToFinal: false,
            onExtractVideoFrames: (preset) => presets.push(preset),
        });
        expect(wide.videoCompact).toBe(false);
        expect(wide.inlineAudioTool?.id).toBe("extractAudio");
        expect(wide.inlineSubtitleTool?.id).toBe("subtitles");
        expect(wide.inlineKeyframeTools.map((t) => t.id)).toEqual(["keyframe-current", "keyframe-first", "keyframe-last"]);
        expect(wide.videoProcessingTools.some((t) => t.id === "extractAudio")).toBe(false);

        // Exact boundary check: requiredWidth - 1 folds, requiredWidth stays inline.
        const justBelow = resolveVideoToolbarSections({
            containerWidth: wide.requiredWidth - 1,
            registryToolbarTools,
            workspaceTools,
            hasQuickReference: true,
            canDraftToFinal: false,
            onExtractVideoFrames: (preset) => presets.push(preset),
        });
        expect(justBelow.videoCompact).toBe(true);
        const exactFit = resolveVideoToolbarSections({
            containerWidth: wide.requiredWidth,
            registryToolbarTools,
            workspaceTools,
            hasQuickReference: true,
            canDraftToFinal: false,
            onExtractVideoFrames: (preset) => presets.push(preset),
        });
        expect(exactFit.videoCompact).toBe(false);

        // Enabling 转高清成片 widens requiredWidth so a 920px split pane folds before clipping.
        const draftWideCheck = resolveVideoToolbarSections({
            containerWidth: 920,
            registryToolbarTools,
            workspaceTools,
            hasQuickReference: true,
            canDraftToFinal: true,
            onExtractVideoFrames: (preset) => presets.push(preset),
        });
        expect(draftWideCheck.videoCompact).toBe(true);
        expect(draftWideCheck.videoProcessingTools.some((t) => t.id === "extractAudio")).toBe(true);

        const compact = resolveVideoToolbarSections({
            containerWidth: 680,
            registryToolbarTools,
            workspaceTools,
            hasQuickReference: true,
            canDraftToFinal: false,
            onExtractVideoFrames: (preset) => presets.push(preset),
        });
        expect(compact.videoCompact).toBe(true);
        expect(compact.inlineAudioTool).toBeUndefined();
        expect(compact.inlineSubtitleTool).toBeUndefined();
        expect(compact.inlineKeyframeTools).toEqual([]);
        expect(compact.inlineWorkspaceTools).toEqual([]);

        const foldedAudio = compact.videoProcessingTools.find((t) => t.id === "extractAudio");
        expect(foldedAudio?.label).toBe("音视频分离");
        foldedAudio?.onClick();
        expect(extractedNode).toBe(node);

        compact.videoProcessingTools.find((t) => t.id === "keyframe-last")?.onClick();
        expect(presets).toEqual(["last"]);
    });
});
