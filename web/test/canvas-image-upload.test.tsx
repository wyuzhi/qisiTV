import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
    buildSettledUploadNodeMetadata,
    clearReplacedGenerationTaskMetadata,
    createFileUploadPlaceholder,
    createImageUploadPlaceholder,
    interruptFileUpload,
    isFileUploadOverlayActive,
    readUploadImageSize,
    restoreFailedUploadNode,
    uploadNodeType,
    uploadPercent,
    uploadVeilOpacity,
} from "../src/lib/canvas/canvas-file-upload";
import { CanvasNodeType } from "../src/types/canvas";
import { isCanvasImageSourceNode } from "../src/lib/canvas/canvas-image-source";
import { mediaResultMetadata, normalizeCanvasMediaNodeSemantics } from "../src/lib/canvas/canvas-node-semantics";
import { persistCanvasNodeFailure } from "../src/lib/canvas/canvas-node-failure-state";
import { canvasNodeFailureView } from "../src/lib/canvas/canvas-node-failure-view";
import { isCanvasNodeGenerating } from "../src/lib/canvas/canvas-node-task-state";
import { isNodeRegenerateBlocked, readNodeTaskOutcome } from "../src/lib/task-outcome";
import { CanvasFileUploadContent } from "../src/components/canvas/canvas-file-upload-content";
import { CanvasNodeActionContext } from "../src/components/canvas/canvas-node-action-context";
import { canvasThemes } from "../src/lib/canvas-theme";
import { createCanvasPageUiStore } from "../src/stores/canvas/use-canvas-page-ui-store";

const file = { name: "photo.png", size: 1234, type: "image/png" };
const placeholder = () => createImageUploadPlaceholder("upload", file, { x: 100, y: 200 }, { width: 1920, height: 1080 });

