import { describe, expect, test } from "bun:test";

import { rebaseCanvasDocumentThreeWay } from "../src/lib/canvas/canvas-document-rebase";
import { mergeCanvasRefreshPatch } from "../src/lib/canvas/canvas-patch-merge";
import { readNodeTaskOutcome } from "../src/lib/task-outcome";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, title: string, metadata: CanvasNodeData["metadata"] = {}, position = { x: 0, y: 0 }): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title, position, width: 320, height: 220, metadata };
}

function project(nodes: CanvasNodeData[], revision: number, title = "画布"): CanvasProject {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

describe("rebaseCanvasDocumentThreeWay replacement, attemptId, and manual geometry", () => {
    test("portrait video replacement settles cleanly and missing-base divergent title/position keeps local while marking conflict", () => {
        const basePortraitVid: CanvasNodeData = {
            id: "vid-replace",
            type: CanvasNodeType.Video,
            title: "镜头一",
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/old.mp4",
                storageKey: "resource:old-vid",
                status: "success",
                taskId: "task-old",
                prompt: "人物转身",
                locked: true,
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };
        const replacingVidPlaceholder: CanvasNodeData = {
            ...basePortraitVid,
            width: 720,
            height: 405,
            metadata: {
                content: "https://example.test/old.mp4",
                storageKey: "resource:old-vid",
                status: undefined,
                fileUpload: "uploading",
                fileUploadProgress: 70,
            },
        };
        const settledReplacementVid: CanvasNodeData = {
            ...basePortraitVid,
            position: { x: 400, y: -241 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/new.mp4",
                storageKey: "resource:new-vid",
                status: "success",
                prompt: "人物转身",
                locked: true,
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };

        const replacedOverRemotePlaceholder = rebaseCanvasDocumentThreeWay({
            base: project([basePortraitVid], 10),
            local: project([settledReplacementVid], 10),
            remote: project([replacingVidPlaceholder], 11),
        });
        expect(replacedOverRemotePlaceholder.conflict).toBe(false);
        const mergedVid = replacedOverRemotePlaceholder.project.nodes[0]!;
        expect(mergedVid.width).toBe(420);
        expect(mergedVid.height).toBe(746);
        expect(mergedVid.position).toEqual({ x: 400, y: -241 });
        expect(mergedVid.metadata?.content).toBe("https://example.test/new.mp4");
        expect(mergedVid.metadata?.status).toBe("success");
        expect(mergedVid.metadata?.fileUpload).toBeUndefined();
        expect(mergedVid.metadata?.taskId).toBeUndefined();
        expect(mergedVid.metadata?.prompt).toBe("人物转身");
        expect(mergedVid.metadata?.locked).toBe(true);

        const replacedOverAncientBarePlaceholder = rebaseCanvasDocumentThreeWay({
            base: project([basePortraitVid], 10),
            local: project([settledReplacementVid], 10),
            remote: project([{
                id: "vid-replace",
                type: CanvasNodeType.Video,
                title: "raw.mp4",
                position: { x: 0, y: 0 },
                width: 720,
                height: 405,
                metadata: { fileUpload: "uploading", bytes: 9000, mimeType: "video/mp4" },
            }], 11),
        });
        expect(replacedOverAncientBarePlaceholder.conflict).toBe(false);
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.position).toEqual({ x: 400, y: -241 });
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.title).toBe("镜头一");
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.metadata?.prompt).toBe("人物转身");
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.metadata?.locked).toBe(true);

        const scriptUploading: CanvasNodeData = {
            id: "script-1",
            type: CanvasNodeType.Text,
            title: "ep1.txt",
            position: { x: 50, y: 60 },
            width: 360,
            height: 240,
            metadata: { fileUpload: "uploading" },
        };
        const scriptSettled: CanvasNodeData = {
            ...scriptUploading,
            title: "ep1",
            metadata: { content: "第一集正文", prompt: "第一集正文", storageKey: "resource:ep1", status: "success" },
        };
        const scriptRebased = rebaseCanvasDocumentThreeWay({
            base: project([], 10),
            local: project([scriptUploading], 10),
            remote: project([scriptSettled], 11),
        });
        expect(scriptRebased.conflict).toBe(false);
        expect(scriptRebased.project.nodes[0]?.title).toBe("ep1");
        expect(scriptRebased.project.nodes[0]?.metadata?.status).toBe("success");

        const localRawSettled = node("new-remote-edit", "raw_123.png", {
            content: "https://example.test/hero.png",
            storageKey: "resource:hero",
            status: "success",
        }, { x: 100, y: 100 });
        const remoteRenamedDraggedUploading = node("new-remote-edit", "主角设定", {
            fileUpload: "uploading",
            fileUploadProgress: 50,
        }, { x: 300, y: 300 });
        const remoteEditedMissingBase = rebaseCanvasDocumentThreeWay({
            base: project([], 10),
            local: project([localRawSettled], 10),
            remote: project([remoteRenamedDraggedUploading], 11),
        });
        expect(remoteEditedMissingBase.conflict).toBe(true);
        expect(remoteEditedMissingBase.project.nodes[0]?.title).toBe("raw_123.png");
        expect(remoteEditedMissingBase.project.nodes[0]?.position).toEqual({ x: 100, y: 100 });
        expect(remoteEditedMissingBase.project.nodes[0]?.metadata?.status).toBe("success");
        expect(remoteEditedMissingBase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();

        const localUploadingWithExt: CanvasNodeData = {
            id: "new-local-ext",
            type: CanvasNodeType.Video,
            title: "Final.mp4",
            position: { x: 400, y: 300 },
            width: 720,
            height: 405,
            metadata: { fileUpload: "uploading", bytes: 9000, mimeType: "video/mp4" },
        };
        const remoteSettledRawVid: CanvasNodeData = {
            id: "new-local-ext",
            type: CanvasNodeType.Video,
            title: "raw.mp4",
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/raw.mp4",
                storageKey: "resource:raw-vid",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };
        const localExtMissingBase = rebaseCanvasDocumentThreeWay({
            base: project([], 10),
            local: project([localUploadingWithExt], 10),
            remote: project([remoteSettledRawVid], 11),
        });
        expect(localExtMissingBase.conflict).toBe(true);
        expect(localExtMissingBase.project.nodes[0]?.title).toBe("Final.mp4");
        expect(localExtMissingBase.project.nodes[0]?.width).toBe(420);
        expect(localExtMissingBase.project.nodes[0]?.height).toBe(746);
        expect(localExtMissingBase.project.nodes[0]?.position).toEqual({ x: 550, y: 129.5 });
        expect(localExtMissingBase.project.nodes[0]?.metadata?.status).toBe("success");
        expect(localExtMissingBase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
    });

    test("mergeCanvasRefreshPatch settles replacement uploads cleanly when base is an autosaved uploading placeholder", () => {
        const runningVideoBase: CanvasNodeData = {
            id: "gen-bg",
            type: CanvasNodeType.Video,
            title: "生成视频",
            position: { x: 800, y: 100 },
            width: 720,
            height: 405,
            metadata: {
                taskId: "task-bg",
                status: "loading",
                taskStatus: "running",
                taskProgress: 20,
                taskStage: "生成中",
            },
        };
        const runningVideoPolled: CanvasNodeData = {
            ...runningVideoBase,
            metadata: { ...runningVideoBase.metadata, taskProgress: 55, taskStage: "合成中" },
        };
        const baseReplacementPlaceholder: CanvasNodeData = {
            id: "replace-vid",
            type: CanvasNodeType.Video,
            title: "分镜一",
            position: { x: 250, y: -70.5 },
            width: 720,
            height: 405,
            metadata: {
                content: "https://example.test/old.mp4",
                storageKey: "resource:old-vid",
                status: undefined,
                fileUpload: "uploading",
                taskId: "task-old",
                taskStatus: "failed",
                taskOutcome: { phase: "failed", regenerate: "confirm", reason: "input_rejected" },
                taskOutcomeSource: "local",
                generationErrorCode: "invalid_params",
                generationEffectKeys: ["attach-node:task-old:replace-vid:0"],
                model: "seedance-2.0",
                prompt: "人物转身",
                locked: true,
            },
        };
        const settledReplacement: CanvasNodeData = {
            id: "replace-vid",
            type: CanvasNodeType.Video,
            title: "分镜一",
            position: { x: 400, y: -241 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/new.mp4",
                storageKey: "resource:new-vid",
                status: "success",
                freeResize: false,
                prompt: "人物转身",
                locked: true,
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };

        const mergedLocalDone = mergeCanvasRefreshPatch(
            project([runningVideoBase, baseReplacementPlaceholder], 10),
            project([runningVideoPolled, { ...baseReplacementPlaceholder, metadata: { ...baseReplacementPlaceholder.metadata, fileUploadProgress: 65 } }], 11),
            [runningVideoBase, settledReplacement],
            [],
        );
        const localDoneNode = mergedLocalDone.nodes.find((item) => item.id === "replace-vid")!;
        expect(localDoneNode.width).toBe(420);
        expect(localDoneNode.height).toBe(746);
        expect(localDoneNode.position).toEqual({ x: 400, y: -241 });
        expect(localDoneNode.metadata?.content).toBe("https://example.test/new.mp4");
        expect(localDoneNode.metadata?.status).toBe("success");
        expect(localDoneNode.metadata?.fileUpload).toBeUndefined();
        expect(localDoneNode.metadata?.fileUploadProgress).toBeUndefined();
        expect(localDoneNode.metadata?.taskId).toBeUndefined();
        expect(localDoneNode.metadata?.taskStatus).toBeUndefined();
        expect(localDoneNode.metadata?.taskOutcome).toBeUndefined();
        expect(localDoneNode.metadata?.generationErrorCode).toBeUndefined();
        expect(localDoneNode.metadata?.generationEffectKeys).toBeUndefined();
        expect(readNodeTaskOutcome(localDoneNode.metadata)).toEqual({ phase: "ready", regenerate: "allowed", reason: "result_ready" });
        expect(localDoneNode.metadata?.model).toBeUndefined();
        expect(localDoneNode.metadata?.prompt).toBe("人物转身");
        expect(localDoneNode.metadata?.locked).toBe(true);
        expect(mergedLocalDone.nodes.find((item) => item.id === "gen-bg")?.metadata?.taskProgress).toBe(55);

        const localEditedPlaceholder: CanvasNodeData = {
            ...baseReplacementPlaceholder,
            title: "分镜一（精修）",
            position: { x: 500, y: 300 },
        };
        const mergedRemoteDone = mergeCanvasRefreshPatch(
            project([runningVideoBase, baseReplacementPlaceholder], 10),
            project([runningVideoPolled, settledReplacement], 11),
            [runningVideoBase, localEditedPlaceholder],
            [],
        );
        const remoteDoneNode = mergedRemoteDone.nodes.find((item) => item.id === "replace-vid")!;
        expect(remoteDoneNode.title).toBe("分镜一（精修）");
        expect(remoteDoneNode.width).toBe(420);
        expect(remoteDoneNode.height).toBe(746);
        expect(remoteDoneNode.position).toEqual({ x: 650, y: 129.5 });
        expect(remoteDoneNode.metadata?.content).toBe("https://example.test/new.mp4");
        expect(remoteDoneNode.metadata?.status).toBe("success");
        expect(remoteDoneNode.metadata?.fileUpload).toBeUndefined();
        expect(remoteDoneNode.metadata?.taskId).toBeUndefined();
        expect(remoteDoneNode.metadata?.taskStatus).toBeUndefined();
        expect(remoteDoneNode.metadata?.taskOutcome).toBeUndefined();
        expect(readNodeTaskOutcome(remoteDoneNode.metadata)).toEqual({ phase: "ready", regenerate: "allowed", reason: "result_ready" });
    });

    test("same-payload replacement completion settles to success across uploading, settled, and missing bases", () => {
        const uploadingSame = node("same-1", "hero.png", {
            content: "https://example.test/same.png",
            storageKey: "resource:same",
            status: undefined,
            fileUpload: "uploading",
            fileUploadAttemptId: "attempt-same-1",
            fileUploadProgress: 75,
            taskId: "task-old",
        });
        const settledSame = node("same-1", "hero.png", {
            content: "https://example.test/same.png",
            storageKey: "resource:same",
            status: "success",
            fileUploadAttemptId: "attempt-same-1",
            freeResize: false,
        });

        const localSettledPatch = mergeCanvasRefreshPatch(
            project([uploadingSame], 10),
            project([{ ...uploadingSame, metadata: { ...uploadingSame.metadata, fileUploadProgress: 90 } }], 11),
            [settledSame],
            [],
        );
        expect(localSettledPatch.nodes[0]?.metadata?.status).toBe("success");
        expect(localSettledPatch.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(localSettledPatch.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();
        expect(localSettledPatch.nodes[0]?.metadata?.taskId).toBeUndefined();

        const remoteSettledPatch = mergeCanvasRefreshPatch(
            project([uploadingSame], 10),
            project([settledSame], 11),
            [uploadingSame],
            [],
        );
        expect(remoteSettledPatch.nodes[0]?.metadata?.status).toBe("success");
        expect(remoteSettledPatch.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(remoteSettledPatch.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();
        expect(remoteSettledPatch.nodes[0]?.metadata?.taskId).toBeUndefined();

        const settledBaseRebase = rebaseCanvasDocumentThreeWay({
            base: project([settledSame], 10),
            local: project([settledSame], 10),
            remote: project([{ ...uploadingSame, metadata: { ...uploadingSame.metadata, fileUploadProgress: 65 } }], 11),
        });
        expect(settledBaseRebase.conflict).toBe(false);
        expect(settledBaseRebase.project.nodes[0]?.metadata?.status).toBe("success");
        expect(settledBaseRebase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(settledBaseRebase.project.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();
        expect(settledBaseRebase.project.nodes[0]?.metadata?.taskId).toBeUndefined();

        const settledBaseRefreshPatch = mergeCanvasRefreshPatch(
            project([settledSame], 10),
            project([{ ...uploadingSame, metadata: { ...uploadingSame.metadata, fileUploadProgress: 65 } }], 11),
            [settledSame],
            [],
        );
        expect(settledBaseRefreshPatch.nodes[0]?.metadata?.status).toBe("success");
        expect(settledBaseRefreshPatch.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(settledBaseRefreshPatch.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();
        expect(settledBaseRefreshPatch.nodes[0]?.metadata?.taskId).toBeUndefined();

        const settledPortraitSameVid: CanvasNodeData = {
            id: "same-vid",
            type: CanvasNodeType.Video,
            title: "精修竖屏定稿",
            position: { x: 600, y: 300 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/same-vid.mp4",
                storageKey: "resource:same-vid",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
                freeResize: false,
                prompt: "最终镜头备注",
                locked: true,
            },
        };
        const staleSameVidPlaceholder: CanvasNodeData = {
            id: "same-vid",
            type: CanvasNodeType.Video,
            title: "raw.mp4",
            position: { x: 250, y: -70.5 },
            width: 720,
            height: 405,
            metadata: {
                content: "https://example.test/same-vid.mp4",
                storageKey: "resource:same-vid",
                status: undefined,
                fileUpload: "uploading",
                fileUploadProgress: 65,
                prompt: "旧备注",
            },
        };
        const settledPortraitRebase = rebaseCanvasDocumentThreeWay({
            base: project([settledPortraitSameVid], 10),
            local: project([settledPortraitSameVid], 10),
            remote: project([staleSameVidPlaceholder], 11),
        });
        expect(settledPortraitRebase.conflict).toBe(false);
        expect(settledPortraitRebase.project.nodes[0]?.title).toBe("精修竖屏定稿");
        expect(settledPortraitRebase.project.nodes[0]?.width).toBe(420);
        expect(settledPortraitRebase.project.nodes[0]?.height).toBe(746);
        expect(settledPortraitRebase.project.nodes[0]?.position).toEqual({ x: 600, y: 300 });
        expect(settledPortraitRebase.project.nodes[0]?.metadata?.prompt).toBe("最终镜头备注");
        expect(settledPortraitRebase.project.nodes[0]?.metadata?.locked).toBe(true);
        expect(settledPortraitRebase.project.nodes[0]?.metadata?.status).toBe("success");
        expect(settledPortraitRebase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();

        const settledPortraitLocalFurtherEdited: CanvasNodeData = {
            ...settledPortraitSameVid,
            title: "精修竖屏定稿 v2",
            position: { x: 720, y: 360 },
            metadata: {
                ...settledPortraitSameVid.metadata,
                prompt: "二次调整备注",
            },
        };
        const settledPortraitPatch = mergeCanvasRefreshPatch(
            project([settledPortraitSameVid], 10),
            project([staleSameVidPlaceholder], 11),
            [settledPortraitLocalFurtherEdited],
            [],
        );
        expect(settledPortraitPatch.nodes[0]?.title).toBe("精修竖屏定稿 v2");
        expect(settledPortraitPatch.nodes[0]?.width).toBe(420);
        expect(settledPortraitPatch.nodes[0]?.height).toBe(746);
        expect(settledPortraitPatch.nodes[0]?.position).toEqual({ x: 720, y: 360 });
        expect(settledPortraitPatch.nodes[0]?.metadata?.prompt).toBe("二次调整备注");
        expect(settledPortraitPatch.nodes[0]?.metadata?.locked).toBe(true);
        expect(settledPortraitPatch.nodes[0]?.metadata?.status).toBe("success");
        expect(settledPortraitPatch.nodes[0]?.metadata?.fileUpload).toBeUndefined();

        const missingBaseSame = rebaseCanvasDocumentThreeWay({
            base: project([], 10),
            local: project([settledSame], 10),
            remote: project([uploadingSame], 11),
        });
        expect(missingBaseSame.conflict).toBe(false);
        expect(missingBaseSame.project.nodes[0]?.metadata?.status).toBe("success");
        expect(missingBaseSame.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
    });

    test("manual resize during replacement upload survives both before and after placeholder autosave", () => {
        const baseSettledOld = node("rep-resize", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        }, { x: 100, y: 100 });
        const replacementResizedUploading = {
            ...baseSettledOld,
            width: 500,
            height: 344,
            position: { x: 80, y: 80 },
            metadata: {
                content: "https://example.test/old.png",
                storageKey: "resource:old",
                status: undefined,
                fileUpload: "uploading" as const,
                manualSize: true,
            },
        };
        const settledReplacementNew = node("rep-resize", "old.png", {
            content: "https://example.test/new.png",
            storageKey: "resource:new",
            status: "success",
            freeResize: false,
        }, { x: 100, y: 100 });

        const beforeAutosave = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledOld], 10),
            local: project([replacementResizedUploading], 10),
            remote: project([settledReplacementNew], 11),
        });
        expect(beforeAutosave.conflict).toBe(false);
        expect(beforeAutosave.project.nodes[0]?.width).toBe(500);
        expect(beforeAutosave.project.nodes[0]?.height).toBe(344);
        expect(beforeAutosave.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(beforeAutosave.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(beforeAutosave.project.nodes[0]?.metadata?.content).toBe("https://example.test/new.png");
        expect(beforeAutosave.project.nodes[0]?.metadata?.status).toBe("success");

        const afterAutosave = rebaseCanvasDocumentThreeWay({
            base: project([replacementResizedUploading], 10),
            local: project([replacementResizedUploading], 10),
            remote: project([settledReplacementNew], 11),
        });
        expect(afterAutosave.conflict).toBe(false);
        expect(afterAutosave.project.nodes[0]?.width).toBe(500);
        expect(afterAutosave.project.nodes[0]?.height).toBe(344);
        expect(afterAutosave.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(afterAutosave.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(afterAutosave.project.nodes[0]?.metadata?.content).toBe("https://example.test/new.png");
        expect(afterAutosave.project.nodes[0]?.metadata?.status).toBe("success");

        const afterAutosaveReverse = rebaseCanvasDocumentThreeWay({
            base: project([replacementResizedUploading], 10),
            local: project([settledReplacementNew], 10),
            remote: project([replacementResizedUploading], 11),
        });
        expect(afterAutosaveReverse.conflict).toBe(false);
        expect(afterAutosaveReverse.project.nodes[0]?.width).toBe(500);
        expect(afterAutosaveReverse.project.nodes[0]?.height).toBe(344);
        expect(afterAutosaveReverse.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(afterAutosaveReverse.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(afterAutosaveReverse.project.nodes[0]?.metadata?.content).toBe("https://example.test/new.png");

        const freeResizeReplacementUploading = {
            ...replacementResizedUploading,
            metadata: {
                content: "https://example.test/old.png",
                storageKey: "resource:old",
                status: undefined,
                fileUpload: "uploading" as const,
                freeResize: true,
            },
        };
        const afterAutosaveFreeResize = rebaseCanvasDocumentThreeWay({
            base: project([freeResizeReplacementUploading], 10),
            local: project([freeResizeReplacementUploading], 10),
            remote: project([settledReplacementNew], 11),
        });
        expect(afterAutosaveFreeResize.conflict).toBe(false);
        expect(afterAutosaveFreeResize.project.nodes[0]?.width).toBe(500);
        expect(afterAutosaveFreeResize.project.nodes[0]?.height).toBe(344);
        expect(afterAutosaveFreeResize.project.nodes[0]?.metadata?.freeResize).toBe(true);
    });

    test("legacy remote settled upload node never strips or overwrites fileUploadAttemptId or leaks stale failed task metadata", () => {
        const baseUploading = node("replace-dirty-1", "uploading.png", {
            fileUpload: "uploading",
            fileUploadAttemptId: "att-clean-1",
            bytes: 1024,
            mimeType: "image/png",
        });
        const localSettledNew = node("replace-dirty-1", "clean-final.png", {
            content: "https://example.test/clean-final.png",
            storageKey: "resource:clean-final",
            status: "success",
            resultOrigin: "upload",
            nodeRole: "result",
            fileUploadAttemptId: "att-clean-1",
            bytes: 1024,
            mimeType: "image/png",
        });
        const remoteLegacyDirtyUpload = node("replace-dirty-1", "legacy-upload.png", {
            content: "https://example.test/legacy-upload.png",
            storageKey: "resource:legacy-upload",
            status: "success",
            resultOrigin: "upload",
            nodeRole: "result",
            taskId: "task-stale-failed",
            taskStatus: "failed",
            taskOutcome: { phase: "failed", regenerate: "confirm", reason: "task_failed" },
            generationErrorCode: "upstream_failed",
            generationFailure: {
                version: 1,
                source: ["upstream_failed", null, "task-stale-failed", null, null, null],
                explanation: {
                    category: "provider",
                    title: "旧任务失败",
                    summary: "旧任务失败",
                    retryable: true,
                },
            },
        });

        const rebased = rebaseCanvasDocumentThreeWay({
            base: project([baseUploading], 10),
            local: project([localSettledNew], 10),
            remote: project([remoteLegacyDirtyUpload], 11),
        });
        const merged = rebased.project.nodes[0]!;
        expect(rebased.conflict).toBe(true);
        expect(merged.metadata?.content).toBe("https://example.test/clean-final.png");
        expect(merged.metadata?.status).toBe("success");
        expect(merged.metadata?.fileUploadAttemptId).toBe("att-clean-1");
        expect(merged.metadata?.taskId).toBeUndefined();
        expect(merged.metadata?.taskStatus).toBeUndefined();
        expect(merged.metadata?.taskOutcome).toBeUndefined();
        expect(merged.metadata?.generationErrorCode).toBeUndefined();
        expect(merged.metadata?.generationFailure).toBeUndefined();
        expect(readNodeTaskOutcome(merged.metadata)).toEqual({
            phase: "ready",
            regenerate: "allowed",
            reason: "result_ready",
        });

        // 同一完成媒体的 legacy 远端快照缺失 attemptId（例如远端仅改标题）时，保留本地 att-clean-1 且不冲突
        const remoteSameMediaLegacyRenamed = node("replace-dirty-1", "已重命名海报", {
            content: "https://example.test/clean-final.png",
            storageKey: "resource:clean-final",
            status: "success",
            resultOrigin: "upload",
            nodeRole: "result",
            taskId: "task-stale-failed",
            taskStatus: "failed",
            bytes: 1024,
            mimeType: "image/png",
        });
        const sameMediaLegacyRebased = rebaseCanvasDocumentThreeWay({
            base: project([localSettledNew], 10),
            local: project([localSettledNew], 10),
            remote: project([remoteSameMediaLegacyRenamed], 11),
        });
        expect(sameMediaLegacyRebased.conflict).toBe(false);
        expect(sameMediaLegacyRebased.project.nodes[0]?.title).toBe("已重命名海报");
        expect(sameMediaLegacyRebased.project.nodes[0]?.metadata?.fileUploadAttemptId).toBe("att-clean-1");
        expect(sameMediaLegacyRebased.project.nodes[0]?.metadata?.taskId).toBeUndefined();

        // 远端携带旧 attemptId 且无新媒体替换证明时，不覆盖本地新 attemptId 并标记冲突
        const localNewAttempt = {
            ...localSettledNew,
            metadata: { ...localSettledNew.metadata, fileUploadAttemptId: "att-new-2" },
        };
        const staleRemoteOldAttempt = {
            ...localSettledNew,
            metadata: { ...localSettledNew.metadata, fileUploadAttemptId: "att-old-1" },
        };
        const staleAttemptRebased = rebaseCanvasDocumentThreeWay({
            base: project([localNewAttempt], 10),
            local: project([localNewAttempt], 10),
            remote: project([staleRemoteOldAttempt], 11),
        });
        expect(staleAttemptRebased.conflict).toBe(true);
        expect(staleAttemptRebased.project.nodes[0]?.metadata?.fileUploadAttemptId).toBe("att-new-2");
    });

    test("autosaved uploading replacement placeholder retaining preview media B is not prematurely settled by an older remote B without matching attemptId", () => {
        const autosavedUploadingNewAttempt = node("preview-retain-1", "new-upload.png", {
            content: "https://example.test/old-b.png",
            storageKey: "resource:old-b",
            status: undefined,
            fileUpload: "uploading",
            fileUploadAttemptId: "att-new-2",
            bytes: 4096,
            mimeType: "image/png",
        });
        for (const staleRemoteSettledB of [
            node("preview-retain-1", "old-b.png", {
                content: "https://example.test/old-b.png",
                storageKey: "resource:old-b",
                status: "success",
                resultOrigin: "upload",
            }),
            node("preview-retain-1", "old-b.png", {
                content: "https://example.test/old-b.png",
                storageKey: "resource:old-b",
                status: "success",
                resultOrigin: "upload",
                fileUploadAttemptId: "att-old-1",
            }),
        ]) {
            const rebased = rebaseCanvasDocumentThreeWay({
                base: project([autosavedUploadingNewAttempt], 10),
                local: project([autosavedUploadingNewAttempt], 10),
                remote: project([staleRemoteSettledB], 11),
            });
            expect(rebased.conflict).toBe(false);
            expect(rebased.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
            expect(rebased.project.nodes[0]?.metadata?.fileUploadAttemptId).toBe("att-new-2");
            expect(rebased.project.nodes[0]?.metadata?.status).toBeUndefined();

            const refreshPatch = mergeCanvasRefreshPatch(
                project([autosavedUploadingNewAttempt], 10),
                project([staleRemoteSettledB], 11),
                [autosavedUploadingNewAttempt],
                [],
            );
            expect(refreshPatch.nodes[0]?.metadata?.fileUpload).toBe("uploading");
            expect(refreshPatch.nodes[0]?.metadata?.fileUploadAttemptId).toBe("att-new-2");
            expect(refreshPatch.nodes[0]?.metadata?.status).toBeUndefined();
        }
    });

    test("settled local upload rejects stale generated or derived remote task/failure fields while allowing legitimate remote in-place text rewrite", () => {
        const localSettledUpload = node("gen-derived-race", "user-a.png", {
            content: "https://example.test/user-a.png", storageKey: "resource:user-a", mimeType: "image/png",
            naturalWidth: 1200, naturalHeight: 900, bytes: 2048, status: "success", resultOrigin: "upload", nodeRole: "result", fileUploadAttemptId: "att-a",
        });

        // 1) 同媒体的滞后 generated 远端快照（含远端 manualSize/freeResize/assetId/尺寸污染）：无冲突且强制保留本地尺寸/媒体/att-a
        const staleGeneratedSameMedia = {
            ...node("gen-derived-race", "远端改名标题", {
                content: "https://example.test/user-a.png", storageKey: "resource:user-a", mimeType: "image/webp", assetId: "asset-stale-gen",
                naturalWidth: 640, naturalHeight: 640, manualSize: true, freeResize: true, status: "success",
                resultOrigin: "generated", nodeRole: "result", taskId: "task-stale-gen", taskStatus: "failed",
                taskOutcome: { phase: "failed", regenerate: "confirm", reason: "task_failed" }, generationErrorCode: "upstream_failed",
            }),
            width: 180, height: 320,
        };
        const sameMediaResult = rebaseCanvasDocumentThreeWay({
            base: project([localSettledUpload], 10), local: project([localSettledUpload], 10), remote: project([staleGeneratedSameMedia], 11),
        });
        const sameMerged = sameMediaResult.project.nodes[0]!;
        expect(sameMediaResult.conflict).toBe(false);
        expect(sameMerged.title).toBe("远端改名标题");
        expect(sameMerged.width).toBe(localSettledUpload.width);
        expect(sameMerged.height).toBe(localSettledUpload.height);
        expect(sameMerged.metadata?.mimeType).toBe("image/png");
        expect(sameMerged.metadata?.assetId).toBeUndefined();
        expect(sameMerged.metadata?.manualSize).toBeUndefined();
        expect(sameMerged.metadata?.freeResize).toBeUndefined();
        expect(sameMerged.metadata?.resultOrigin).toBe("upload");
        expect(sameMerged.metadata?.fileUploadAttemptId).toBe("att-a");
        expect(sameMerged.metadata?.taskId).toBeUndefined();
        expect(sameMerged.metadata?.taskStatus).toBeUndefined();
        expect(sameMerged.metadata?.taskOutcome).toBeUndefined();
        expect(sameMerged.metadata?.generationErrorCode).toBeUndefined();

        // 2) 不同媒体的滞后 generated / derived 远端快照（含远端 manualSize/freeResize=true）：标记冲突、保留本地尺寸/mimeType/att-a，清除远端 manual 标记与派生源
        const baseLoading = node("gen-derived-race", "生成中", { status: "loading", taskId: "task-derived-1", taskStatus: "running" });
        const staleDerivedDistinctMedia = {
            ...node("gen-derived-race", "超分结果", {
                content: "https://example.test/derived-out.webp", storageKey: "resource:derived-out", mimeType: "image/webp",
                naturalWidth: 2048, naturalHeight: 2048, manualSize: true, freeResize: true, status: "success", resultOrigin: "derived", nodeRole: "result",
                depthSourceNodeId: "src-depth-9", generatedFromProcessingNodeId: "src-up-8", pluginNodeId: "plugin-7", taskId: "task-derived-1", taskStatus: "failed", generationErrorCode: "upstream_failed",
            }),
            width: 200, height: 320,
        };
        const distinctResult = rebaseCanvasDocumentThreeWay({
            base: project([baseLoading], 10), local: project([localSettledUpload], 10), remote: project([staleDerivedDistinctMedia], 11),
        });
        const distinctMerged = distinctResult.project.nodes[0]!;
        expect(distinctResult.conflict).toBe(true);
        expect(distinctMerged.width).toBe(localSettledUpload.width);
        expect(distinctMerged.height).toBe(localSettledUpload.height);
        expect(distinctMerged.metadata?.manualSize).toBeUndefined();
        expect(distinctMerged.metadata?.freeResize).toBeUndefined();
        expect(distinctMerged.metadata?.content).toBe("https://example.test/user-a.png");
        expect(distinctMerged.metadata?.mimeType).toBe("image/png");
        expect(distinctMerged.metadata?.resultOrigin).toBe("upload");
        expect(distinctMerged.metadata?.fileUploadAttemptId).toBe("att-a");
        expect(distinctMerged.metadata?.taskId).toBeUndefined();
        expect(distinctMerged.metadata?.taskStatus).toBeUndefined();
        expect(distinctMerged.metadata?.generationErrorCode).toBeUndefined();
        expect(distinctMerged.metadata?.depthSourceNodeId).toBeUndefined();
        expect(distinctMerged.metadata?.generatedFromProcessingNodeId).toBeUndefined();
        expect(distinctMerged.metadata?.pluginNodeId).toBeUndefined();

        // 3) 文本上传节点在远端合法发起原地改写并完成：远端改写结果正常合入且不误当本地上传覆盖
        const baseTextUpload: CanvasNodeData = {
            ...node("txt-upload-1", "outline", {
                content: "原始上传文本", prompt: "原始上传文本", storageKey: "resource:outline-md",
                status: "success", resultOrigin: "upload", fileUploadAttemptId: "att-txt-1",
            }),
            type: "text",
        };
        const remoteRewrittenText: CanvasNodeData = {
            ...baseTextUpload,
            metadata: { content: "AI 改写后的剧本正文", prompt: "请扩写为三幕剧", status: "success", taskId: "task-txt-rewrite-1", taskStatus: "succeeded" },
        };
        const rewrittenResult = rebaseCanvasDocumentThreeWay({
            base: project([baseTextUpload], 10), local: project([baseTextUpload], 10), remote: project([remoteRewrittenText], 11),
        });
        const rewrittenMerged = rewrittenResult.project.nodes[0]!;
        expect(rewrittenResult.conflict).toBe(false);
        expect(rewrittenMerged.metadata?.content).toBe("AI 改写后的剧本正文");
        expect(rewrittenMerged.metadata?.taskId).toBe("task-txt-rewrite-1");
        expect(rewrittenMerged.metadata?.resultOrigin).toBeUndefined();
        expect(rewrittenMerged.metadata?.fileUploadAttemptId).toBeUndefined();
        expect(rewrittenMerged.metadata?.storageKey).toBeUndefined();

        // 4) URL 在线导入替换（resultOrigin="imported"）与 Script 文档替换后，远端滞后 generated/derived 快照不得注入旧任务或失败态
        const importedLocal = node("url-imp-1", "imported.png", {
            content: "https://cdn.example.test/imported.png", status: "success", resultOrigin: "imported", nodeRole: "result", fileUploadAttemptId: "att-imp-1",
        });
        const importedRebased = rebaseCanvasDocumentThreeWay({
            base: project([importedLocal], 10), local: project([importedLocal], 10), remote: project([{ ...staleDerivedDistinctMedia, id: "url-imp-1" }], 11),
        });
        expect(importedRebased.conflict).toBe(true);
        expect(importedRebased.project.nodes[0]?.metadata?.content).toBe("https://cdn.example.test/imported.png");
        expect(importedRebased.project.nodes[0]?.metadata?.resultOrigin).toBe("imported");
        expect(importedRebased.project.nodes[0]?.metadata?.taskId).toBeUndefined();
        expect(importedRebased.project.nodes[0]?.metadata?.taskOutcome).toBeUndefined();

        const scriptLocal: CanvasNodeData = {
            ...node("script-rep-1", "新分镜剧本", { composerContent: "第一场：雨夜", prompt: "第一场：雨夜", status: "success", resultOrigin: "upload", fileUploadAttemptId: "att-scr-1" }),
            type: "script",
        };
        const scriptStaleRemote: CanvasNodeData = {
            ...scriptLocal, title: "旧剧本", metadata: { composerContent: "旧内容", status: "error", taskId: "task-scr-old", taskStatus: "failed", taskOutcome: { phase: "failed", regenerate: "allowed", reason: "task_failed" } },
        };
        const scriptRebased = rebaseCanvasDocumentThreeWay({ base: project([scriptLocal], 10), local: project([scriptLocal], 10), remote: project([scriptStaleRemote], 11) });
        expect(scriptRebased.conflict).toBe(true);
        expect(scriptRebased.project.nodes[0]?.title).toBe("新分镜剧本");
        expect(scriptRebased.project.nodes[0]?.metadata?.composerContent).toBe("第一场：雨夜");
        expect(scriptRebased.project.nodes[0]?.metadata?.taskId).toBeUndefined();
    });
});
