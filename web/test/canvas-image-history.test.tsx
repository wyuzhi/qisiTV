import { describe, expect, test } from "bun:test";
import React from "react";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { CanvasNodeContent } from "@/components/canvas/canvas-node-content";
import { ConnectedReferenceShelf } from "@/components/canvas/canvas-node-reference-shelf";
import { CanvasHistoryStackBadge } from "@/components/canvas/canvas-node-history-stack";
import { CanvasImageInfoSidebar } from "@/components/canvas/image-viewer/canvas-image-info-sidebar";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildGenerationTaskNodeResult } from "@/lib/canvas/canvas-generation-task-sync";
import {
    activeImageHistoryIndex,
    applyPrimaryImageHistoryItem,
    executePrimaryImageHistorySwitch,
    MAX_CANVAS_IMAGE_HISTORY,
    planPrimaryImageHistorySwitch,
    removeCanvasImageHistoryItem,
    resolveActiveCanvasImageHistoryItem,
    resolveCanvasNodeImageHistory,
    restoreNodeMediaFromLatestImageHistory,
    sameHistoryIdentity,
    snapshotNodeImageHistoryBeforeRegenerate,
    stampHistoryItemAssetId,
    stepCanvasNodeImageHistory,
    syncDiscoveredCanvasNodeHistory,
    upsertCanvasImageHistory,
} from "@/lib/canvas/canvas-image-history";
import { cancelIncompleteImageBatch } from "@/lib/canvas/canvas-image-batch-retry";
import {
    discoverNodeImageHistoryFromTasks,
    filterPersistableDiscoveredHistoryItems,
    resolveCanvasNodeImageHistoryWithTasks,
} from "@/lib/canvas/canvas-image-history-tasks";
import { buildSettledUploadNodeMetadata } from "@/lib/canvas/canvas-file-upload";
import { isCanvasImageSourceNode } from "@/lib/canvas/canvas-image-source";
import { canvasNodeToAsset } from "@/lib/canvas/canvas-node-asset";
import { isolateCopiedNodeMetadata } from "@/lib/canvas/canvas-node-copy";
import { canvasNodeSearchContext, searchCanvasNodes } from "@/lib/canvas/canvas-node-search";
import { applyNodeConfigPatch } from "@/lib/canvas/canvas-project-domain";
import { buildCanvasResourceReferences } from "@/lib/canvas/canvas-resource-references";
import { resolveNodeToolbarPlacement, resolveToolbarTools, type ToolContext, type ToolbarHandlers } from "@/lib/canvas/tool-registry";
import type { GenerationTask } from "@/services/api/task-center";
import type { Asset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasImageHistoryItem, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

function makeImageNode(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id: "img-node-1",
        type: CanvasNodeType.Image,
        title: "镜头主画面",
        position: { x: 100, y: 120 },
        width: 480,
        height: 270,
        metadata: {
            status: "success",
            content: "/api/resources/res-v1/file",
            storageKey: "resource:res-v1",
            assetId: "asset-v1",
            naturalWidth: 1920,
            naturalHeight: 1080,
            bytes: 1_572_864,
            mimeType: "image/png",
            model: "seedream-3.0",
            size: "16:9",
            quality: "2K",
            prompt: "雨夜霓虹街角，电影级冷暖光对比",
            taskId: "task-v1",
            taskCompletedAt: "2026-11-16T08:00:00.000Z",
        },
        ...overrides,
    };
}

const mockMediaIO = {
    resolveImageUrl: async (_key?: string, fallback?: string) => fallback || "/api/resources/res-fallback/file",
    uploadImage: async () => { throw new Error("should reuse owned resource"); },
    resolveMediaUrl: async (_key?: string, fallback?: string) => fallback || "",
    storeGeneratedVideo: async () => { throw new Error("unused"); },
    storeGeneratedAudio: async () => { throw new Error("unused"); },
    fetchBlob: async () => new Blob(),
};

function makeAsset(id: string, resourceId: string, width = 1920, height = 1080): Asset {
    return {
        id,
        kind: "image",
        title: id,
        tags: [],
        createdAt: "2026-11-16T08:00:00.000Z",
        updatedAt: "2026-11-16T08:00:00.000Z",
        data: { dataUrl: `/api/resources/${resourceId}/file`, storageKey: `resource:${resourceId}`, width, height },
    };
}