describe("图片上传占位", () => {
    for (const [width, height] of [[1920, 1080], [900, 1600], [800, 800], [4000, 500]]) {
        test(`按真实尺寸保持比例并围绕落点居中 ${width}x${height}`, () => {
            const node = createImageUploadPlaceholder("upload", file, { x: 100, y: 200 }, { width, height });
            expect(node.width / node.height).toBeCloseTo(width / height);
            expect(node.position.x + node.width / 2).toBe(100);
            expect(node.position.y + node.height / 2).toBe(200);
            expect(node.metadata?.naturalWidth).toBe(width);
            expect(node.metadata?.naturalHeight).toBe(height);
            expect(node.metadata?.fileUpload).toBe("uploading");
            expect(node.metadata?.content).toBeUndefined();
            expect(node.metadata?.status).toBeUndefined();
            expect(isCanvasImageSourceNode(node)).toBe(true);
        });
    }

    test("重新打开画布将中断上传转为可重试错误，不修改其他节点", () => {
        const node = placeholder();
        const interrupted = interruptFileUpload(node);
        expect(interrupted.metadata?.fileUpload).toBe("error");
        expect(interrupted.metadata?.errorDetails).toContain("中断");
        expect(interrupted.position).toEqual(node.position);
        expect(node.metadata?.fileUpload).toBe("uploading");
        expect(interruptFileUpload(interrupted)).toBe(interrupted);
        const ready = { ...node, metadata: { content: "image" } };
        expect(interruptFileUpload(ready)).toBe(ready);
    });

    test("已完成媒体被残留上传标记污染时各入口统一忽略并清理，替换上传进行中仍保留中断保护", () => {
        const staleUploading = {
            ...placeholder(),
            metadata: mediaResultMetadata("generated", {
                content: "https://example.test/settled.png",
                storageKey: "resource:settled",
                status: "success" as const,
                taskId: "task-gen-1",
                fileUpload: "uploading" as const,
                fileUploadProgress: 80,
            }),
        };
        expect(isFileUploadOverlayActive(staleUploading.metadata)).toBe(false);
        expect(isCanvasImageSourceNode(staleUploading)).toBe(false);
        const healedUploading = interruptFileUpload(staleUploading);
        expect(healedUploading.metadata?.fileUpload).toBeUndefined();
        expect(healedUploading.metadata?.fileUploadProgress).toBeUndefined();
        expect(healedUploading.metadata?.status).toBe("success");
        expect(healedUploading.metadata?.content).toBe("https://example.test/settled.png");
        expect(healedUploading.metadata?.taskId).toBe("task-gen-1");

        const normalizedUploading = normalizeCanvasMediaNodeSemantics(staleUploading);
        expect(normalizedUploading.metadata?.fileUpload).toBeUndefined();
        expect(normalizedUploading.metadata?.fileUploadProgress).toBeUndefined();
        expect(normalizedUploading.metadata?.resultOrigin).toBe("generated");

        const staleInterrupted = {
            ...placeholder(),
            metadata: {
                content: "https://example.test/settled.png",
                storageKey: "resource:settled",
                status: "success" as const,
                fileUpload: "error" as const,
                errorDetails: "上传已中断，请重新选择文件上传",
            },
        };
        expect(isFileUploadOverlayActive(staleInterrupted.metadata)).toBe(false);
        const healedInterrupted = interruptFileUpload(staleInterrupted);
        expect(healedInterrupted.metadata?.fileUpload).toBeUndefined();
        expect(healedInterrupted.metadata?.errorDetails).toBeUndefined();
        expect(healedInterrupted.metadata?.status).toBe("success");

        const persistedFailureCheck = persistCanvasNodeFailure(staleInterrupted);
        expect(persistedFailureCheck.metadata?.fileUpload).toBeUndefined();
        expect(persistedFailureCheck.metadata?.errorDetails).toBeUndefined();
        expect(persistedFailureCheck.metadata?.generationFailure).toBeUndefined();

        // 已保存 generationFailure / localOutcome 完全匹配时（next === metadata 分支），仍必须返回清理掉残留上传标记的节点
        const cleanFailureSeed = persistCanvasNodeFailure({
            ...placeholder(),
            metadata: mediaResultMetadata("generated", {
                content: "https://example.test/settled.png",
                storageKey: "resource:settled",
                status: "success" as const,
                generationErrorCode: "invalid_params",
            }),
        });
        expect(cleanFailureSeed.metadata?.generationFailure).toBeDefined();
        const pollutedWithMatchedFailure = {
            ...cleanFailureSeed,
            metadata: {
                ...cleanFailureSeed.metadata,
                fileUpload: "uploading" as const,
                fileUploadProgress: 88,
            },
        };
        const strippedMatchedFailure = persistCanvasNodeFailure(pollutedWithMatchedFailure);
        expect(strippedMatchedFailure).not.toBe(pollutedWithMatchedFailure);
        expect(strippedMatchedFailure.metadata?.fileUpload).toBeUndefined();
        expect(strippedMatchedFailure.metadata?.fileUploadProgress).toBeUndefined();
        expect(persistCanvasNodeFailure(strippedMatchedFailure)).toBe(strippedMatchedFailure);

        const staleSucceededUnbound = {
            ...placeholder(),
            metadata: {
                content: "https://example.test/settled.png",
                status: "success" as const,
                taskId: "task-need-check",
                taskStatus: "succeeded" as const,
                fileUpload: "uploading" as const,
            },
        };
        expect(canvasNodeFailureView(staleSucceededUnbound).needsRecovery).toBe(false);

        const replacingInFlight = {
            ...placeholder(),
            metadata: {
                content: "https://example.test/previous.png",
                storageKey: "resource:previous",
                status: undefined,
                fileUpload: "uploading" as const,
                fileUploadProgress: 50,
            },
        };
        expect(isFileUploadOverlayActive(replacingInFlight.metadata)).toBe(true);
        expect(interruptFileUpload(replacingInFlight).metadata?.fileUpload).toBe("error");
    });

    test("图片解码成功和失败均释放临时 URL，不伪造尺寸", async () => {
        const originalImage = globalThis.Image;
        const create = URL.createObjectURL;
        const revoke = URL.revokeObjectURL;
        const revoked: string[] = [];
        let fail = false;
        try {
            URL.createObjectURL = () => "blob:upload-test";
            URL.revokeObjectURL = (url) => { revoked.push(url); };
            globalThis.Image = class {
                src = "";
                naturalWidth = 1200;
                naturalHeight = 800;
                async decode() { if (fail) throw new Error("decode failed"); }
            } as unknown as typeof Image;
            const input = new File(["test"], "test.png", { type: "image/png" });
            expect(await readUploadImageSize(input)).toEqual({ width: 1200, height: 800 });
            fail = true;
            await expect(readUploadImageSize(input)).rejects.toThrow("decode failed");
            expect(revoked).toEqual(["blob:upload-test", "blob:upload-test"]);
        } finally {
            globalThis.Image = originalImage;
            URL.createObjectURL = create;
            URL.revokeObjectURL = revoke;
        }
    });

    for (const mode of ["light", "dark"] as const) {
        test(`${mode}主题包含可访问的上传状态、减弱动效和失败重试`, () => {
            const html = renderToStaticMarkup(<CanvasFileUploadContent node={placeholder()} theme={canvasThemes[mode]} reduceMotion />);
            expect(html).toContain("正在上传图片");
            expect(html).toContain('aria-busy="true"');
            expect(html).toContain('data-static="true"');
            expect(html).toContain(canvasThemes[mode].node.fill);
            const error = renderToStaticMarkup(<CanvasNodeActionContext.Provider value={{ upload: () => {} }}><CanvasFileUploadContent node={interruptFileUpload(placeholder())} theme={canvasThemes[mode]} /></CanvasNodeActionContext.Provider>);
            expect(error).toContain("重新选择文件");
            expect(error).toContain('aria-busy="false"');
            expect(error).toContain('data-static="true"');
        });
    }

    test("上传完成元数据统一清理瞬态字段，替换失败或运行中生成节点时一次清空任务生命周期与失败记录", () => {
        const freshSettled = buildSettledUploadNodeMetadata(
            { fileUpload: "uploading", fileUploadProgress: 65, prompt: "镜头说明", locked: true },
            { content: "https://example.test/new.png", storageKey: "resource:new", status: "success", bytes: 2048, mimeType: "image/png" },
        );
        expect(freshSettled.fileUpload).toBeUndefined();
        expect(freshSettled.fileUploadProgress).toBeUndefined();
        expect("fileUpload" in freshSettled).toBe(false);
        expect(freshSettled.status).toBe("success");
        expect(freshSettled.prompt).toBe("镜头说明");
        expect(freshSettled.locked).toBe(true);

        const failedNodeWithSavedFailure = persistCanvasNodeFailure({
            ...placeholder(),
            metadata: {
                status: "error",
                taskId: "task-failed-1",
                taskStatus: "failed",
                taskOutcome: { phase: "failed", regenerate: "confirm", reason: "input_rejected" },
                taskErrorCode: "invalid_params",
                taskClientOperationId: "op-failed-1",
                taskClientOperationInput: "input-fp-1",
                taskClientOperationTerminal: true,
                agentGenerationContinuation: { id: "cont-1", taskId: "task-failed-1", status: "pending" },
                sessionId: "sess-legacy-1",
                generationErrorCode: "invalid_params",
                generationErrorSummary: "参考图格式不支持",
                generationProviderCode: "400",
                generationPreflightError: "preflight_old",
                failedPromptFingerprint: "fp-prompt",
                failedInputFingerprint: "fp-input",
                lastGenerationRequestFingerprint: "fp-req-1",
                generationEffectKeys: ["attach-node:task-failed-1:upload:0"],
                errorDetails: "参考图格式不支持",
                model: "nano-banana",
                workflowProvider: "model",
                generationMode: "video",
                generationType: "edit",
                seedreamMode: "sequential",
                seconds: "10",
                vquality: "1080",
                videoDraftTaskId: "cgt-draft-1",
                videoEditOperation: "draft_to_final",
                lastFrameUrl: "https://example.test/old-last.png",
                lastFrameStorageKey: "resource:old-last",
                generatedFromNodeId: "src-gen-1",
                videoTrimSource: { content: "https://example.test/old-trim.mp4", storageKey: "resource:old-trim" },
                videoTrimStartMs: 500,
                videoTrimEndMs: 2500,
                mediaOperationError: "旧裁剪失败",
                freeResize: true,
                composerContent: "旧提示词",
                fileUpload: "uploading",
                prompt: "保留备注",
                locked: true,
            },
        });
        expect(failedNodeWithSavedFailure.metadata?.generationFailure).toBeDefined();

        // 既覆盖图片替换，也覆盖不主动写 generationErrorCode: undefined 的纯文本上传替换
        for (const uploaded of [
            { content: "https://example.test/replaced.png", storageKey: "resource:replaced", status: "success" as const },
            { content: "替换后的正文", prompt: "替换后的正文", storageKey: "resource:text-1", status: "success" as const },
        ]) {
            const replacedFailed = buildSettledUploadNodeMetadata(failedNodeWithSavedFailure.metadata, uploaded, { replace: true });
            expect(replacedFailed.fileUpload).toBeUndefined();
            expect(replacedFailed.assetId).toBeUndefined();
            expect(replacedFailed.taskId).toBeUndefined();
            expect(replacedFailed.taskStatus).toBeUndefined();
            expect(replacedFailed.taskOutcome).toBeUndefined();
            expect(replacedFailed.taskOutcomeSource).toBeUndefined();
            expect(replacedFailed.taskClientOperationId).toBeUndefined();
            expect(replacedFailed.taskClientOperationInput).toBeUndefined();
            expect(replacedFailed.taskClientOperationTerminal).toBeUndefined();
            expect(replacedFailed.agentGenerationContinuation).toBeUndefined();
            expect(replacedFailed.sessionId).toBeUndefined();
            expect(replacedFailed.generationFailure).toBeUndefined();
            expect(replacedFailed.generationErrorCode).toBeUndefined();
            expect(replacedFailed.generationErrorSummary).toBeUndefined();
            expect(replacedFailed.taskErrorCode).toBeUndefined();
            expect(replacedFailed.generationEffectKeys).toBeUndefined();
            expect(replacedFailed.errorDetails).toBeUndefined();
            expect(replacedFailed.model).toBeUndefined();
            expect(replacedFailed.workflowProvider).toBeUndefined();
            expect(replacedFailed.generationMode).toBeUndefined();
            expect(replacedFailed.generationType).toBeUndefined();
            expect(replacedFailed.seedreamMode).toBeUndefined();
            expect(replacedFailed.seconds).toBeUndefined();
            expect(replacedFailed.vquality).toBeUndefined();
            expect(replacedFailed.videoDraftTaskId).toBeUndefined();
            expect(replacedFailed.videoEditOperation).toBeUndefined();
            expect(replacedFailed.lastFrameUrl).toBeUndefined();
            expect(replacedFailed.lastFrameStorageKey).toBeUndefined();
            expect(replacedFailed.generatedFromNodeId).toBeUndefined();
            expect(replacedFailed.videoTrimSource).toBeUndefined();
            expect(replacedFailed.videoTrimStartMs).toBeUndefined();
            expect(replacedFailed.mediaOperationError).toBeUndefined();
            expect(replacedFailed.composerContent).toBeUndefined();
            expect(replacedFailed.freeResize).toBe(false);
            expect(replacedFailed.locked).toBe(true);
            expect(readNodeTaskOutcome(replacedFailed)).toEqual({ phase: "ready", regenerate: "allowed", reason: "result_ready" });
            expect(isNodeRegenerateBlocked(replacedFailed)).toBe(false);
            expect(isCanvasNodeGenerating({ ...placeholder(), metadata: replacedFailed })).toBe(false);
            expect(canvasNodeFailureView({ ...placeholder(), metadata: replacedFailed }).needsRecovery).toBe(false);
        }

        const replacedRunning = buildSettledUploadNodeMetadata(
            {
                status: "loading",
                taskId: "task-running-1",
                taskStatus: "running",
                taskProgress: 42,
                taskStage: "生成中",
                taskOutcome: { phase: "running", regenerate: "blocked", reason: "task_running" },
                generationSubmissionState: "accepted",
                videoTrimSourceNodeId: "src-trim-1",
                audioExtractSourceNodeId: "src-audio-1",
                videoSegmentSourceNodeId: "src-seg-1",
                videoMergeSourceNodeIds: ["src-m1", "src-m2"],
                emotionEdit: {
                    sourceNodeId: "src-emo-1",
                    characterName: "角色",
                    presetId: "smile",
                    intimacy: 50,
                    arousal: 50,
                    label: "微笑",
                    faceBox: { id: "f1", x: 0, y: 0, width: 100, height: 100, source: "detected" },
                },
                importSource: { provider: "libtv", projectUuid: "p1", nodeKey: "k1", batchId: "b1" },
                fileUpload: "uploading",
                prompt: "运行中替换备注",
            },
            { content: "https://example.test/from-running.png", storageKey: "resource:from-running", status: "success" },
            { replace: true },
        );
        expect(replacedRunning.taskId).toBeUndefined();
        expect(replacedRunning.taskStatus).toBeUndefined();
        expect(replacedRunning.taskProgress).toBeUndefined();
        expect(replacedRunning.taskStage).toBeUndefined();
        expect(replacedRunning.taskOutcome).toBeUndefined();
        expect(replacedRunning.generationSubmissionState).toBeUndefined();
        expect(replacedRunning.videoTrimSourceNodeId).toBeUndefined();
        expect(replacedRunning.audioExtractSourceNodeId).toBeUndefined();
        expect(replacedRunning.videoSegmentSourceNodeId).toBeUndefined();
        expect(replacedRunning.videoMergeSourceNodeIds).toBeUndefined();
        expect(replacedRunning.emotionEdit).toBeUndefined();
        expect(replacedRunning.importSource).toBeUndefined();
        expect(replacedRunning.prompt).toBe("运行中替换备注");
        expect(readNodeTaskOutcome(replacedRunning)).toEqual({ phase: "ready", regenerate: "allowed", reason: "result_ready" });
        expect(isNodeRegenerateBlocked(replacedRunning)).toBe(false);
        const normalizedReplacedNode = normalizeCanvasMediaNodeSemantics({ ...placeholder(), metadata: replacedRunning });
        expect(normalizedReplacedNode.metadata?.nodeRole).toBe("result");
    });

    test("实时上传进度归属页面作用域 store，画布隔离且切画布与删节点时自动清理，不写入节点持久化 metadata", () => {
        const node = placeholder();
        const pageA = createCanvasPageUiStore();
        const pageB = createCanvasPageUiStore();
        const observed: Array<number | undefined> = [];
        const unsubscribe = pageA.subscribe((state) => {
            observed.push(state.uploadProgressByNodeId[node.id]);
        });
        pageA.getState().setUploadProgress(node.id, 64);
        expect(pageA.getState().uploadProgressByNodeId[node.id]).toBe(64);
        expect(pageB.getState().uploadProgressByNodeId[node.id]).toBeUndefined();
        expect(node.metadata?.fileUploadProgress).toBeUndefined();

        pageA.getState().clearRemovedNodes(new Set([node.id]));
        expect(pageA.getState().uploadProgressByNodeId[node.id]).toBeUndefined();

        pageA.getState().setUploadProgress(node.id, 88);
        pageA.getState().resetForProject();
        expect(pageA.getState().uploadProgressByNodeId).toEqual({});
        unsubscribe();
        expect(observed).toEqual([64, undefined, 88, undefined]);

        const inFlightHtml = renderToStaticMarkup(
            <CanvasNodeActionContext.Provider value={{ pageUi: createCanvasPageUiStore({ uploadProgressByNodeId: { [node.id]: 64 } }) }}>
                <CanvasFileUploadContent node={node} theme={canvasThemes.light} />
            </CanvasNodeActionContext.Provider>,
        );
        expect(inFlightHtml).toContain("已上传 64%");
        expect(inFlightHtml).toContain('aria-valuenow="64"');

        const processingHtml = renderToStaticMarkup(
            <CanvasNodeActionContext.Provider value={{ pageUi: createCanvasPageUiStore({ uploadProgressByNodeId: { [node.id]: 100 } }) }}>
                <CanvasFileUploadContent node={node} theme={canvasThemes.dark} />
            </CanvasNodeActionContext.Provider>,
        );
        expect(processingHtml).toContain("文件已传输，正在保存与处理");

        const isolatedOtherPageHtml = renderToStaticMarkup(
            <CanvasNodeActionContext.Provider value={{ pageUi: pageB }}>
                <CanvasFileUploadContent node={node} theme={canvasThemes.light} />
            </CanvasNodeActionContext.Provider>,
        );
        expect(isolatedOtherPageHtml).toContain("正在准备文件");
    });

    test("替换在途生成节点时若本地上传失败，回退旧媒体时必须剥离已取消的在途任务状态以避免僵尸 loading", () => {
        const runningOriginal = {
            ...placeholder(),
            type: CanvasNodeType.Video,
            width: 640,
            height: 360,
            metadata: {
                content: "https://example.test/prev.mp4",
                storageKey: "resource:prev-mp4",
                status: "loading" as const,
                taskId: "task-in-flight-1",
                taskStatus: "running",
                taskStage: "生成中",
                taskProgress: 55,
                taskOutcome: { phase: "running" as const, regenerate: "blocked" as const, reason: "task_running" },
                generationSubmissionState: "accepted" as const,
                taskClientOperationId: "op-in-flight-1",
                agentGenerationContinuation: { status: "pending" as const, taskId: "task-in-flight-1", sessionId: "sess-1", itemId: "item-1" },
                prompt: "保留原描述",
            },
        };
        const uploadingItem = {
            ...runningOriginal,
            width: 480,
            height: 270,
            metadata: mediaResultMetadata("upload", {
                ...runningOriginal.metadata,
                fileUpload: "uploading",
                status: undefined,
                taskId: undefined,
                taskClientOperationId: undefined,
                generationSubmissionState: undefined,
                agentGenerationContinuation: undefined,
            }),
        };

        const restored = restoreFailedUploadNode(uploadingItem, runningOriginal, "网络超时");
        expect(restored.width).toBe(640);
        expect(restored.height).toBe(360);
        expect(restored.metadata?.content).toBe("https://example.test/prev.mp4");
        expect(restored.metadata?.storageKey).toBe("resource:prev-mp4");
        expect(restored.metadata?.status).toBe("success");
        expect(restored.metadata?.taskId).toBeUndefined();
        expect(restored.metadata?.taskStatus).toBeUndefined();
        expect(restored.metadata?.taskStage).toBeUndefined();
        expect(restored.metadata?.taskProgress).toBeUndefined();
        expect(restored.metadata?.taskOutcome).toBeUndefined();
        expect(restored.metadata?.generationSubmissionState).toBeUndefined();
        expect(restored.metadata?.taskClientOperationId).toBeUndefined();
        expect(restored.metadata?.agentGenerationContinuation).toBeUndefined();
        expect(restored.metadata?.fileUpload).toBeUndefined();
        expect(restored.metadata?.prompt).toBe("保留原描述");
        expect(isCanvasNodeGenerating(restored)).toBe(false);
        expect(readNodeTaskOutcome(restored.metadata)).toEqual({ phase: "ready", regenerate: "allowed", reason: "result_ready" });

        // 原节点本就是已完成媒体（含仅存 storageKey / previewContent 的归档节点）时原样恢复几何与元数据。
        const settledOriginal = {
            ...placeholder(),
            width: 500,
            height: 281,
            metadata: { content: "https://example.test/settled.png", storageKey: "resource:settled", status: "success" as const },
        };
        expect(restoreFailedUploadNode(uploadingItem, settledOriginal, "失败").metadata).toEqual(settledOriginal.metadata);

        const archivedStorageKeyOnlyOriginal = {
            ...placeholder(),
            width: 560,
            height: 315,
            metadata: mediaResultMetadata("library", {
                storageKey: "resource:archived-only",
                status: "success" as const,
                prompt: "归档镜头",
            }),
        };
        const restoredArchived = restoreFailedUploadNode(uploadingItem, archivedStorageKeyOnlyOriginal, "上传中断");
        expect(restoredArchived.width).toBe(560);
        expect(restoredArchived.height).toBe(315);
        expect(restoredArchived.metadata).toEqual(archivedStorageKeyOnlyOriginal.metadata);

        // status 已是 success 但仍携带在途 taskStatus / taskOutcome 时，回退同样清理已取消的在途状态。
        const successWithRunningTaskOriginal = {
            ...placeholder(),
            width: 600,
            height: 338,
            metadata: {
                content: "https://example.test/prev-ready.png",
                storageKey: "resource:prev-ready",
                status: "success" as const,
                taskId: "task-reedit-1",
                taskStatus: "running" as const,
                taskOutcome: { phase: "running" as const, regenerate: "blocked" as const, reason: "task_running" },
            },
        };
        const restoredRunningOnSuccess = restoreFailedUploadNode(uploadingItem, successWithRunningTaskOriginal, "网络断开");
        expect(restoredRunningOnSuccess.width).toBe(600);
        expect(restoredRunningOnSuccess.metadata?.content).toBe("https://example.test/prev-ready.png");
        expect(restoredRunningOnSuccess.metadata?.status).toBe("success");
        expect(restoredRunningOnSuccess.metadata?.taskId).toBeUndefined();
        expect(restoredRunningOnSuccess.metadata?.taskStatus).toBeUndefined();
        expect(restoredRunningOnSuccess.metadata?.taskOutcome).toBeUndefined();
        expect(isCanvasNodeGenerating(restoredRunningOnSuccess)).toBe(false);

        // 无媒体的运行中生成节点（真实携带 taskStatus/taskOutcome/generationErrorCode/isBatchRoot）：
        // 1) 替换占位与失败回退都彻底清空旧生成状态，不叠加上传错误与任务 running；
        // 2) 若旧版本替换占位已持久化且未清干净，重开执行 interruptFileUpload 时同样清理干净。
        const emptyLoadingOriginal = {
            ...placeholder(),
            metadata: {
                status: "loading" as const,
                taskId: "task-empty-1",
                taskStatus: "running" as const,
                taskProgress: 38,
                taskStage: "排队中",
                taskOutcome: { phase: "running" as const, regenerate: "blocked" as const, reason: "task_running" },
                generationErrorCode: "upstream_timeout",
                isBatchRoot: true,
                batchChildIds: ["child-1"],
            },
        };
        const realisticPlaceholderFromEmpty = {
            ...emptyLoadingOriginal,
            metadata: mediaResultMetadata("upload", {
                ...clearReplacedGenerationTaskMetadata(emptyLoadingOriginal.metadata),
                fileUpload: "uploading",
                status: undefined,
            }),
        };
        expect(realisticPlaceholderFromEmpty.metadata?.taskStatus).toBeUndefined();
        expect(realisticPlaceholderFromEmpty.metadata?.taskOutcome).toBeUndefined();
        expect(realisticPlaceholderFromEmpty.metadata?.generationErrorCode).toBeUndefined();
        expect(realisticPlaceholderFromEmpty.metadata?.isBatchRoot).toBeUndefined();
        expect(isCanvasNodeGenerating(realisticPlaceholderFromEmpty)).toBe(false);

        // 即使传入仍残留旧 taskStatus / taskOutcome / generationErrorCode 的未清理占位，restoreFailedUploadNode 与 interruptFileUpload 也一并清除。
        const uncleanedLegacyPlaceholder = {
            ...emptyLoadingOriginal,
            metadata: {
                ...emptyLoadingOriginal.metadata,
                status: undefined,
                taskId: undefined,
                fileUpload: "uploading" as const,
            },
        };
        const failedEmpty = restoreFailedUploadNode(uncleanedLegacyPlaceholder, emptyLoadingOriginal, "磁盘空间不足");
        expect(failedEmpty.metadata?.fileUpload).toBe("error");
        expect(failedEmpty.metadata?.errorDetails).toBe("磁盘空间不足");
        expect(failedEmpty.metadata?.taskId).toBeUndefined();
        expect(failedEmpty.metadata?.status).toBeUndefined();
        expect(failedEmpty.metadata?.taskStatus).toBeUndefined();
        expect(failedEmpty.metadata?.taskOutcome).toBeUndefined();
        expect(failedEmpty.metadata?.generationErrorCode).toBeUndefined();
        expect(failedEmpty.metadata?.isBatchRoot).toBeUndefined();
        expect(isCanvasNodeGenerating(failedEmpty)).toBe(false);

        const reopenedInterrupted = interruptFileUpload(uncleanedLegacyPlaceholder);
        expect(reopenedInterrupted.metadata?.fileUpload).toBe("error");
        expect(reopenedInterrupted.metadata?.taskStatus).toBeUndefined();
        expect(reopenedInterrupted.metadata?.taskOutcome).toBeUndefined();
        expect(reopenedInterrupted.metadata?.generationErrorCode).toBeUndefined();
        expect(isCanvasNodeGenerating(reopenedInterrupted)).toBe(false);
        expect(persistCanvasNodeFailure(reopenedInterrupted).metadata?.generationFailure).toBeUndefined();
    });

    test("替换上传期间用户主动开启的自由缩放（freeResize）在上传完成时保留，替换前的旧 freeResize 仍清零", () => {
        const activeResizedPlaceholder = {
            fileUpload: "uploading" as const,
            freeResize: true,
            manualSize: true,
        };
        const settledKeepFreeResize = buildSettledUploadNodeMetadata(
            activeResizedPlaceholder,
            { content: "https://example.test/new.png", storageKey: "resource:new", status: "success" },
            { replace: true, preserveFreeResize: true },
        );
        expect(settledKeepFreeResize.freeResize).toBe(true);
        expect(settledKeepFreeResize.manualSize).toBe(true);

        const settledResetFreeResize = buildSettledUploadNodeMetadata(
            { freeResize: true },
            { content: "https://example.test/new.png", storageKey: "resource:new", status: "success" },
            { replace: true, preserveFreeResize: false },
        );
        expect(settledResetFreeResize.freeResize).toBe(false);
    });
});

