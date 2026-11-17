import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";

import {
    buildSettledUploadNodeMetadata,
    createImageUploadPlaceholder,
    stripStaleFileUploadMetadata,
} from "../src/lib/canvas/canvas-file-upload";
import { rebaseCanvasDocumentThreeWay } from "../src/lib/canvas/canvas-document-rebase";
import { canCanvasNodeAcceptGenerationTask, canCanvasNodeEnterGenerationBind } from "../src/lib/canvas/canvas-generation-task-identity";
import { applyGenerationTaskResultToNodes } from "../src/lib/canvas/canvas-generation-task-sync";
import {
    canvasMediaNodeOrigin,
    canOpenCanvasNodePromptPanel,
    mediaResultMetadata,
    normalizeCanvasMediaNodeSemantics,
} from "../src/lib/canvas/canvas-node-semantics";
import { canvasGenerationTaskNodes } from "../src/pages/canvas/canvas-generation-failure";
import { executeTextGeneration } from "../src/pages/canvas/canvas-text-generation-executor";
import { useCanvasUpload } from "../src/pages/canvas/use-canvas-upload";
import * as generationTaskApi from "../src/services/api/generation-task";
import type { GenerationTask } from "../src/services/api/task-center";
import { bindBackendCanvasGenerationResult } from "../src/services/canvas-generation-consumer";
import * as generationTarget from "../src/services/canvas-generation-target";
import * as fileStorage from "../src/services/file-storage";
import * as imageStorage from "../src/services/image-storage";
import * as assetSync from "../src/services/project-asset-sync";
import { createCanvasPageUiStore } from "../src/stores/canvas/use-canvas-page-ui-store";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import type { AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";

const file = { name: "photo.png", size: 1234, type: "image/png" };
const placeholder = () => createImageUploadPlaceholder("upload", file, { x: 100, y: 200 }, { width: 1920, height: 1080 });

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("画布上传与旧生成任务隔离门禁", () => {
    test("本地文件替换在上传中与上传完成后均拒绝旧生成任务按 nodeId 写回覆盖", async () => {
        const baseNode = placeholder();
        const uploadingReplacement = {
            ...baseNode,
            metadata: mediaResultMetadata("upload", {
                content: "https://example.test/old-gen.png",
                storageKey: "resource:old-gen",
                fileUpload: "uploading",
                status: undefined,
                taskId: undefined,
                taskClientOperationId: undefined,
                generationSubmissionState: undefined,
            }),
        };
        const settledReplacement = {
            ...baseNode,
            metadata: mediaResultMetadata(
                "upload",
                buildSettledUploadNodeMetadata(
                    uploadingReplacement.metadata,
                    { content: "https://example.test/user-upload.png", storageKey: "resource:user-upload", status: "success" },
                    { replace: true },
                ),
            ),
        };

        const staleRunningTask: GenerationTask = {
            id: "task-old-inflight",
            type: "canvas_image",
            status: "running",
            progress: 70,
            stage: "生成中",
            prompt: "旧任务",
            attempts: 1,
            clientContext: { nodeId: baseNode.id },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:05.000Z",
        };
        const staleFailedTask: GenerationTask = {
            ...staleRunningTask,
            status: "failed",
            errorCode: "invalid_params",
            error: "旧任务失败",
        };
        const staleSucceededTask: GenerationTask = {
            ...staleRunningTask,
            status: "succeeded",
            resultJson: JSON.stringify({ images: [{ url: "https://example.test/stale-gen.png", storageKey: "resource:stale-gen", width: 1024, height: 1024 }] }),
        };

        for (const candidate of [uploadingReplacement, settledReplacement]) {
            const input = [candidate];
            for (const staleTask of [staleRunningTask, staleFailedTask, staleSucceededTask]) {
                const synced = canvasGenerationTaskNodes(input, candidate.id, staleTask);
                expect(synced).toBe(input);
                expect(synced[0]).toBe(candidate);
                expect(synced[0]?.metadata?.taskId).toBeUndefined();
            }
            const applied = await applyGenerationTaskResultToNodes(input, staleSucceededTask, candidate.id);
            expect(applied.updated).toBe(false);
            expect(applied.nodes[0]).toBe(candidate);
        }
        expect(settledReplacement.metadata?.content).toBe("https://example.test/user-upload.png");
        expect(settledReplacement.metadata?.status).toBe("success");
    });

    test("useCanvasUpload 替换节点在慢速图片解码完成前即同步取消原生成并阻断旧任务写回", async () => {
        const originalImage = globalThis.Image;
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        const decodeStarted = deferred();
        const decodeGate = deferred();
        const uploadMock = spyOn(imageStorage, "uploadImage").mockImplementation(async () => ({
            url: "https://example.test/replaced-final.png",
            storageKey: "resource:replaced-final",
            width: 1200,
            height: 800,
            bytes: 2048,
            mimeType: "image/png",
        }));
        const ensureMock = spyOn(assetSync, "ensureCanvasNodeAsset").mockImplementation(async () => ({
            assetId: "asset-replaced-1",
            created: true,
            linkedToProject: false,
            confirmed: true,
        }));

        try {
            URL.createObjectURL = () => "blob:slow-decode";
            URL.revokeObjectURL = () => undefined;
            globalThis.Image = class {
                src = "";
                naturalWidth = 1200;
                naturalHeight = 800;
                async decode() {
                    decodeStarted.resolve();
                    await decodeGate.promise;
                }
            } as unknown as typeof Image;

            const runningNode: CanvasNodeData = {
                id: "node-replace-race",
                type: CanvasNodeType.Image,
                title: "生成中图片",
                position: { x: 100, y: 120 },
                width: 320,
                height: 220,
                metadata: {
                    status: "loading",
                    taskId: "task-race-old",
                    taskStatus: "running",
                    taskClientOperationId: "op-race-old",
                    prompt: "原提示词",
                },
            };
            const nodesRef = { current: [runningNode] };
            const connectionsRef = { current: [] as CanvasConnection[] };
            const selectedNodeIdsRef = { current: new Set<string>() };
            const canceledIds: string[] = [];
            const pageUi = createCanvasPageUiStore();
            let uploadHook!: ReturnType<typeof useCanvasUpload>;

            function Harness() {
                uploadHook = useCanvasUpload({
                    pageUi,
                    canvasId: "canvas-race",
                    nodesRef,
                    connectionsRef,
                    selectedNodeIdsRef,
                    getCanvasCenter: () => ({ x: 0, y: 0 }),
                    screenToCanvas: (x, y) => ({ x, y }),
                    setNodes: (value) => {
                        nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
                    },
                    setConnections: (value) => {
                        connectionsRef.current = typeof value === "function" ? value(connectionsRef.current) : value;
                    },
                    onCancelNodeGeneration: (nodeId) => {
                        canceledIds.push(nodeId);
                    },
                });
                return null;
            }

            renderToStaticMarkup(
                <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                    <App>
                        <Harness />
                    </App>
                </QueryClientProvider>,
            );

            const replacePromise = uploadHook.replaceNodeMedia(
                "node-replace-race",
                new File(["binary"], "new-local.png", { type: "image/png" }),
            );
            await decodeStarted.promise;

            // 图片尚在 decode 等待窗口内：onCancelNodeGeneration 已执行，且节点已写入上传尝试标识与 upload 来源
            expect(canceledIds).toEqual(["node-replace-race"]);
            const midDecodeNode = nodesRef.current[0]!;
            expect(midDecodeNode.metadata?.fileUpload).toBe("uploading");
            expect(midDecodeNode.metadata?.resultOrigin).toBe("upload");
            expect(midDecodeNode.metadata?.fileUploadAttemptId).toBeTruthy();
            expect(midDecodeNode.metadata?.taskId).toBeUndefined();

            const lateSucceededOldTask: GenerationTask = {
                id: "task-race-old",
                type: "canvas_image",
                status: "succeeded",
                prompt: "原提示词",
                attempts: 1,
                clientOperationId: "op-race-old",
                resultJson: JSON.stringify({
                    images: [{ url: "https://example.test/old-gen.png", storageKey: "resource:old-gen", width: 1024, height: 1024 }],
                }),
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:05.000Z",
            };
            expect(canCanvasNodeAcceptGenerationTask(midDecodeNode, lateSucceededOldTask)).toBe(false);
            expect(canCanvasNodeEnterGenerationBind(midDecodeNode, lateSucceededOldTask)).toBe(false);
            expect(canvasGenerationTaskNodes(nodesRef.current, "node-replace-race", lateSucceededOldTask)).toBe(nodesRef.current);
            const lateApplied = await applyGenerationTaskResultToNodes(nodesRef.current, lateSucceededOldTask, "node-replace-race");
            expect(lateApplied.updated).toBe(false);

            decodeGate.resolve();
            expect(await replacePromise).toBe(true);
            const finalNode = nodesRef.current[0]!;
            expect(finalNode.metadata?.content).toBe("https://example.test/replaced-final.png");
            expect(finalNode.metadata?.storageKey).toBe("resource:replaced-final");
            expect(finalNode.metadata?.status).toBe("success");
            expect(finalNode.metadata?.resultOrigin).toBe("upload");
            expect(finalNode.metadata?.fileUpload).toBeUndefined();
            expect(finalNode.metadata?.taskId).toBeUndefined();
        } finally {
            uploadMock.mockRestore();
            ensureMock.mockRestore();
            globalThis.Image = originalImage;
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        }
    });

    test("任务接收门禁：残留旧 taskId 的已上传节点（含无 fileUpload 且缺 resultOrigin 的已结算历史节点）均拒绝写回，带匹配 operationId 的 derived 异常节点允许恢复", () => {
        const corruptedUploadedWithStaleTaskId = {
            ...placeholder(),
            metadata: mediaResultMetadata("upload", {
                content: "https://example.test/uploaded.png",
                storageKey: "resource:uploaded",
                status: "success",
                taskId: "task-stale-old",
            }),
        };
        expect(canCanvasNodeAcceptGenerationTask(corruptedUploadedWithStaleTaskId, { id: "task-stale-old" })).toBe(false);
        expect(canCanvasNodeEnterGenerationBind(corruptedUploadedWithStaleTaskId, { id: "task-stale-old" })).toBe(false);

        const legacyStaleUploadWithoutOrigin = {
            ...placeholder(),
            metadata: {
                content: "https://example.test/legacy-upload.png",
                storageKey: "resource:legacy-upload",
                status: "success" as const,
                fileUpload: "uploading" as const,
                taskId: "task-legacy-old",
                taskStatus: "running" as const,
            },
        };
        expect(canCanvasNodeAcceptGenerationTask(legacyStaleUploadWithoutOrigin, { id: "task-legacy-old" })).toBe(false);
        expect(canCanvasNodeEnterGenerationBind(legacyStaleUploadWithoutOrigin, { id: "task-legacy-old" })).toBe(false);
        const strippedLegacyUpload = stripStaleFileUploadMetadata(legacyStaleUploadWithoutOrigin);
        expect(strippedLegacyUpload.metadata?.taskId).toBeUndefined();
        expect(strippedLegacyUpload.metadata?.taskStatus).toBeUndefined();
        expect(canCanvasNodeAcceptGenerationTask(strippedLegacyUpload, { id: "task-legacy-old" })).toBe(false);
        const normalizedLegacyUpload = normalizeCanvasMediaNodeSemantics(legacyStaleUploadWithoutOrigin);
        expect(normalizedLegacyUpload.metadata?.nodeRole).toBe("result");
        expect(normalizedLegacyUpload.metadata?.resultOrigin).toBe("upload");
        expect(canCanvasNodeAcceptGenerationTask(normalizedLegacyUpload, { id: "task-legacy-old" })).toBe(false);

        // 已结算（无 fileUpload 标记、无 resultOrigin）但残留旧 taskId（含 taskStatus="succeeded"）的历史上传节点：不误判为 generated，也不接受旧任务写回
        for (const staleTaskStatus of [undefined, "succeeded" as const]) {
            const settledMissingOriginStaleTask = {
                ...placeholder(),
                metadata: {
                    content: "https://example.test/settled-legacy-upload.png",
                    storageKey: "resource:settled-legacy-upload",
                    status: "success" as const,
                    taskId: "task-old",
                    ...(staleTaskStatus ? { taskStatus: staleTaskStatus } : {}),
                },
            };
            expect(canvasMediaNodeOrigin(settledMissingOriginStaleTask)).toBe("unknown");
            expect(canCanvasNodeAcceptGenerationTask(settledMissingOriginStaleTask, { id: "task-old", status: "failed" })).toBe(false);
            expect(canCanvasNodeAcceptGenerationTask(settledMissingOriginStaleTask, { id: "task-old", status: "succeeded" })).toBe(false);
            const normalizedSettledMissingOrigin = normalizeCanvasMediaNodeSemantics(settledMissingOriginStaleTask);
            expect(normalizedSettledMissingOrigin.metadata?.resultOrigin).toBe("unknown");
            expect(canOpenCanvasNodePromptPanel(normalizedSettledMissingOrigin)).toBe(false);
            expect(canCanvasNodeAcceptGenerationTask(normalizedSettledMissingOrigin, { id: "task-old", status: "succeeded" })).toBe(false);
        }

        // 已结算、无 resultOrigin、无 taskId、无 taskClientOperationId 的普通媒体节点：连 queued / running 任务也拒绝按 nodeId 写回
        const untypedSettledPlainMedia = {
            ...placeholder(),
            metadata: {
                content: "https://example.test/plain-settled.png",
                storageKey: "resource:plain-settled",
                status: "success" as const,
            },
        };
        expect(canCanvasNodeAcceptGenerationTask(untypedSettledPlainMedia, { id: "task-rogue-queued", status: "queued" })).toBe(false);
        expect(canCanvasNodeAcceptGenerationTask(untypedSettledPlainMedia, { id: "task-rogue-running", status: "running" })).toBe(false);
        expect(canCanvasNodeEnterGenerationBind(untypedSettledPlainMedia, { id: "task-rogue-succeeded", status: "succeeded" })).toBe(false);

        // 真正带有生成证据（generationEffectKeys 或匹配 clientOperationId）的无 resultOrigin 历史生成节点：允许同步非失败终态
        const confirmedLegacyGenerated = {
            ...placeholder(),
            metadata: {
                content: "https://example.test/confirmed-gen.png",
                storageKey: "resource:confirmed-gen",
                status: "success" as const,
                taskId: "task-confirmed-gen",
                generationEffectKeys: ["attach-node:upload:0"],
            },
        };
        expect(canvasMediaNodeOrigin(confirmedLegacyGenerated)).toBe("generated");
        expect(canCanvasNodeAcceptGenerationTask(confirmedLegacyGenerated, { id: "task-confirmed-gen", status: "succeeded" })).toBe(true);
        expect(canCanvasNodeAcceptGenerationTask(confirmedLegacyGenerated, { id: "task-confirmed-gen", status: "failed" })).toBe(false);

        // 同 taskId 的无 resultOrigin 已完成节点：窄修复不得把后端明确返回的 retrievable / running 结论覆盖成 ready
        const staleRunningBoundNode = {
            ...placeholder(),
            id: "node-heal-guard",
            metadata: {
                content: "https://example.test/prev-bound.png",
                storageKey: "resource:prev-bound",
                assetId: "asset-1",
                status: "success" as const,
                taskId: "task-retrievable-1",
                taskStatus: "succeeded" as const,
                taskOutcome: { phase: "running" as const, regenerate: "blocked" as const, reason: "in_flight" },
            },
        };
        const [retrievableSynced] = canvasGenerationTaskNodes([staleRunningBoundNode], "node-heal-guard", {
            id: "task-retrievable-1",
            type: "canvas_image",
            prompt: "test",
            status: "succeeded",
            outcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
            attempts: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:05.000Z",
        });
        expect(retrievableSynced?.metadata?.taskOutcome).toEqual({
            phase: "retrievable",
            regenerate: "blocked",
            reason: "delivery_pending",
        });

        const failedDerivedWithOperationId = {
            ...placeholder(),
            metadata: mediaResultMetadata("derived", {
                status: "error",
                generationSubmissionState: "unknown",
                taskClientOperationId: "op-upscale-recover-1",
            }),
        };
        expect(
            canCanvasNodeAcceptGenerationTask(failedDerivedWithOperationId, {
                id: "task-upscale-recover-1",
                clientOperationId: "op-upscale-recover-1",
            }),
        ).toBe(true);
        expect(
            canCanvasNodeEnterGenerationBind(failedDerivedWithOperationId, {
                id: "task-upscale-recover-1",
                clientOperationId: "op-upscale-recover-1",
            }),
        ).toBe(true);
        expect(
            canCanvasNodeAcceptGenerationTask(failedDerivedWithOperationId, {
                id: "task-upscale-other",
                clientOperationId: "op-upscale-other",
            }),
        ).toBe(false);
        expect(
            canCanvasNodeEnterGenerationBind(failedDerivedWithOperationId, {
                id: "task-upscale-other",
                clientOperationId: "op-upscale-other",
            }),
        ).toBe(false);
        expect(
            canCanvasNodeAcceptGenerationTask(failedDerivedWithOperationId, {
                id: "task-unrelated-no-op",
            }),
        ).toBe(false);
        expect(
            canCanvasNodeEnterGenerationBind(failedDerivedWithOperationId, {
                id: "task-unrelated-no-op",
            }),
        ).toBe(false);

        const loadingUploadOrigin = {
            ...placeholder(),
            metadata: mediaResultMetadata("upload", {
                content: "https://example.test/local.png",
                storageKey: "resource:local",
                status: "loading",
                fileUpload: undefined,
            }),
        };
        expect(canCanvasNodeAcceptGenerationTask(loadingUploadOrigin, { id: "task-any" })).toBe(false);
        expect(canCanvasNodeEnterGenerationBind(loadingUploadOrigin, { id: "task-any" })).toBe(false);

        const submittingNewOperationNode = {
            ...placeholder(),
            metadata: {
                status: "loading" as const,
                generationSubmissionState: "submitting" as const,
                taskClientOperationId: "op-new-submit",
            },
        };
        expect(canCanvasNodeAcceptGenerationTask(submittingNewOperationNode, { id: "task-legacy-without-op" })).toBe(false);
        expect(canCanvasNodeEnterGenerationBind(submittingNewOperationNode, { id: "task-legacy-without-op" })).toBe(false);
        expect(
            canCanvasNodeAcceptGenerationTask(submittingNewOperationNode, {
                id: "task-matching-op",
                clientOperationId: "op-new-submit",
            }),
        ).toBe(true);

        for (const nonGenOrigin of ["upload", "library", "imported"] as const) {
            const dirtySettledNonGen = normalizeCanvasMediaNodeSemantics({
                ...placeholder(),
                metadata: {
                    content: "https://example.test/non-gen.png",
                    storageKey: "resource:non-gen",
                    status: "success",
                    resultOrigin: nonGenOrigin,
                    taskId: "task-stale-99",
                    taskStatus: "failed",
                    taskOutcome: { phase: "failed", regenerate: "confirm", reason: "task_failed" },
                    generationErrorCode: "upstream_failed",
                },
            });
            expect(dirtySettledNonGen.metadata?.taskId).toBeUndefined();
            expect(dirtySettledNonGen.metadata?.taskStatus).toBeUndefined();
            expect(dirtySettledNonGen.metadata?.taskOutcome).toBeUndefined();
            expect(dirtySettledNonGen.metadata?.generationErrorCode).toBeUndefined();
        }
    });

    test("bindBackendCanvasGenerationResult 通过统一门禁在本地上传、历史残留上传及不匹配 derived 节点上主动中止", async () => {
        const succeededTask: GenerationTask = {
            id: "task-upscale-1",
            type: "canvas_image",
            status: "succeeded",
            prompt: "超分",
            attempts: 1,
            clientOperationId: "op-upscale-1",
            outputs: [{ outputIndex: 0, kind: "image", resourceId: "res-up", url: "/api/resources/res-up/file", storageKey: "resource:res-up" }],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:05.000Z",
        };
        for (const rejectedNode of [
            {
                ...placeholder(),
                id: "node-up-1",
                metadata: mediaResultMetadata("upload", {
                    content: "https://example.test/prev.png",
                    storageKey: "resource:prev",
                    fileUpload: "uploading",
                }),
            },
            {
                ...placeholder(),
                id: "node-up-1",
                metadata: mediaResultMetadata("upload", {
                    content: "https://example.test/new-local.png",
                    storageKey: "resource:new-local",
                    status: "success",
                }),
            },
            {
                ...placeholder(),
                id: "node-up-1",
                metadata: {
                    content: "https://example.test/legacy-local.png",
                    storageKey: "resource:legacy-local",
                    status: "success" as const,
                    fileUpload: "uploading" as const,
                    taskId: "task-upscale-1",
                },
            },
            {
                ...placeholder(),
                id: "node-up-1",
                metadata: mediaResultMetadata("derived", {
                    status: "error",
                    taskClientOperationId: "op-different-derived",
                }),
            },
        ]) {
            let persistCalls = 0;
            let bindCalls = 0;
            const nodesRef = { current: [rejectedNode] };
            let caught: unknown;
            try {
                await bindBackendCanvasGenerationResult({
                    canvasId: "canvas-1",
                    nodeId: "node-up-1",
                    task: succeededTask,
                    isCurrent: () => true,
                    nodesRef,
                    setNodes: () => undefined,
                    runtime: {
                        hydrateOutputs: async () => undefined,
                        persistDocument: async () => {
                            persistCalls += 1;
                        },
                        bindOutput: async () => {
                            bindCalls += 1;
                            throw new Error("should not reach bindOutput");
                        },
                    },
                });
            } catch (error) {
                caught = error;
            }
            expect(caught instanceof Error && caught.name === "AbortError").toBe(true);
            expect(persistCalls).toBe(0);
            expect(bindCalls).toBe(0);
        }
    });

    test("上传或替换后的 TXT/MD 文本节点发起原地改写（executeTextGeneration）时清理上传标记并正常接收与写回新生成任务", async () => {
        const uploadFileMock = spyOn(fileStorage, "uploadMediaFile").mockImplementation(async () => ({
            url: "https://example.test/outline.md",
            storageKey: "resource:outline-md",
            bytes: 128,
            mimeType: "text/markdown",
        }));
        const ensureMock = spyOn(assetSync, "ensureCanvasNodeAsset").mockImplementation(async () => ({
            assetId: "asset-outline-1",
            created: true,
            linkedToProject: false,
            confirmed: true,
        }));
        const prepareTargetMock = spyOn(generationTarget, "persistCanvasGenerationTarget").mockImplementation(async () => undefined);
        const runTaskMock = spyOn(generationTaskApi, "runBackendGenerationTask").mockImplementation(async (options) => {
            const createdTask: GenerationTask = {
                id: "task-text-rewrite-1",
                type: "canvas_text",
                status: "succeeded",
                prompt: options.prompt,
                attempts: 1,
                clientOperationId: options.clientOperationId,
                resultJson: JSON.stringify({ mode: "text", text: "AI 原地扩写后的完整剧本" }),
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:02.000Z",
            };
            options.onTaskUpdate?.(createdTask);
            return { mode: "text" as const, text: "AI 原地扩写后的完整剧本", task: createdTask };
        });

        try {
            useCanvasStore.setState({ projects: [] });
            const canvasId = "canvas-text-rewrite-guard";
            const nodesRef = { current: [] as CanvasNodeData[] };
            const connectionsRef = { current: [] as CanvasConnection[] };
            const selectedNodeIdsRef = { current: new Set<string>() };
            const pageUi = createCanvasPageUiStore();
            let uploadHook!: ReturnType<typeof useCanvasUpload>;

            function Harness() {
                uploadHook = useCanvasUpload({
                    pageUi,
                    canvasId,
                    nodesRef,
                    connectionsRef,
                    selectedNodeIdsRef,
                    getCanvasCenter: () => ({ x: 0, y: 0 }),
                    screenToCanvas: (x, y) => ({ x, y }),
                    setNodes: (value) => {
                        nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
                    },
                    setConnections: (value) => {
                        connectionsRef.current = typeof value === "function" ? value(connectionsRef.current) : value;
                    },
                });
                return null;
            }

            renderToStaticMarkup(
                <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                    <App>
                        <Harness />
                    </App>
                </QueryClientProvider>,
            );

            const createdId = await uploadHook.createFileNode(
                new File(["原始大纲内容"], "outline.md", { type: "text/markdown" }),
                { x: 200, y: 200 },
            );
            expect(createdId).toBeTruthy();
            const uploadedTextNode = nodesRef.current.find((item) => item.id === createdId)!;
            expect(uploadedTextNode.type).toBe(CanvasNodeType.Text);
            expect(uploadedTextNode.metadata?.resultOrigin).toBe("upload");
            expect(uploadedTextNode.metadata?.fileUploadAttemptId).toBeTruthy();
            // 未主动发起改写前，上传文本节点拒绝任何游离生成任务写回
            expect(canCanvasNodeAcceptGenerationTask(uploadedTextNode, { id: "task-stray-text", status: "succeeded" })).toBe(false);

            useCanvasStore.setState({
                projects: [{
                    id: canvasId,
                    name: "Text Rewrite Guard",
                    nodes: nodesRef.current,
                    connections: [],
                    viewport: { x: 0, y: 0, zoom: 1 },
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                }],
            });

            await executeTextGeneration({
                nodeId: uploadedTextNode.id,
                sourceNode: uploadedTextNode,
                prompt: "请将大纲扩写为完整剧本",
                effectivePrompt: "请将大纲扩写为完整剧本",
                generationConfig: {} as AiConfig,
                generationContext: {
                    referenceImages: [],
                    referenceVideos: [],
                    referenceAudios: [],
                    resolvedCharacterVersions: [],
                } as never,
                controller: new AbortController(),
                editingTextNode: true,
                projectId: canvasId,
                setNodes: (value) => {
                    nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
                },
                setConnections: (value) => {
                    connectionsRef.current = typeof value === "function" ? value(connectionsRef.current) : value;
                },
                startGenerationRequest: () => undefined,
                finishGenerationRequest: () => undefined,
                bindGenerationTask: (targetId, task) => {
                    nodesRef.current = canvasGenerationTaskNodes(nodesRef.current, targetId, task);
                },
                applyGenerationTaskResult: async (targetId, task) => {
                    const applied = await applyGenerationTaskResultToNodes(nodesRef.current, task, targetId);
                    expect(applied.updated).toBe(true);
                    nodesRef.current = applied.nodes;
                },
                registerPendingNodeIds: () => undefined,
                clientOperationId: "op-text-rewrite",
                nodesRef,
                canvasNodes: nodesRef.current,
                canvasConnections: connectionsRef.current,
            });

            const rewrittenNode = nodesRef.current.find((item) => item.id === uploadedTextNode.id)!;
            expect(rewrittenNode.metadata?.content).toBe("AI 原地扩写后的完整剧本");
            expect(rewrittenNode.metadata?.status).toBe("success");
            expect(rewrittenNode.metadata?.taskId).toBe("task-text-rewrite-1");
            expect(rewrittenNode.metadata?.resultOrigin).toBeUndefined();
            expect(rewrittenNode.metadata?.fileUploadAttemptId).toBeUndefined();
            expect(rewrittenNode.metadata?.storageKey).toBeUndefined();
        } finally {
            uploadFileMock.mockRestore();
            ensureMock.mockRestore();
            prepareTargetMock.mockRestore();
            runTaskMock.mockRestore();
            useCanvasStore.setState({ projects: [] });
        }
    });

    test("handleImportUrl 同链接替换副本节点与 replaceNodeMedia 替换 Script 节点均保留新尝试标识并抵御三路合并滞后远端覆盖", async () => {
        const ensureMock = spyOn(assetSync, "ensureCanvasNodeAsset").mockImplementation(async () => ({
            assetId: "asset-import-1", created: true, linkedToProject: false, confirmed: true,
        }));
        try {
            const baseImportedCopy: CanvasNodeData = {
                id: "node-url-copy",
                type: CanvasNodeType.Image,
                title: "same.png",
                position: { x: 80, y: 120 },
                width: 480,
                height: 360,
                metadata: {
                    copiedFromNodeId: "src-1",
                    content: "https://cdn.example.test/same.png",
                    status: "success",
                    nodeRole: "result",
                    resultOrigin: "imported",
                    fileUploadAttemptId: "att-old-import",
                },
            };
            const baseScriptNode: CanvasNodeData = {
                id: "node-script-1",
                type: CanvasNodeType.Script,
                title: "旧剧本",
                position: { x: 600, y: 120 },
                width: 460,
                height: 320,
                metadata: {
                    composerContent: "# 旧场次",
                    status: "loading",
                    taskId: "task-scr-old",
                    taskStatus: "running",
                },
            };
            const nodesRef = { current: [
                { ...baseImportedCopy, metadata: { ...baseImportedCopy.metadata, status: "loading" as const, taskId: "task-url-old" } },
                baseScriptNode,
            ] };
            const connectionsRef = { current: [] as CanvasConnection[] };
            const selectedNodeIdsRef = { current: new Set<string>() };
            const canceledIds: string[] = [];
            const pageUi = createCanvasPageUiStore();
            let uploadHook!: ReturnType<typeof useCanvasUpload>;
            function Harness() {
                uploadHook = useCanvasUpload({
                    pageUi, canvasId: "canvas-import-script", nodesRef, connectionsRef, selectedNodeIdsRef,
                    getCanvasCenter: () => ({ x: 0, y: 0 }), screenToCanvas: (x, y) => ({ x, y }),
                    setNodes: (v) => { nodesRef.current = typeof v === "function" ? v(nodesRef.current) : v; },
                    setConnections: (v) => { connectionsRef.current = typeof v === "function" ? v(connectionsRef.current) : v; },
                    onCancelNodeGeneration: (nodeId) => { canceledIds.push(nodeId); },
                });
                return null;
            }
            renderToStaticMarkup(
                <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                    <App><Harness /></App>
                </QueryClientProvider>,
            );

            uploadHook.handleUploadRequest("node-url-copy");
            expect(await uploadHook.handleImportUrl("https://cdn.example.test/same.png", "image")).toBe(true);
            expect(await uploadHook.replaceNodeMedia("node-script-1", new File(["# 新场次\n雨夜追逐"], "scene1.md", { type: "text/markdown" }))).toBe(true);
            expect(canceledIds).toEqual(["node-url-copy", "node-script-1"]);

            const replacedUrlNode = nodesRef.current.find((n) => n.id === "node-url-copy")!;
            const replacedScript = nodesRef.current.find((n) => n.id === "node-script-1")!;
            expect(replacedUrlNode.metadata?.resultOrigin).toBe("imported");
            expect(replacedUrlNode.metadata?.fileUploadAttemptId).toBeTruthy();
            expect(replacedUrlNode.metadata?.fileUploadAttemptId).not.toBe("att-old-import");
            expect(replacedUrlNode.metadata?.taskId).toBeUndefined();
            expect(replacedScript.metadata?.resultOrigin).toBe("upload");
            expect(replacedScript.metadata?.fileUploadAttemptId).toBeTruthy();
            expect(replacedScript.metadata?.taskId).toBeUndefined();

            const snap = (nodes: CanvasNodeData[], rev: number) => ({
                id: "canvas-import-script", name: "Rebase Guard", nodes, connections: [],
                viewport: { x: 0, y: 0, zoom: 1 }, revision: rev, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
            });
            const remoteInPlaceGen: CanvasNodeData = {
                ...baseImportedCopy,
                metadata: { copiedFromNodeId: "src-1", content: "https://cdn.example.test/gen-override.png", status: "success", nodeRole: "result", resultOrigin: "generated", taskId: "task-gen-2" },
            };
            const remoteFailedScript: CanvasNodeData = {
                ...baseScriptNode,
                metadata: { composerContent: "# 旧场次", status: "error", taskId: "task-scr-old", taskStatus: "failed", generationErrorCode: "upstream_failed" },
            };
            const rebased = rebaseCanvasDocumentThreeWay({
                base: snap([baseImportedCopy, baseScriptNode], 1),
                local: snap([replacedUrlNode, replacedScript], 1),
                remote: snap([remoteInPlaceGen, remoteFailedScript], 2),
            });
            expect(rebased.conflict).toBe(true);
            const mergedUrl = rebased.project.nodes.find((n) => n.id === "node-url-copy")!;
            const mergedScript = rebased.project.nodes.find((n) => n.id === "node-script-1")!;
            expect(mergedUrl.metadata?.content).toBe("https://cdn.example.test/same.png");
            expect(mergedUrl.metadata?.resultOrigin).toBe("imported");
            expect(mergedUrl.metadata?.fileUploadAttemptId).toBe(replacedUrlNode.metadata?.fileUploadAttemptId);
            expect(mergedUrl.metadata?.taskId).toBeUndefined();
            expect(mergedScript.title).toBe("scene1");
            expect(mergedScript.metadata?.composerContent).toBe("# 新场次\n雨夜追逐");
            expect(mergedScript.metadata?.resultOrigin).toBe("upload");
            expect(mergedScript.metadata?.fileUploadAttemptId).toBe(replacedScript.metadata?.fileUploadAttemptId);
            expect(mergedScript.metadata?.taskId).toBeUndefined();
        } finally {
            ensureMock.mockRestore();
        }
    });
});
