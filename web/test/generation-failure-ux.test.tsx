import { describe, expect, test } from "bun:test";
import { createElement, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeActionContext } from "../src/components/canvas/canvas-node-action-context";
import { CanvasNodeErrorContent } from "../src/components/canvas/canvas-node-error-content";
import { GenerationFailureNotice } from "../src/components/generation/generation-failure-notice";
import { canvasThemes } from "../src/lib/canvas-theme";
import {
    matchFailureReferenceTargets,
    openCanvasGenerationInputEditor,
    resolveCanvasPromptEditTarget,
    revealCanvasTargetNode,
} from "../src/lib/canvas/canvas-generation-failure-ux";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";
import { explainGenerationError } from "../src/lib/generation-error";
import {
    confirmCreationRetryIfNeeded,
    isCreativeInputFailureCategory,
    resolveFailureBillingBadge,
    resolveModerationStageHint,
    shouldConfirmUnchangedModerationRetry,
} from "../src/lib/generation-failure-ux";
import {
    notChargedTaskOutcome,
    runningTaskOutcome,
    submissionUnknownTaskOutcome,
} from "../src/lib/task-outcome";
import { useCanvasViewportController } from "../src/pages/canvas/use-canvas-viewport-controller";
import { createCanvasPageUiStore } from "../src/stores/canvas/use-canvas-page-ui-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