test("真实进度与遮罩浓度反向关联，不生成未知进度", () => {
    expect(uploadPercent(20, 100)).toBe(20);
    expect(uploadPercent(150, 100)).toBe(100);
    expect(uploadPercent(0, 0)).toBeUndefined();
    expect(uploadPercent(NaN, 100)).toBeUndefined();
    expect(uploadVeilOpacity(0)).toBe(1);
    expect(uploadVeilOpacity(50)).toBeCloseTo(0.55);
    expect(uploadVeilOpacity(100)).toBeCloseTo(0.1);
});

test("统一识别图片、视频、音频、纯文本文件，不误收 PDF 或 Word", () => {
    for (const [name, type, expected] of [
        ["image.png", "image/png", CanvasNodeType.Image], ["video.mp4", "video/mp4", CanvasNodeType.Video],
        ["sound.ogg", "audio/ogg", CanvasNodeType.Audio], ["sound.wav", "", CanvasNodeType.Audio],
        ["note.md", "", CanvasNodeType.Text], ["note.txt", "text/plain", CanvasNodeType.Text],
        ["document.pdf", "application/pdf", null], ["document.docx", "", null],
    ] as const) expect(uploadNodeType({ name, type })).toBe(expected);
});

test("音频与文本在传输前就有独立占位，可重试且不带模型生成状态", async () => {
    for (const [name, type, expected] of [["voice.mp3", "audio/mpeg", CanvasNodeType.Audio], ["note.md", "text/markdown", CanvasNodeType.Text]] as const) {
        const node = await createFileUploadPlaceholder("file", new File(["content"], name, { type }), { x: 0, y: 0 });
        expect(node.type).toBe(expected);
        expect(node.metadata?.fileUpload).toBe("uploading");
        expect(node.metadata?.content).toBeUndefined();
        expect(node.metadata?.status).toBeUndefined();
        expect(interruptFileUpload(node).metadata?.fileUpload).toBe("error");
    }
});