describe("canvas image node history stack & viewer workbench", () => {
    test("accumulates multiple in-place regenerations and keeps active shot synced with downstream references", async () => {
        const initial = makeImageNode();
        const beforeSecond = snapshotNodeImageHistoryBeforeRegenerate(initial);
        expect(beforeSecond).toHaveLength(1);
        expect(beforeSecond?.[0]?.storageKey).toBe("resource:res-v1");

        const loadingSecond: CanvasNodeData = {
            ...initial,
            metadata: {
                status: "loading",
                prompt: "清晨薄雾森林，丁达尔体积光",
                composerContent: "清晨薄雾森林，丁达尔体积光",
                model: "seedream-4.0",
                size: "21:9",
                quality: "1K",
                imageHistory: beforeSecond,
            },
        };

        const secondTask: GenerationTask = {
            id: "task-v2",
            type: "canvas_image",
            status: "succeeded",
            prompt: "清晨薄雾森林，丁达尔体积光",
            model: "seedream-4.0",
            attempts: 1,
            createdAt: "2026-11-16T08:05:00.000Z",
            completedAt: "2026-11-16T08:05:12.000Z",
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-v2" }],
            resultJson: JSON.stringify({
                images: [{ storageKey: "resource:res-v2", url: "/api/resources/res-v2/file", width: 1536, height: 640, bytes: 980_000, mimeType: "image/png" }],
            }),
        };

        const afterSecond = await buildGenerationTaskNodeResult(loadingSecond, secondTask, [loadingSecond], mockMediaIO);

        const history = resolveCanvasNodeImageHistory(afterSecond);
        expect(history).toHaveLength(2);
        expect(history.map((item) => item.storageKey)).toEqual(["resource:res-v1", "resource:res-v2"]);
        expect(activeImageHistoryIndex(afterSecond, history)).toBe(1);
        expect(afterSecond.metadata?.storageKey).toBe("resource:res-v2");

        const assets: Asset[] = [
            makeAsset("asset-v1", "res-v1", 1920, 1080),
            makeAsset("asset-v2", "res-v2", 1536, 640),
        ];

        const switchedToV1 = stepCanvasNodeImageHistory(afterSecond, -1, assets);
        expect(switchedToV1.metadata?.storageKey).toBe("resource:res-v1");
        expect(switchedToV1.metadata?.assetId).toBe("asset-v1");
        expect(switchedToV1.metadata?.naturalWidth).toBe(1920);
        expect(switchedToV1.metadata?.naturalHeight).toBe(1080);

        const videoDownstream: CanvasNodeData = {
            id: "video-target",
            type: CanvasNodeType.Video,
            title: "镜头视频",
            position: { x: 700, y: 120 },
            width: 420,
            height: 236,
            metadata: { prompt: "@图片1 镜头缓缓推进" },
        };
        const refs = buildCanvasResourceReferences(
            [switchedToV1, videoDownstream],
            [{ id: "conn-1", fromNodeId: switchedToV1.id, toNodeId: videoDownstream.id }],
            videoDownstream.id,
        );
        expect(refs[0]?.previewUrl).toBe("/api/resources/res-v1/file");
    });

    test("preserves distinct per-version prompt/model/size/quality across primary switch, parameter recall, and third regeneration", async () => {
        const assets: Asset[] = [
            makeAsset("asset-v1", "res-v1", 1920, 1080),
            makeAsset("asset-v2", "res-v2", 1536, 640),
            makeAsset("asset-v3", "res-v3", 1024, 1024),
        ];
        const v1Node = makeImageNode({
            metadata: {
                status: "success",
                content: "/api/resources/res-v1/file",
                storageKey: "resource:res-v1",
                assetId: "asset-v1",
                naturalWidth: 1920,
                naturalHeight: 1080,
                model: "old-model",
                size: "16:9",
                quality: "2K",
                prompt: "OLD PROMPT V1",
                taskId: "task-v1",
                taskCompletedAt: "2026-11-16T08:00:00.000Z",
            },
        });
        const loadingV2: CanvasNodeData = {
            ...v1Node,
            metadata: {
                status: "loading",
                prompt: "NEW PROMPT V2",
                composerContent: "NEW PROMPT V2",
                model: "new-model",
                size: "21:9",
                quality: "1K",
                imageHistory: snapshotNodeImageHistoryBeforeRegenerate(v1Node),
            },
        };
        const taskV2: GenerationTask = {
            id: "task-v2",
            type: "canvas_image",
            status: "succeeded",
            prompt: "NEW PROMPT V2",
            model: "new-model",
            attempts: 1,
            createdAt: "2026-11-16T08:05:00.000Z",
            completedAt: "2026-11-16T08:05:10.000Z",
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-v2" }],
            resultJson: JSON.stringify({
                images: [{ storageKey: "resource:res-v2", url: "/api/resources/res-v2/file", width: 1536, height: 640 }],
            }),
        };
        const afterV2 = stampHistoryItemAssetId(
            { ...(await buildGenerationTaskNodeResult(loadingV2, taskV2, [loadingV2], mockMediaIO)), metadata: { ...(await buildGenerationTaskNodeResult(loadingV2, taskV2, [loadingV2], mockMediaIO)).metadata, assetId: "asset-v2" } },
            { id: "task-v2:0", storageKey: "resource:res-v2" },
            "asset-v2",
        );

        // 1. Switch primary back to v1: neither v1 nor v2 loses archived generation fields, and live composer config is untouched.
        const initialList = resolveCanvasNodeImageHistory(afterV2);
        const switchedToV1 = applyPrimaryImageHistoryItem(afterV2, initialList[0]!, assets);
        expect(switchedToV1.metadata?.prompt).toBe("NEW PROMPT V2");
        expect(switchedToV1.metadata?.model).toBe("new-model");
        const resolvedAfterSwitch = resolveCanvasNodeImageHistory(switchedToV1);
        expect(resolvedAfterSwitch[0]).toMatchObject({
            id: "task-v1:0",
            prompt: "OLD PROMPT V1",
            model: "old-model",
            size: "16:9",
            quality: "2K",
        });
        expect(resolvedAfterSwitch[1]).toMatchObject({
            id: "task-v2:0",
            prompt: "NEW PROMPT V2",
            model: "new-model",
            size: "21:9",
            quality: "1K",
        });

        // 2. Recall v1 parameters into composer via applyNodeConfigPatch: composerContent & model update cleanly, prompt snapshot stays intact.
        const nodeWithModelSpecific = {
            ...switchedToV1,
            metadata: { ...switchedToV1.metadata, seedreamMode: "sequential", transparentBackground: "true" },
        };
        const recallPatch: Partial<CanvasNodeMetadata> = {
            composerContent: "OLD PROMPT V1",
            model: "old-model",
            size: "16:9",
            quality: "2K",
        };
        const afterRecall = applyNodeConfigPatch(nodeWithModelSpecific, recallPatch);
        expect(afterRecall.metadata?.prompt).toBe("NEW PROMPT V2");
        expect(afterRecall.metadata?.composerContent).toBe("OLD PROMPT V1");
        expect(afterRecall.metadata?.model).toBe("old-model");
        expect(afterRecall.metadata?.seedreamMode).toBeUndefined();
        expect(afterRecall.metadata?.transparentBackground).toBeUndefined();
        const resolvedAfterRecall = resolveCanvasNodeImageHistory(afterRecall);
        expect(resolvedAfterRecall[0]).toMatchObject({
            id: "task-v1:0",
            prompt: "OLD PROMPT V1",
            model: "old-model",
            size: "16:9",
            quality: "2K",
        });

        // 3. Regenerate v3 with a third config: v1, v2, and v3 all retain distinct archived parameters.
        const loadingV3: CanvasNodeData = {
            ...afterRecall,
            metadata: {
                status: "loading",
                prompt: "THIRD PROMPT V3",
                composerContent: "THIRD PROMPT V3",
                model: "third-model",
                size: "1:1",
                quality: "4K",
                imageHistory: snapshotNodeImageHistoryBeforeRegenerate(afterRecall),
            },
        };
        const taskV3: GenerationTask = {
            id: "task-v3",
            type: "canvas_image",
            status: "succeeded",
            prompt: "THIRD PROMPT V3",
            model: "third-model",
            attempts: 1,
            createdAt: "2026-11-16T08:10:00.000Z",
            completedAt: "2026-11-16T08:10:09.000Z",
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-v3" }],
            resultJson: JSON.stringify({
                images: [{ storageKey: "resource:res-v3", url: "/api/resources/res-v3/file", width: 1024, height: 1024 }],
            }),
        };
        const afterV3 = await buildGenerationTaskNodeResult(loadingV3, taskV3, [loadingV3], mockMediaIO);
        const finalList = resolveCanvasNodeImageHistory(afterV3);
        expect(finalList).toHaveLength(3);
        expect(finalList.map((entry) => ({ id: entry.id, prompt: entry.prompt, model: entry.model, size: entry.size, quality: entry.quality }))).toEqual([
            { id: "task-v1:0", prompt: "OLD PROMPT V1", model: "old-model", size: "16:9", quality: "2K" },
            { id: "task-v2:0", prompt: "NEW PROMPT V2", model: "new-model", size: "21:9", quality: "1K" },
            { id: "task-v3:0", prompt: "THIRD PROMPT V3", model: "third-model", size: "1:1", quality: "4K" },
        ]);
    });

    test("never stores base64 data URLs in imageHistory and caps at 50 items while protecting active primary", () => {
        let history: CanvasImageHistoryItem[] = [];
        for (let idx = 0; idx < 56; idx++) {
            history = upsertCanvasImageHistory(history, {
                id: `task-${idx}:0`,
                taskId: `task-${idx}`,
                outputIndex: 0,
                storageKey: `resource:res-${idx}`,
                content: `data:image/png;base64,AAAA${idx}`,
                prompt: `第 ${idx} 次抽卡`,
            }, {
                id: "task-0:0",
                storageKey: "resource:res-0",
            });
        }
        expect(history).toHaveLength(MAX_CANVAS_IMAGE_HISTORY);
        expect(history.some((item) => item.id === "task-0:0")).toBe(true);
        expect(history.every((item) => !item.content?.startsWith("data:"))).toBe(true);
        expect(history[0]?.content).toBe("/api/resources/res-0/file");
    });

    test("guards primary switching against loading, retrievable, and unbound resource assets", () => {
        const v1: CanvasImageHistoryItem = {
            id: "task-v1:0",
            taskId: "task-v1",
            storageKey: "resource:res-v1",
            content: "/api/resources/res-v1/file",
            prompt: "第一版",
        };
        const retrievableNode: CanvasNodeData = {
            ...makeImageNode(),
            metadata: {
                status: "error",
                taskId: "task-paid-pending",
                taskStatus: "succeeded",
                taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
                imageHistory: [v1],
            },
        };
        expect(planPrimaryImageHistorySwitch(retrievableNode, v1)).toEqual({ ok: false, reason: "retrievable" });
        expect(applyPrimaryImageHistoryItem(retrievableNode, v1)).toBe(retrievableNode);

        const loadingNode: CanvasNodeData = {
            ...makeImageNode(),
            metadata: {
                status: "loading",
                imageHistory: [v1],
            },
        };
        expect(planPrimaryImageHistorySwitch(loadingNode, v1)).toEqual({ ok: false, reason: "loading" });

        // Task-discovered item with no owned Asset in store requires async asset ensure before commit.
        const activeV2Node = makeImageNode({
            metadata: {
                status: "success",
                content: "/api/resources/res-v2/file",
                storageKey: "resource:res-v2",
                assetId: "asset-v2",
                taskId: "task-v2",
                imageHistory: [
                    v1,
                    { id: "task-v2:0", taskId: "task-v2", storageKey: "resource:res-v2", content: "/api/resources/res-v2/file", assetId: "asset-v2" },
                ],
            },
        });
        const onlyV2Asset: Asset[] = [makeAsset("asset-v2", "res-v2")];
        const plan = planPrimaryImageHistorySwitch(activeV2Node, v1, onlyV2Asset);
        expect(plan.ok).toBe(true);
        if (plan.ok) {
            expect(plan.needsAssetEnsure).toBe(true);
            expect(plan.node.metadata?.assetId).toBeUndefined();
            const stamped = stampHistoryItemAssetId(plan.node, plan.item, "asset-v1-ensured");
            expect(stamped.metadata?.assetId).toBe("asset-v1-ensured");
            expect(stamped.metadata?.imageHistory?.find((entry) => entry.id === "task-v1:0")?.assetId).toBe("asset-v1-ensured");
        }
        // Synchronous helper must never replace a valid assetId with an unensured resource node.
        expect(applyPrimaryImageHistoryItem(activeV2Node, v1, onlyV2Asset)).toBe(activeV2Node);
    });

    test("durably removes task-discovered and persisted non-primary versions without task backfill resurrection", () => {
        const node = makeImageNode();
        const olderTask: GenerationTask = {
            id: "task-v0",
            projectId: "proj-1",
            type: "canvas_image",
            status: "succeeded",
            prompt: "旧版构图草稿",
            model: "gpt-image-1",
            attempts: 1,
            createdAt: "2026-11-16T07:30:00.000Z",
            completedAt: "2026-11-16T07:30:10.000Z",
            clientContext: { nodeId: node.id, source: "canvas" },
            inputJson: JSON.stringify({ mode: "image", config: { size: "21:9", quality: "1K" }, metadata: { nodeId: node.id } }),
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-v0" }],
        };
        const discovered = discoverNodeImageHistoryFromTasks(node.id, [olderTask]);
        const merged = resolveCanvasNodeImageHistoryWithTasks(node, [olderTask]);
        expect(merged.map((item) => item.id)).toEqual(["task-v0:0", "task-v1:0"]);
        expect(merged[0]?.size).toBe("21:9");
        expect(merged[0]?.quality).toBe("1K");

        // Remove task-v0:0 directly from a pre-upgrade node (where task-v0:0 only existed in task discovery)
        const afterRemove = removeCanvasImageHistoryItem(node, "task-v0:0", [makeAsset("asset-v1", "res-v1")], discovered);
        expect(afterRemove.metadata?.imageHistoryRemovedIds).toContain("task-v0:0");
        expect(afterRemove.metadata?.imageHistory?.map((item) => item.id)).toEqual(["task-v1:0"]);

        // Re-running task backfill with the exact same task list MUST NOT re-add task-v0:0
        const reResolved = resolveCanvasNodeImageHistoryWithTasks(afterRemove, [olderTask]);
        expect(reResolved.map((item) => item.id)).toEqual(["task-v1:0"]);

        // Syncing discovered task history onto a pre-upgrade node makes node badge & stepping agree with viewer
        const syncedPreUpgrade = syncDiscoveredCanvasNodeHistory(node, discovered);
        const syncedBadgeHtml = renderToStaticMarkup(
            <CanvasHistoryStackBadge node={syncedPreUpgrade} theme={canvasThemes.dark} interactiveSwitch onStepHistory={() => {}} />,
        );
        expect(syncedBadgeHtml).toContain("2/2");
    });

    test("keeps composer prompt/model when switching to an archived entry lacking optional fields, and hides error restore in readOnly mode", async () => {
        const assets: Asset[] = [makeAsset("asset-upload", "res-upload"), makeAsset("asset-gen", "res-gen")];
        const nodeWithUploadHistory = makeImageNode({
            metadata: {
                status: "success",
                content: "/api/resources/res-gen/file",
                storageKey: "resource:res-gen",
                assetId: "asset-gen",
                prompt: "KEEP THIS PROMPT",
                composerContent: "KEEP THIS DRAFT",
                model: "seedream-4.0",
                size: "21:9",
                quality: "2K",
                imageHistory: [
                    { id: "storage:resource:res-upload", storageKey: "resource:res-upload", content: "/api/resources/res-upload/file", assetId: "asset-upload" },
                    { id: "task-gen:0", taskId: "task-gen", storageKey: "resource:res-gen", content: "/api/resources/res-gen/file", assetId: "asset-gen", prompt: "KEEP THIS PROMPT", model: "seedream-4.0" },
                ],
            },
        });
        const switched = applyPrimaryImageHistoryItem(nodeWithUploadHistory, nodeWithUploadHistory.metadata!.imageHistory![0]!, assets);
        expect(switched.metadata?.storageKey).toBe("resource:res-upload");
        expect(switched.metadata?.prompt).toBe("KEEP THIS PROMPT");
        expect(switched.metadata?.composerContent).toBe("KEEP THIS DRAFT");
        expect(switched.metadata?.model).toBe("seedream-4.0");
        expect(switched.metadata?.quality).toBe("2K");

        // Read-only error node must not render "恢复上一版图片" or allow executePrimaryImageHistorySwitch
        const erroredNode: CanvasNodeData = {
            ...nodeWithUploadHistory,
            metadata: { ...nodeWithUploadHistory.metadata, status: "error", errorDetails: "上游超时" },
        };
        const baseContentProps = {
            node: erroredNode,
            theme: canvasThemes.dark,
            isEditingContent: false,
            textareaRef: createRef<HTMLTextAreaElement>(),
            isBatchRoot: false,
            batchCount: 0,
            batchExpanded: false,
            batchOpening: false,
            batchRecovering: false,
            onContentChange: () => {},
            onStopEditing: () => {},
            mentionReferences: [],
        };
        const editableErrorHtml = renderToStaticMarkup(
            <CanvasNodeActionContext.Provider value={{ restorePreviousHistoryImage: () => {} }}>
                <CanvasNodeContent {...baseContentProps} readOnly={false} />
            </CanvasNodeActionContext.Provider>,
        );
        const readonlyErrorHtml = renderToStaticMarkup(
            <CanvasNodeActionContext.Provider value={{ restorePreviousHistoryImage: () => {} }}>
                <CanvasNodeContent {...baseContentProps} readOnly />
            </CanvasNodeActionContext.Provider>,
        );
        expect(editableErrorHtml).toContain("恢复上一版图片");
        expect(readonlyErrorHtml).not.toContain("恢复上一版图片");

        let committed = false;
        const readonlyResult = await executePrimaryImageHistorySwitch({
            nodeId: erroredNode.id,
            targetItem: erroredNode.metadata!.imageHistory![0]!,
            readOnly: true,
            getNodes: () => [erroredNode],
            getAssets: () => assets,
            ensureAsset: async () => ({ assetId: "asset-upload", confirmed: true }),
            commitNode: () => { committed = true; },
        });
        expect(readonlyResult).toBe(false);
        expect(committed).toBe(false);
    });

    test("scopes task backfill away from upload-replaced nodes, drops unverified resources, and aligns asset/copy/search with active version", () => {
        const oldTask: GenerationTask = {
            id: "task-before-upload",
            projectId: "proj-1",
            type: "canvas_image",
            status: "succeeded",
            prompt: "OLD GENERATED PROMPT",
            model: "seedream-3.0",
            attempts: 1,
            createdAt: "2026-11-16T07:00:00.000Z",
            completedAt: "2026-11-16T07:00:10.000Z",
            clientContext: { nodeId: "img-node-1", source: "canvas" },
            inputJson: JSON.stringify({ mode: "image", config: { size: "16:9", quality: "2K" }, metadata: { nodeId: "img-node-1" } }),
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-old-gen" }],
        };

        // (a) Generated node whose media was replaced by a local upload must NOT re-discover old tasks or regain generator UI
        const generatedNode = makeImageNode({
            metadata: {
                ...makeImageNode().metadata,
                resultOrigin: "generated",
            },
        });
        const replacedMeta = buildSettledUploadNodeMetadata(
            generatedNode.metadata,
            {
                content: "/api/resources/res-uploaded/file",
                storageKey: "resource:res-uploaded",
                status: "success",
                resultOrigin: "upload",
                nodeRole: "result",
            },
            { replace: true },
        );
        const uploadReplacedNode: CanvasNodeData = { ...generatedNode, metadata: replacedMeta };
        expect(uploadReplacedNode.metadata?.imageHistoryResetAt).toBeTruthy();
        expect(discoverNodeImageHistoryFromTasks(uploadReplacedNode, [oldTask])).toEqual([]);
        const syncedUploadNode = syncDiscoveredCanvasNodeHistory(
            uploadReplacedNode,
            discoverNodeImageHistoryFromTasks(uploadReplacedNode, [oldTask]),
        );
        expect(syncedUploadNode.metadata?.imageHistory).toBeUndefined();
        expect(isCanvasImageSourceNode(syncedUploadNode)).toBe(true);

        // (b) Task-discovered item with a GC-deleted/unready resource is excluded before persisting
        const deletedTask: GenerationTask = {
            ...oldTask,
            id: "task-deleted-res",
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-deleted" }],
        };
        const rawDiscovered = discoverNodeImageHistoryFromTasks(generatedNode, [oldTask, deletedTask]);
        expect(rawDiscovered.map((item) => item.id)).toEqual(["task-before-upload:0", "task-deleted-res:0"]);
        const persistable = filterPersistableDiscoveredHistoryItems(rawDiscovered, new Set(["res-old-gen"]));
        expect(persistable.map((item) => item.id)).toEqual(["task-before-upload:0"]);

        // (c) Switching primary to task-discovered v0 makes canvasNodeToAsset, isolateCopiedNodeMetadata, and search use v0's prompt/model/size/quality
        const plan = planPrimaryImageHistorySwitch(generatedNode, persistable[0]!);
        expect(plan.ok).toBe(true);
        if (plan.ok) {
            const mintedAsset = canvasNodeToAsset(plan.node, { canvasId: "canvas-1", source: "canvas-generation" });
            expect(mintedAsset?.title).toBe("OLD GENERATED PROMPT");
            expect(mintedAsset?.metadata?.prompt).toBe("OLD GENERATED PROMPT");
            expect(mintedAsset?.metadata?.taskId).toBe("task-before-upload");

            const copiedMeta = isolateCopiedNodeMetadata(plan.node, new Map());
            expect(copiedMeta.prompt).toBe("OLD GENERATED PROMPT");
            expect(copiedMeta.composerContent).toBe("OLD GENERATED PROMPT");
            expect(copiedMeta.model).toBe("seedream-3.0");
            expect(copiedMeta.size).toBe("16:9");
            expect(copiedMeta.quality).toBe("2K");
            expect(copiedMeta.imageHistory).toBeUndefined();

            expect(canvasNodeSearchContext(plan.node)).toBe("OLD GENERATED PROMPT");
            expect(searchCanvasNodes([plan.node], "OLD GENERATED PROMPT")).toHaveLength(1);
            expect(searchCanvasNodes([plan.node], "seedream-3.0")).toHaveLength(1);
        }
    });

    test("renders generation info sidebar with valid CSS tokens, all 7 metadata fields, and hover toolbar info utility", () => {
        const node = makeImageNode({
            metadata: {
                ...makeImageNode().metadata,
                size: "21:9",
                quality: "1K",
                naturalWidth: 1536,
                naturalHeight: 640,
                bytes: 1_929_380,
                imageHistory: [
                    { id: "task-0:0", storageKey: "resource:res-0", content: "/api/resources/res-0/file", prompt: "初版" },
                    {
                        id: "task-v1:0",
                        taskId: "task-v1",
                        storageKey: "resource:res-v1",
                        content: "/api/resources/res-v1/file",
                        naturalWidth: 1536,
                        naturalHeight: 640,
                        bytes: 1_929_380,
                        mimeType: "image/png",
                        model: "seedream-3.0",
                        size: "21:9",
                        quality: "1K",
                        prompt: "古老石殿走廊，一束天光斜射入尘埃中",
                        createdAt: "2026-11-16T08:00:00.000Z",
                    },
                ],
            },
        });

        const badgeHtml = renderToStaticMarkup(
            <CanvasHistoryStackBadge node={node} theme={canvasThemes.dark} interactiveSwitch onStepHistory={() => {}} />,
        );
        expect(badgeHtml).toContain("2/2");
        expect(badgeHtml).toContain("切换上一版生成图");
        expect(badgeHtml).not.toContain(")eb");

        const sidebarHtml = renderToStaticMarkup(
            <CanvasImageInfoSidebar
                node={node}
                item={node.metadata!.imageHistory![1]!}
                inspectTarget="A"
                inCompareMode={false}
                config={{ channels: [], model: "seedream-3.0" } as unknown as AiConfig}
                theme={canvasThemes.dark}
            />,
        );
        expect(sidebarHtml).toContain("古老石殿走廊，一束天光斜射入尘埃中");
        expect(sidebarHtml).toContain("seedream-3.0");
        expect(sidebarHtml).toContain("21:9");
        expect(sidebarHtml).toContain("1K");
        expect(sidebarHtml).toContain("1536 × 640 px");
        expect(sidebarHtml).toContain("PNG");

        let openedViewerNode: CanvasNodeData | null = null;
        let openedInspectorNode: CanvasNodeData | null = null;
        const toolCtx: ToolContext = {
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
            handlers: {
                onNodeViewImage: (target) => { openedViewerNode = target; },
                onNodeInfo: (target) => { openedInspectorNode = target; },
            } as ToolbarHandlers,
        };
        const resolvedTools = resolveToolbarTools("node-hover", toolCtx, null);
        const generationInfoTool = resolvedTools.find((t) => t.id === "generationInfo")!;
        const nodeInfoTool = resolvedTools.find((t) => t.id === "info")!;
        expect(resolveNodeToolbarPlacement(generationInfoTool, toolCtx).group).toBe("utility");
        expect(resolveNodeToolbarPlacement(nodeInfoTool, toolCtx).group).toBe("more");
        generationInfoTool.run(toolCtx);
        nodeInfoTool.run(toolCtx);
        expect(openedViewerNode?.id).toBe(node.id);
        expect(openedInspectorNode?.id).toBe(node.id);

        const shelfHtml = renderToStaticMarkup(
            <ConnectedReferenceShelf
                references={[{ id: "r1", nodeId: "n1", kind: "image", label: "图片1", title: "石殿参考", active: true, previewUrl: "https://example.com/ref.png" }]}
                theme={canvasThemes.light}
                onInsert={() => {}}
            />,
        );
        expect(shelfHtml).toContain('title="预览 石殿参考"');
        expect(shelfHtml).toContain('title="插入 @石殿参考"');
    });

    test("handles failed and cancelled first in-place regeneration without blank success state, preserves distinct resources on id collision, and keeps node inspector reachable", () => {
        const original = makeImageNode({
            metadata: {
                ...makeImageNode().metadata,
                assetTags: ["角色: 林默"],
                assetCategory: "character",
            },
        });
        const preservedHistory = snapshotNodeImageHistoryBeforeRegenerate(original)!;
        expect(preservedHistory).toHaveLength(1);

        // (a) Failed first in-place regeneration: node has no current media, activeImageHistoryIndex is -1,
        // ErrorContent surfaces 恢复上一版图片, and badge surfaces 历史 1 so sole saved shot is reachable.
        const failedNode: CanvasNodeData = {
            ...original,
            metadata: {
                status: "error",
                errorDetails: "上游请求超时",
                prompt: "第二版失败提示词",
                imageHistory: preservedHistory,
            },
        };
        const items = resolveCanvasNodeImageHistory(failedNode);
        expect(items).toHaveLength(1);
        expect(activeImageHistoryIndex(failedNode, items)).toBe(-1);
        expect(resolveActiveCanvasImageHistoryItem(failedNode)).toBeUndefined();

        const failedBadgeHtml = renderToStaticMarkup(
            <CanvasHistoryStackBadge node={failedNode} theme={canvasThemes.dark} interactiveSwitch onStepHistory={() => {}} />,
        );
        expect(failedBadgeHtml).toContain("历史 1");

        const steppedBack = stepCanvasNodeImageHistory(failedNode, -1, [makeAsset("asset-v1", "res-v1")]);
        expect(steppedBack.metadata?.status).toBe("success");
        expect(steppedBack.metadata?.storageKey).toBe("resource:res-v1");

        // (b) Cancelled first in-place regeneration: cancelIncompleteImageBatch restores previous shot automatically.
        const loadingInPlaceNode: CanvasNodeData = {
            ...original,
            metadata: {
                status: "loading",
                prompt: "取消中的第二版",
                imageHistory: preservedHistory,
            },
        };
        const cancelled = cancelIncompleteImageBatch(loadingInPlaceNode.id, [], [loadingInPlaceNode], []);
        const restoredAfterCancel = cancelled.nodes[0]!;
        expect(restoredAfterCancel.metadata?.status).toBe("success");
        expect(restoredAfterCancel.metadata?.storageKey).toBe("resource:res-v1");
        expect(restoredAfterCancel.metadata?.assetId).toBe("asset-v1");
        expect(restoreNodeMediaFromLatestImageHistory(loadingInPlaceNode).metadata?.storageKey).toBe("resource:res-v1");

        // Unbound resource in history without assetId must NOT be synchronously placed onto top-level metadata on cancel
        const unboundHistoryNode: CanvasNodeData = {
            ...original,
            metadata: {
                status: "loading",
                imageHistory: [
                    {
                        id: "task-unbound:0",
                        taskId: "task-unbound",
                        storageKey: "resource:res-unbound",
                        content: "/api/resources/res-unbound/file",
                    },
                ],
            },
        };
        const cancelledUnbound = cancelIncompleteImageBatch(unboundHistoryNode.id, [], [unboundHistoryNode], []).nodes[0]!;
        expect(cancelledUnbound.metadata?.status).toBe("idle");
        expect(cancelledUnbound.metadata?.storageKey).toBeUndefined();
        expect(cancelledUnbound.metadata?.content).toBeUndefined();
        expect(cancelledUnbound.metadata?.imageHistory).toHaveLength(1);

        // (c) Distinct storageKeys never collide even if an external path produced matching taskId:outputIndex ids.
        const collidingOld: CanvasImageHistoryItem = {
            id: "task-new:0",
            storageKey: "resource:res-old",
            content: "/api/resources/res-old/file",
        };
        const collidingNew: CanvasImageHistoryItem = {
            id: "task-new:0",
            taskId: "task-new",
            outputIndex: 0,
            storageKey: "resource:res-new",
            content: "/api/resources/res-new/file",
        };
        expect(sameHistoryIdentity(collidingOld, collidingNew)).toBe(false);
        expect(upsertCanvasImageHistory([collidingOld], collidingNew).map((item) => item.storageKey)).toEqual([
            "resource:res-old",
            "resource:res-new",
        ]);
    });
});