describe("generation-failure-ux", () => {
    test("derives billing reassurance badge strictly from authoritative evidence", () => {
        const moderation = explainGenerationError({ code: "moderation_output", message: "生成结果触发版权限制。请调整提示词或参考素材后重试。" });

        expect(
            resolveFailureBillingBadge({
                explanation: moderation,
                outcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
                taskId: "task-123",
            }),
        ).toEqual({ label: "未扣费 · 已自动退回", tone: "safe" });

        expect(
            resolveFailureBillingBadge({
                explanation: moderation,
                outcome: notChargedTaskOutcome(),
                taskId: "task-123",
            }),
        ).toEqual({ label: "本次未扣费", tone: "safe" });

        expect(
            resolveFailureBillingBadge({
                explanation: moderation,
                outcome: { phase: "failed", regenerate: "confirm", reason: "input_rejected" },
                taskId: "task-123",
            }),
        ).toBeUndefined();

        expect(
            resolveFailureBillingBadge({
                explanation: moderation,
                outcome: submissionUnknownTaskOutcome(),
                taskId: "task-123",
            }),
        ).toBeUndefined();

        expect(
            resolveFailureBillingBadge({
                explanation: moderation,
                outcome: runningTaskOutcome(),
                taskId: "task-123",
            }),
        ).toBeUndefined();

        expect(
            resolveFailureBillingBadge({
                explanation: moderation,
                outcome: { phase: "failed", regenerate: "allowed", reason: "no_result" },
                taskId: "task-depth",
                isLocalTool: true,
            }),
        ).toBeUndefined();

        expect(
            resolveFailureBillingBadge({
                explanation: explainGenerationError({ code: "request_not_sent", message: "未能连接服务" }),
            }),
        ).toEqual({ label: "本次未扣费", tone: "safe" });
    });

    test("returns output-stage reassurance hint only for moderation_output", () => {
        expect(resolveModerationStageHint(explainGenerationError({ code: "moderation_output", message: "生成视频未通过上游版权审核" }))).toContain("前置检查");
        expect(resolveModerationStageHint(explainGenerationError({ code: "moderation_input", message: "输入文本未通过内容安全审核" }))).toBeUndefined();
        expect(resolveModerationStageHint(explainGenerationError({ code: "network", message: "Failed to fetch" }))).toBeUndefined();
    });

    test("matches @图片N and 第 N 张参考图 / 第 N 段参考音频 against mentionReferences and upstreamNodes", () => {
        const refs: CanvasResourceReference[] = [
            {
                id: "img-1",
                nodeId: "node-img-1",
                kind: "image",
                label: "图片1",
                title: "赛博街景",
                storageKey: "resource:img1",
                active: true,
            },
            {
                id: "img-2",
                nodeId: "node-img-2",
                kind: "image",
                label: "图片2",
                title: "主角正脸",
                storageKey: "resource:img2",
                active: true,
            },
            {
                id: "aud-1",
                nodeId: "node-aud-1",
                kind: "audio",
                label: "音频1",
                title: "台词干声",
                active: true,
            },
        ];

        const slotMatch = matchFailureReferenceTargets({
            explanation: explainGenerationError({
                code: "moderation_reference",
                message: "@图片2 未通过实人或肖像权检查。请更换 @图片2 或改用非真人参考图后重试。",
            }),
            mentionReferences: refs,
        });
        expect(slotMatch).toEqual([
            {
                nodeId: "node-img-2",
                kind: "image",
                badgeLabel: "图片2",
                title: "主角正脸",
                previewUrl: undefined,
                storageKey: "resource:img2",
                exact: true,
            },
        ]);

        const chineseIndexMatch = matchFailureReferenceTargets({
            explanation: explainGenerationError("第 1 段参考音频时长为 0.90 秒，需要 2–30 秒；请裁剪或更换这段素材后再提交"),
            mentionReferences: refs,
        });
        expect(chineseIndexMatch.map((item) => ({ nodeId: item.nodeId, exact: item.exact }))).toEqual([
            { nodeId: "node-aud-1", exact: true },
        ]);

        const fallbackUpstreamVideoNodes: CanvasNodeData[] = [
            {
                id: "up-vid-1",
                type: CanvasNodeType.Video,
                title: "运镜参考片段",
                position: { x: 0, y: 0 },
                width: 240,
                height: 160,
                metadata: { storageKey: "resource:raw-video", videoPreview: { storageKey: "resource:poster-1" } },
            },
        ];
        const categoryFallbackMatch = matchFailureReferenceTargets({
            explanation: explainGenerationError({
                code: "InputVideoSensitiveContentDetected.PrivacyInformation",
                message: "The request failed because the input video may contain real person.",
            }),
            upstreamNodes: fallbackUpstreamVideoNodes,
        });
        expect(categoryFallbackMatch).toEqual([
            {
                nodeId: "up-vid-1",
                kind: "video",
                badgeLabel: "视频1",
                title: "运镜参考片段",
                previewUrl: undefined,
                storageKey: "resource:poster-1",
                exact: false,
            },
        ]);

        // Output moderation with generic boilerplate ("如使用了参考素材") must not wrongly highlight random images.
        const outputGenericMatch = matchFailureReferenceTargets({
            explanation: explainGenerationError({
                code: "OutputVideoSensitiveContentDetected.PolicyViolation",
                message: "The request failed because the output video may be related to copyright restrictions.",
            }),
            mentionReferences: refs,
        });
        expect(outputGenericMatch).toEqual([]);
    });

    test("identifies creative-input failures and strict unchanged-input moderation confirm rules", () => {
        expect(isCreativeInputFailureCategory("moderation_output")).toBe(true);
        expect(isCreativeInputFailureCategory("invalid_params")).toBe(true);
        expect(isCreativeInputFailureCategory("provider_unavailable")).toBe(false);

        expect(shouldConfirmUnchangedModerationRetry("moderation_input")).toBe(true);
        expect(shouldConfirmUnchangedModerationRetry("moderation_reference")).toBe(true);
        expect(shouldConfirmUnchangedModerationRetry("moderation_output")).toBe(false);
    });

    test("renders GenerationFailureNotice badges, stage hints, locator chips, action hierarchy, and compact diagnostics toggle", () => {
        const explanation = explainGenerationError({
            code: "moderation_output",
            message: "生成结果触发版权限制。请调整提示词或参考素材后重试。",
        });
        const resolvedExplanation = { ...explanation, blockManualRetry: false };
        const compactHtml = renderToStaticMarkup(
            <GenerationFailureNotice
                compact
                explanation={resolvedExplanation}
                context={{ taskId: "task_demo_1" }}
                billingBadge={{ label: "未扣费 · 已自动退回", tone: "safe" }}
                stageHint={resolveModerationStageHint(explanation)}
                referenceTargets={[
                    {
                        nodeId: "img-2",
                        kind: "image",
                        badgeLabel: "图片2",
                        title: "主角正脸",
                        onLocate: () => {},
                    },
                ]}
                primaryAction={{ label: "修改提示词", onClick: () => {} }}
                branchAction={{ label: "复制分支", onClick: () => {} }}
                onRetry={() => {}}
                onOpenDetails={() => {}}
            />,
        );
        expect(compactHtml).toContain("未扣费 · 已自动退回");
        expect(compactHtml).toContain("前置检查");
        expect(compactHtml).toContain("定位 @图片2");
        expect(compactHtml).toContain("主角正脸");
        expect(compactHtml).toContain("generation-failure-button is-primary");
        expect(compactHtml).toContain("修改提示词");
        expect(compactHtml).toContain("复制分支");
        expect(compactHtml).toContain("重新生成");
        expect(compactHtml).toContain("查看详情");
        expect(compactHtml).not.toContain("复制排查信息");

        const fullHtml = renderToStaticMarkup(
            <GenerationFailureNotice
                explanation={resolvedExplanation}
                context={{ taskId: "task_demo_1" }}
                billingBadge={{ label: "未扣费 · 已自动退回", tone: "safe" }}
                stageHint={resolveModerationStageHint(explanation)}
                onRetry={() => {}}
            />,
        );
        expect(fullHtml).toContain("复制排查信息");
    });

    test("distinguishes ambiguous fallback candidates from exact provider slot indices and labels UI cleanly", () => {
        const threeImages: CanvasResourceReference[] = [
            { id: "r1", nodeId: "n1", kind: "image", label: "图片1", title: "场景一", active: true },
            { id: "r2", nodeId: "n2", kind: "image", label: "图片2", title: "场景二", active: true },
            { id: "r3", nodeId: "n3", kind: "image", label: "图片3", title: "场景三", active: true },
        ];
        const ambiguousExplanation = explainGenerationError({ code: "invalid_params", message: "参考图片尺寸超出限制" });
        const candidates = matchFailureReferenceTargets({ explanation: ambiguousExplanation, mentionReferences: threeImages });
        expect(candidates).toHaveLength(3);
        expect(candidates.every((item) => item.exact === false)).toBe(true);

        const candidateHtml = renderToStaticMarkup(
            <GenerationFailureNotice
                compact
                explanation={ambiguousExplanation}
                referenceTargets={candidates.map((target) => ({ ...target, onLocate: () => {} }))}
            />,
        );
        expect(candidateHtml).toContain("排查 @图片1");
        expect(candidateHtml).toContain("排查 @图片2");
        expect(candidateHtml).toContain("排查 @图片3");
        expect(candidateHtml).not.toContain("定位 @图片1");

        const zeroBasedProviderMatch = matchFailureReferenceTargets({
            explanation: explainGenerationError({ code: "invalid_params", message: "Invalid input" }),
            upstreamDetail: "Invalid parameter `input_images[1]`: image resolution too small",
            mentionReferences: threeImages,
        });
        expect(zeroBasedProviderMatch.map((item) => ({ id: item.nodeId, exact: item.exact }))).toEqual([
            { id: "n2", exact: true },
        ]);

        const singleContentUrlMatch = matchFailureReferenceTargets({
            explanation: explainGenerationError({ code: "invalid_params", message: "Invalid input" }),
            upstreamDetail: "Invalid content[1].image_url",
            mentionReferences: [threeImages[0]!],
        });
        expect(singleContentUrlMatch.map((item) => ({ id: item.nodeId, exact: true }))).toEqual([
            { id: "n1", exact: true },
        ]);

        const multiContentUrlMatch = matchFailureReferenceTargets({
            explanation: explainGenerationError({ code: "invalid_params", message: "Invalid input" }),
            upstreamDetail: "Invalid content[1].image_url",
            mentionReferences: threeImages.slice(0, 2),
        });
        expect(multiContentUrlMatch.map((item) => ({ id: item.nodeId, exact: false }))).toEqual([
            { id: "n1", exact: false },
            { id: "n2", exact: false },
        ]);
    });

    test("creation retry confirmation gates moderation/confirm retries, protects blocked retries, and invokes onEditDraft on cancel", async () => {
        expect(
            await confirmCreationRetryIfNeeded({
                category: "moderation_input",
                outcome: { phase: "failed", regenerate: "blocked", reason: "charged_result_unrecoverable" },
                modalConfirm: () => {
                    throw new Error("should not open modal");
                },
            }),
        ).toBe(false);

        let edited = 0;
        const modals: Array<{ title?: string; cancelText?: string }> = [];
        const cancelled = await confirmCreationRetryIfNeeded({
            category: "moderation_input",
            outcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
            modalConfirm: (config) => {
                modals.push({ title: config.title, cancelText: config.cancelText });
                config.onCancel?.();
                config.afterClose?.();
            },
            onEditDraft: () => {
                edited += 1;
            },
        });
        expect(cancelled).toBe(false);
        expect(edited).toBe(1);
        expect(modals[0]).toEqual({ title: "输入尚未修改，确认直接重试？", cancelText: "去修改输入" });

        const confirmed = await confirmCreationRetryIfNeeded({
            category: "provider_unavailable",
            outcome: { phase: "failed", regenerate: "confirm", reason: "task_failed" },
            modalConfirm: (config) => {
                modals.push({ title: config.title, cancelText: config.cancelText });
                config.onOk?.();
            },
        });
        expect(confirmed).toBe(true);
        expect(modals[1]?.cancelText).toBe("取消");

        let dualWarningContent = "";
        const dualConfirmed = await confirmCreationRetryIfNeeded({
            category: "moderation_input",
            outcome: { phase: "failed", regenerate: "confirm", reason: "input_rejected" },
            modalConfirm: (config) => {
                dualWarningContent = String(config.content || "");
                modals.push({ title: config.title, cancelText: config.cancelText });
                config.onOk?.();
            },
            onEditDraft: () => {
                edited += 1;
            },
        });
        expect(dualConfirmed).toBe(true);
        expect(modals[2]).toEqual({ title: "输入尚未修改，确认直接重试？", cancelText: "去修改输入" });
        expect(dualWarningContent).toContain("未修改直接重试大概率仍会失败");
        expect(dualWarningContent).toContain("重新生成可能会再扣一次");
    });

    test("CanvasNodeErrorContent suppresses retry and reload controls in readOnly mode", () => {
        const deliveryPendingNode: CanvasNodeData = {
            id: "node-delivery-pending",
            type: CanvasNodeType.Video,
            title: "待取回成片",
            position: { x: 0, y: 0 },
            width: 320,
            height: 200,
            metadata: {
                status: "error",
                taskId: "task-delivery-1",
                taskStatus: "succeeded",
                errorDetails: "上游已生成完成，本地取回中断",
                taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "result_pending_local_download" },
            },
        };
        const retryableNode: CanvasNodeData = {
            id: "node-mod-err",
            type: CanvasNodeType.Video,
            title: "输入拦截",
            position: { x: 0, y: 240 },
            width: 320,
            height: 200,
            metadata: {
                status: "error",
                taskId: "task-mod-1",
                generationErrorCode: "moderation_input",
                errorDetails: "输入文本未通过内容安全审核。请调整提示词后重新生成。",
                taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
            },
        };

        const readOnlyReloadHtml = renderToStaticMarkup(
            <CanvasNodeErrorContent
                node={deliveryPendingNode}
                theme={canvasThemes.dark}
                readOnly
                onRetry={() => {}}
                onReloadResource={() => {}}
            />,
        );
        expect(readOnlyReloadHtml).not.toContain("继续取回</button>");
        expect(readOnlyReloadHtml).not.toContain("重新生成</button>");

        const editableReloadHtml = renderToStaticMarkup(
            <CanvasNodeErrorContent
                node={deliveryPendingNode}
                theme={canvasThemes.dark}
                readOnly={false}
                onRetry={() => {}}
                onReloadResource={() => {}}
            />,
        );
        expect(editableReloadHtml).toContain("继续取回</button>");

        const readOnlyRetryHtml = renderToStaticMarkup(
            <CanvasNodeErrorContent node={retryableNode} theme={canvasThemes.dark} readOnly onRetry={() => {}} />,
        );
        expect(readOnlyRetryHtml).not.toContain("重新生成</button>");

        const editableRetryHtml = renderToStaticMarkup(
            <CanvasNodeErrorContent node={retryableNode} theme={canvasThemes.dark} readOnly={false} onRetry={() => {}} />,
        );
        expect(editableRetryHtml).toContain("重新生成</button>");
    });

    test("read-only reveal focus leaves editable prompt panel and toolbar closed", () => {
        const previousWindow = (globalThis as { window?: unknown }).window;
        (globalThis as { window?: unknown }).window = {
            matchMedia: () => ({ matches: true }),
        };
        const pageUi = createCanvasPageUiStore();
        const generatedImg: CanvasNodeData = {
            id: "gen-img-1",
            type: CanvasNodeType.Image,
            title: "生成的参考图",
            position: { x: 100, y: 100 },
            width: 240,
            height: 160,
            metadata: { nodeRole: "result", content: "/api/resources/1/file" },
        };
        let controller!: ReturnType<typeof useCanvasViewportController>;
        function Harness() {
            const containerRef = useRef<HTMLDivElement | null>(null);
            const viewportRef = useRef({ x: 0, y: 0, k: 1 });
            const nodesRef = useRef([generatedImg]);
            const selectedNodeIdsRef = useRef(new Set<string>());
            controller = useCanvasViewportController({
                pageUi,
                projectId: "proj-readonly-test",
                containerRef,
                size: { width: 1200, height: 800 },
                viewport: { x: 0, y: 0, k: 1 },
                viewportRef,
                nodesRef,
                selectedNodeIdsRef,
                setViewport: () => {},
                setVirtualizationViewport: () => {},
            });
            return null;
        }
        try {
            renderToStaticMarkup(createElement(Harness));
            controller.focusCanvasNode(generatedImg.id, { openPromptPanel: false, openToolbar: false });
            expect(pageUi.getState().selectedNodeIds.has(generatedImg.id)).toBe(true);
            expect(pageUi.getState().dialogNodeId).toBeNull();
            expect(pageUi.getState().toolbarNodeId).toBeNull();

            controller.focusCanvasNode(generatedImg.id);
            expect(pageUi.getState().toolbarNodeId).toBe(generatedImg.id);
        } finally {
            if (previousWindow === undefined) {
                delete (globalThis as { window?: unknown }).window;
            } else {
                (globalThis as { window?: unknown }).window = previousWindow;
            }
        }
    });

    test("collapsed normal folders expand to focus target & open prompt panel, while linked archive and readOnly stay guarded", () => {
        const normalFolder: CanvasNodeData = {
            id: "folder-normal",
            type: CanvasNodeType.Frame,
            title: "分镜收纳夹",
            position: { x: 0, y: 0 },
            width: 360,
            height: 280,
            metadata: {
                frame: { collapsed: true, expandedWidth: 800, expandedHeight: 600 },
                folder: { id: "fld-local-1", name: "分镜收纳夹", style: "macos", theme: "blue", createdAt: "2026-11-17T00:00:00Z" },
            },
        };
        const sourceConfigInNormalFolder: CanvasNodeData = {
            id: "cfg-in-folder",
            parentId: "folder-normal",
            type: CanvasNodeType.Config,
            title: "主配置节点",
            position: { x: 40, y: 60 },
            width: 280,
            height: 200,
            metadata: { prompt: "原始生成提示词" },
        };
        const refImgInNormalFolder: CanvasNodeData = {
            id: "img-in-folder",
            parentId: "folder-normal",
            type: CanvasNodeType.Image,
            title: "角色定妆照",
            position: { x: 360, y: 60 },
            width: 240,
            height: 160,
            metadata: { nodeRole: "result", content: "/api/resources/ref2/file" },
        };
        const failedFromNormalFolder: CanvasNodeData = {
            id: "vid-failed-normal",
            type: CanvasNodeType.Video,
            title: "失败成片",
            position: { x: 520, y: 0 },
            width: 320,
            height: 200,
            metadata: {
                status: "error",
                taskId: "task-fld-1",
                generatedFromNodeId: "cfg-in-folder",
                generationErrorCode: "moderation_input",
                errorDetails: "输入文本未通过内容安全审核。请调整提示词后重新生成。",
                taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
            },
        };

        const linkedFolder: CanvasNodeData = {
            id: "folder-linked",
            type: CanvasNodeType.Frame,
            title: "项目归档目录",
            position: { x: 0, y: 360 },
            width: 360,
            height: 280,
            metadata: {
                frame: { collapsed: true, expandedWidth: 800, expandedHeight: 600 },
                folder: {
                    id: "fld-linked-1",
                    assetFolderId: "asset-folder-99",
                    name: "项目归档目录",
                    style: "macos",
                    theme: "amber",
                    createdAt: "2026-11-17T00:00:00Z",
                },
            },
        };
        const archivedSourceImg: CanvasNodeData = {
            id: "img-in-linked",
            parentId: "folder-linked",
            type: CanvasNodeType.Image,
            title: "归档原图",
            position: { x: 40, y: 420 },
            width: 240,
            height: 160,
            metadata: { nodeRole: "result", resultOrigin: "generated", taskId: "t-prev", content: "/api/resources/arch/file" },
        };
        const failedFromLinkedFolder: CanvasNodeData = {
            id: "vid-failed-linked",
            type: CanvasNodeType.Video,
            title: "归档派生失败",
            position: { x: 520, y: 360 },
            width: 320,
            height: 200,
            metadata: {
                status: "error",
                taskId: "task-fld-2",
                generatedFromNodeId: "img-in-linked",
                generationErrorCode: "moderation_reference",
                errorDetails: "@图片1 疑似包含真人形象，该模型拒绝生成。",
                taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
            },
        };

        const nodes = [
            normalFolder,
            sourceConfigInNormalFolder,
            refImgInNormalFolder,
            failedFromNormalFolder,
            linkedFolder,
            archivedSourceImg,
            failedFromLinkedFolder,
        ];

        const toggledFrames: string[] = [];
        const assetFolderToggles: string[] = [];
        const focusedCalls: Array<{ id: string; options?: { openPromptPanel?: boolean; openToolbar?: boolean } }> = [];
        let dialogNodeId: string | null = null;

        // 1. Normal collapsed folder: 修改提示词 expands folder via toggleFrameCollapsed, focuses sourceConfigInNormalFolder, and opens prompt panel.
        openCanvasGenerationInputEditor(failedFromNormalFolder, {
            nodes,
            connections: [],
            readOnly: false,
            focusCanvasNode: (id, options) => focusedCalls.push({ id, options }),
            toggleFrameCollapsed: (id) => toggledFrames.push(id),
            handleFrameToggle: (id) => assetFolderToggles.push(id),
            toggleBatchExpanded: () => {},
            setDialogNodeId: (id) => {
                dialogNodeId = id;
            },
        });
        expect(toggledFrames).toEqual(["folder-normal"]);
        expect(assetFolderToggles).toEqual([]);
        expect(focusedCalls).toEqual([{ id: "cfg-in-folder", options: { openPromptPanel: true } }]);
        expect(dialogNodeId).toBe("cfg-in-folder");

        // 2. Reference locator chip inside normal collapsed folder expands folder and focuses the actual referenced child node.
        toggledFrames.length = 0;
        focusedCalls.length = 0;
        revealCanvasTargetNode("img-in-folder", {
            nodes,
            readOnly: false,
            focusCanvasNode: (id, options) => focusedCalls.push({ id, options }),
            toggleFrameCollapsed: (id) => toggledFrames.push(id),
            handleFrameToggle: (id) => assetFolderToggles.push(id),
            toggleBatchExpanded: () => {},
        });
        expect(toggledFrames).toEqual(["folder-normal"]);
        expect(focusedCalls).toEqual([{ id: "img-in-folder", options: undefined }]);

        // 3. Read-only mode never expands folder or opens prompt/toolbar; focuses collapsed folder card safely.
        toggledFrames.length = 0;
        focusedCalls.length = 0;
        dialogNodeId = null;
        revealCanvasTargetNode("img-in-folder", {
            nodes,
            readOnly: true,
            focusCanvasNode: (id, options) => focusedCalls.push({ id, options }),
            toggleFrameCollapsed: (id) => toggledFrames.push(id),
            handleFrameToggle: (id) => assetFolderToggles.push(id),
            toggleBatchExpanded: () => {},
        });
        openCanvasGenerationInputEditor(failedFromNormalFolder, {
            nodes,
            connections: [],
            readOnly: true,
            focusCanvasNode: (id, options) => focusedCalls.push({ id, options }),
            toggleFrameCollapsed: (id) => toggledFrames.push(id),
            handleFrameToggle: (id) => assetFolderToggles.push(id),
            toggleBatchExpanded: () => {},
            setDialogNodeId: (id) => {
                dialogNodeId = id;
            },
        });
        expect(toggledFrames).toEqual([]);
        expect(focusedCalls).toEqual([{ id: "folder-normal", options: { openPromptPanel: false, openToolbar: false } }]);
        expect(dialogNodeId).toBeNull();

        // 4. Linked archive folder: prompt target resolves undefined, error card suppresses 修改提示词, and locator opens asset folder.
        expect(resolveCanvasPromptEditTarget(failedFromNormalFolder, nodes, [])?.id).toBe("cfg-in-folder");
        expect(resolveCanvasPromptEditTarget(failedFromLinkedFolder, nodes, [])).toBeUndefined();

        const normalCardHtml = renderToStaticMarkup(
            <CanvasNodeActionContext.Provider
                value={{
                    editGenerationInput: () => {},
                    canEditGenerationInput: (target) => Boolean(resolveCanvasPromptEditTarget(target, nodes, [])),
                }}
            >
                <CanvasNodeErrorContent node={failedFromNormalFolder} theme={canvasThemes.dark} />
            </CanvasNodeActionContext.Provider>,
        );
        expect(normalCardHtml).toContain("修改提示词</button>");

        const linkedCardHtml = renderToStaticMarkup(
            <CanvasNodeActionContext.Provider
                value={{
                    editGenerationInput: () => {},
                    canEditGenerationInput: (target) => Boolean(resolveCanvasPromptEditTarget(target, nodes, [])),
                }}
            >
                <CanvasNodeErrorContent node={failedFromLinkedFolder} theme={canvasThemes.dark} />
            </CanvasNodeActionContext.Provider>,
        );
        expect(linkedCardHtml).not.toContain("修改提示词</button>");

        focusedCalls.length = 0;
        revealCanvasTargetNode("img-in-linked", {
            nodes,
            readOnly: false,
            focusCanvasNode: (id, options) => focusedCalls.push({ id, options }),
            toggleFrameCollapsed: (id) => toggledFrames.push(id),
            handleFrameToggle: (id) => assetFolderToggles.push(id),
            toggleBatchExpanded: () => {},
        });
        expect(toggledFrames).toEqual([]);
        expect(assetFolderToggles).toEqual(["folder-linked"]);
        expect(focusedCalls).toEqual([{ id: "folder-linked", options: { openPromptPanel: false, openToolbar: false } }]);
    });
});