test("H.265 视频不需要浏览器解码即可创建上传节点，空 MIME 的 MOV 也可导入", async () => {
    for (const [name, type] of [["hevc.mp4", "video/mp4"], ["hevc.mov", ""], ["hevc.mkv", "application/octet-stream"]]) {
        const node = await createFileUploadPlaceholder("hevc", new File(["undecodable video"], name, { type }), { x: 100, y: 200 });
        expect(node.type).toBe(CanvasNodeType.Video);
        expect(node.title).toBe(name);
        expect(node.metadata?.fileUpload).toBe("uploading");
        expect(node.position.x + node.width / 2).toBe(100);
        expect(node.metadata?.naturalWidth).toBeUndefined();
    }
});

test("所有资源渲染真实百分比，100% 仍等待保存，磨砂渐淡但文案不淡出", () => {
    for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text]) {
        const node = { ...placeholder(), type, metadata: { fileUpload: "uploading" as const, fileUploadProgress: 50 } };
        const html = renderToStaticMarkup(<CanvasFileUploadContent node={node} theme={canvasThemes.light} />);
        expect(html).toContain("已上传 50%");
        expect(html).toContain('opacity:0.55');
        expect(html).toContain('aria-valuenow="50"');
        const complete = renderToStaticMarkup(<CanvasFileUploadContent node={{ ...node, metadata: { ...node.metadata, fileUploadProgress: 100 } }} theme={canvasThemes.dark} />);
        expect(complete).toContain("文件已传输，正在保存与处理");
        expect(complete).toContain('aria-busy="true"');
    }
});
