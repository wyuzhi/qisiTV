import { beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeGenerationProgress } from "@/components/canvas/canvas-node-generation-progress";
import { canvasThemes } from "@/lib/canvas-theme";
import { getCanvasGenerationTasks } from "@/lib/canvas/canvas-context-discovery";
import { depthCaptureTaskMetadata } from "@/lib/canvas/canvas-depth-capture";
import { recoverOwnedDepthCaptureNode } from "@/lib/canvas/canvas-depth-recover";
import { rebaseCanvasDocumentThreeWay } from "@/lib/canvas/canvas-document-rebase";
import { mergeCanvasRefreshPatch } from "@/lib/canvas/canvas-patch-merge";
import { verifyCanvasOperations } from "@/lib/canvas/canvas-operation-contract";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { GENERATION_RESULT_FETCH_STAGE } from "@/lib/generation-delivery-progress";
import { normalizeGenerationTaskProgress } from "@/lib/canvas/canvas-node-metadata-contract";
import { localTaskHistoryFromProjects } from "@/lib/local-task-history";
import { beginLocalExecutorSession } from "@/lib/plugins/builtin/editor/local-executor-session";
import { canvasGenerationTaskNodes } from "@/pages/canvas/canvas-generation-failure";
import { http } from "@/services/api/request";
import { queryGenerationTask, recoverTask, type GenerationTask } from "@/services/api/task-center";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import {
    publishGenerationTaskTelemetry,
    readGenerationTaskTelemetry,
    resetGenerationTaskTelemetryStore,
    useGenerationTaskTelemetry,
} from "@/stores/use-generation-task-telemetry";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function makeNode(id: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Video,
        title: "镜头 1",
        position: { x: 120, y: 180 },
        width: 480,
        height: 270,
        metadata,
    };
}

function makeProject(nodes: CanvasNodeData[], revision = 1): CanvasProject {
    return {
        id: "canvas-telemetry-test",
        title: "遥测隔离测试",
        nodes,
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
        revision,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
    };
}

describe("useGenerationTaskTelemetry", () => {
    beforeEach(() => {
        resetGenerationTaskTelemetryStore();
    });

    test("keeps 10 consecutive running poll ticks in memory with zero canvas node array mutations", () => {
        const observedProgress: Array<number | undefined> = [];
        const unsubscribe = useGenerationTaskTelemetry.subscribe((state) => {
            observedProgress.push(state.byTask["task-live-video"]?.progress);
        });

        try {
            // Queued tasks without explicit progress normalize to 0 consistently.
            publishGenerationTaskTelemetry({
                id: "task-queued-check",
                status: "queued",
                stage: "queued",
                updatedAt: "2026-06-01T10:00:00.500Z",
            });
            expect(readGenerationTaskTelemetry("task-queued-check")?.progress).toBe(0);

            const baseTask: GenerationTask = {
                id: "task-live-video",
                type: "canvas_video",
                status: "running",
                stage: "queued",
                progress: 5,
                prompt: "雨夜霓虹街道推进镜头",
                provider: "managed",
                attempts: 1,
                createdAt: "2026-06-01T10:00:00.000Z",
                updatedAt: "2026-06-01T10:00:01.000Z",
            };

            const initialNode = makeNode("video-1", {
                status: "loading",
                taskStage: "正在提交生成任务",
                taskProgress: 0,
                prompt: baseTask.prompt,
            });
            const acceptedNodes = canvasGenerationTaskNodes([initialNode], "video-1", baseTask);
            expect(acceptedNodes).toHaveLength(1);
            expect(acceptedNodes[0]?.metadata?.taskId).toBe("task-live-video");
            expect(acceptedNodes[0]?.metadata?.taskStatus).toBe("running");
            expect(acceptedNodes[0]?.metadata?.taskProgress).toBeUndefined();
            expect(acceptedNodes[0]?.metadata?.taskStage).toBeUndefined();
            expect(acceptedNodes[0]?.metadata?.taskUpdatedAt).toBeUndefined();
            expect(acceptedNodes[0]?.metadata?.taskProviderRequestId).toBeUndefined();

            let currentNodes = acceptedNodes;
            for (let step = 1; step <= 10; step += 1) {
                const pct = step * 9;
                const stage = step < 4 ? "generating" : "rendering";
                const polled: GenerationTask = {
                    ...baseTask,
                    progress: pct,
                    stage,
                    startedAt: "2026-06-01T10:00:01.500Z",
                    updatedAt: `2026-06-01T10:00:${String(step + 1).padStart(2, "0")}.000Z`,
                    providerRequestId: `req-${step}`,
                    officialStatus: "processing",
                    receiptRecorded: true,
                };
                const nextNodes = canvasGenerationTaskNodes(currentNodes, "video-1", polled);
                expect(nextNodes).toBe(currentNodes);
                currentNodes = nextNodes;
            }

            expect(observedProgress).toContain(90);
            const live = readGenerationTaskTelemetry("task-live-video");
            expect(live).toEqual({
                status: "running",
                progress: 90,
                stage: "rendering",
                startedAt: "2026-06-01T10:00:01.500Z",
                updatedAt: "2026-06-01T10:00:11.000Z",
                durationMs: undefined,
                providerRequestId: "req-10",
                officialStatus: "processing",
                receiptRecorded: true,
            });

            // Context discovery, operation verification, and local task history read live telemetry while node is loading.
            const snapshot = {
                projectId: "canvas-telemetry-test",
                title: "遥测隔离测试",
                nodes: currentNodes,
                connections: [],
                selectedNodeIds: [],
                viewport: { x: 0, y: 0, k: 1 },
            };
            const discovered = getCanvasGenerationTasks(snapshot, {});
            expect(discovered.tasks[0]?.progress).toBe(90);
            expect(discovered.tasks[0]?.stage).toBe("rendering");
            expect(discovered.tasks[0]?.officialStatus).toBe("processing");

            const verified = verifyCanvasOperations(
                { ...snapshot, nodes: [makeNode("video-1", { status: "idle" })] },
                snapshot,
                [{ type: "run_generation", nodeId: "video-1", mode: "video" }],
            );
            expect(verified.ok).toBe(true);
            expect(verified.generation[0]?.officialStatus).toBe("processing");

            const history = localTaskHistoryFromProjects([makeProject(currentNodes)]);
            expect(history[0]?.progress).toBe(90);
            expect(history[0]?.stage).toBe("rendering");
        } finally {
            unsubscribe();
        }
    });

    test("node-card 继续取回 (recoverTask) clears stale telemetry and never overrides settled succeeded metadata", async () => {
        const originalGet = http.get;
        const originalPost = http.post;
        const taskId = "task-recover-video";

        http.get = (async () => ({
            id: taskId,
            type: "canvas_video",
            status: "failed",
            stage: "生成失败",
            progress: 40,
            prompt: "雨夜追逐镜头",
            outcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
            attempts: 1,
            createdAt: "2026-06-01T10:00:00.000Z",
            updatedAt: "2026-06-01T10:00:10.000Z",
        } as GenerationTask)) as typeof http.get;

        http.post = (async () => ({
            id: taskId,
            type: "canvas_video",
            status: "succeeded",
            stage: "completed",
            progress: 100,
            prompt: "雨夜追逐镜头",
            outcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            attempts: 1,
            startedAt: "2026-06-01T10:00:01.000Z",
            completedAt: "2026-06-01T10:00:25.000Z",
            createdAt: "2026-06-01T10:00:00.000Z",
            updatedAt: "2026-06-01T10:00:25.000Z",
        } as GenerationTask)) as typeof http.post;

        try {
            // Prior active running telemetry existed before failure/recovery.
            publishGenerationTaskTelemetry({
                id: taskId,
                status: "running",
                progress: 40,
                stage: "generating",
                updatedAt: "2026-06-01T10:00:09.000Z",
            });
            expect(readGenerationTaskTelemetry(taskId)?.progress).toBe(40);

            const queried = await queryGenerationTask(taskId);
            expect(queried.status).toBe("failed");
            expect(readGenerationTaskTelemetry(taskId)).toBeUndefined();

            // Even if running telemetry appeared mid-recovery, recoverTask's succeeded transition clears it.
            publishGenerationTaskTelemetry({
                id: taskId,
                status: "running",
                progress: 65,
                stage: "rendering",
                updatedAt: "2026-06-01T10:00:15.000Z",
            });
            const recovered = await recoverTask(taskId);
            expect(recovered.status).toBe("succeeded");
            expect(readGenerationTaskTelemetry(taskId)).toBeUndefined();

            // Even if an unrelated live poll injected telemetry for the same taskId, settled success nodes ignore it.
            publishGenerationTaskTelemetry({
                id: taskId,
                status: "running",
                progress: 40,
                stage: "stale-running",
                updatedAt: "2026-06-01T10:00:16.000Z",
            });

            const boundNode = makeNode("video-recovered", {
                status: "success",
                taskId,
                taskType: "canvas_video",
                taskStatus: "succeeded",
                taskProgress: 100,
                taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
                prompt: "雨夜追逐镜头",
                content: "blob:recovered-video",
                storageKey: "resource:res-video-1",
                assetId: "generation_asset_1",
                taskCreatedAt: "2026-06-01T10:00:00.000Z",
                taskCompletedAt: "2026-06-01T10:00:25.000Z",
                taskUpdatedAt: "2026-06-01T10:00:25.000Z",
            });

            const discovered = getCanvasGenerationTasks(
                {
                    projectId: "canvas-telemetry-test",
                    title: "遥测隔离测试",
                    nodes: [boundNode],
                    connections: [],
                    selectedNodeIds: [],
                    viewport: { x: 0, y: 0, k: 1 },
                },
                {},
            );
            expect(discovered.tasks[0]?.status).toBe("succeeded");
            expect(discovered.tasks[0]?.progress).toBe(100);
            expect(discovered.tasks[0]?.stage).toBeUndefined();

            const history = localTaskHistoryFromProjects([makeProject([boundNode])]);
            expect(history[0]?.status).toBe("succeeded");
            expect(history[0]?.progress).toBe(100);
            expect(history[0]?.stage).toBeUndefined();
        } finally {
            http.get = originalGet;
            http.post = originalPost;
        }
    });

    test("depth recovery preserves node and array reference identity across unchanged running polls", async () => {
        const taskId = "task-depth-live";
        const initialTask: GenerationTask = {
            id: taskId,
            type: "depth_capture",
            status: "running",
            stage: "extracting",
            progress: 10,
            prompt: "深度捕捉",
            attempts: 1,
            createdAt: "2026-06-01T10:00:00.000Z",
            updatedAt: "2026-06-01T10:00:01.000Z",
        };
        const depthNode = makeNode("depth-1", {
            status: "loading",
            depthSourceNodeId: "source-video",
            ...depthCaptureTaskMetadata(initialTask),
        });
        const initialArray = [depthNode];
        const nodesRef = { current: initialArray };
        let stateNodes = initialArray;
        const setNodes = (updater: (current: CanvasNodeData[]) => CanvasNodeData[]) => {
            stateNodes = updater(stateNodes);
        };
        const controller = new AbortController();
        const session = beginLocalExecutorSession("canvas-telemetry-test", {
            controller,
            getLiveProjectId: () => "canvas-telemetry-test",
        });

        let boundCount = 0;
        await recoverOwnedDepthCaptureNode(
            { node: depthNode, session, nodesRef, setNodes },
            async () => {
                boundCount += 1;
            },
            async (_id, _session, options) => {
                for (let tick = 1; tick <= 5; tick += 1) {
                    options?.onTaskUpdate?.({
                        ...initialTask,
                        progress: tick * 18,
                        stage: tick < 3 ? "extracting" : "encoding",
                        updatedAt: `2026-06-01T10:00:0${tick + 1}.000Z`,
                    });
                    expect(nodesRef.current).toBe(initialArray);
                    expect(stateNodes).toBe(initialArray);
                    expect(nodesRef.current[0]).toBe(depthNode);
                }
                expect(readGenerationTaskTelemetry(taskId)?.progress).toBe(90);
                expect(readGenerationTaskTelemetry(taskId)?.stage).toBe("encoding");
                return {
                    ...initialTask,
                    status: "succeeded",
                    progress: 100,
                    stage: "completed",
                    completedAt: "2026-06-01T10:00:10.000Z",
                    updatedAt: "2026-06-01T10:00:10.000Z",
                };
            },
        );
        expect(boundCount).toBe(1);
    });

    test("concurrent user edits during active generation rebase cleanly while settled fetching metadata is preserved", () => {
        const acceptedNode = canvasGenerationTaskNodes(
            [makeNode("video-1", { status: "loading", prompt: "原提示词" })],
            "video-1",
            {
                id: "task-active",
                type: "canvas_video",
                status: "running",
                stage: "generating",
                progress: 15,
                prompt: "原提示词",
                attempts: 1,
                createdAt: "2026-06-01T10:00:00.000Z",
                updatedAt: "2026-06-01T10:00:02.000Z",
            },
        )[0]!;
        const fetchingNode = canvasGenerationTaskNodes(
            [makeNode("video-fetching", { status: "loading", prompt: "下载中镜头" })],
            "video-fetching",
            {
                id: "task-fetching",
                type: "canvas_video",
                status: "running",
                stage: GENERATION_RESULT_FETCH_STAGE,
                progress: 98,
                outcome: { phase: "fetching", regenerate: "blocked", reason: "result_fetching" },
                providerRequestId: "prov-fetch-1",
                startedAt: "2026-06-01T10:00:01.000Z",
                prompt: "下载中镜头",
                attempts: 1,
                createdAt: "2026-06-01T10:00:00.000Z",
                updatedAt: "2026-06-01T10:00:18.000Z",
            },
        )[0]!;
        const sibling = makeNode("video-2", { status: "idle", prompt: "镜头 2" });

        expect(fetchingNode.metadata?.taskStage).toBe(GENERATION_RESULT_FETCH_STAGE);
        expect(fetchingNode.metadata?.taskProviderRequestId).toBe("prov-fetch-1");

        publishGenerationTaskTelemetry({
            id: "task-active",
            status: "running",
            progress: 72,
            stage: "rendering",
            updatedAt: "2026-06-01T10:00:20.000Z",
        });

        const base = makeProject([acceptedNode, fetchingNode, sibling], 5);
        const local = makeProject(
            [
                { ...acceptedNode, position: { x: 360, y: 220 } },
                { ...fetchingNode, position: { x: 520, y: 260 } },
                { ...sibling, title: "镜头 2（重命名）" },
            ],
            5,
        );
        const remote = makeProject(
            [
                acceptedNode,
                fetchingNode,
                { ...sibling, metadata: { ...sibling.metadata, prompt: "镜头 2 新提示词" } },
            ],
            6,
        );

        const rebased = rebaseCanvasDocumentThreeWay({ base, local, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.position).toEqual({ x: 360, y: 220 });
        expect(rebased.project.nodes[0]?.metadata?.taskProgress).toBeUndefined();
        expect(rebased.project.nodes[1]?.position).toEqual({ x: 520, y: 260 });
        expect(rebased.project.nodes[1]?.metadata?.taskStage).toBe(GENERATION_RESULT_FETCH_STAGE);
        expect(rebased.project.nodes[1]?.metadata?.taskProgress).toBe(98);
        expect(rebased.project.nodes[1]?.metadata?.taskProviderRequestId).toBe("prov-fetch-1");
        expect(rebased.project.nodes[1]?.metadata?.taskStartedAt).toBe("2026-06-01T10:00:01.000Z");
        expect(rebased.project.nodes[2]?.title).toBe("镜头 2（重命名）");
        expect(rebased.project.nodes[2]?.metadata?.prompt).toBe("镜头 2 新提示词");

        // Divergent fetching progress/timestamps across two tabs for the same task must not trigger a false conflict.
        const baseFetchNode = makeNode("v-diverge", {
            taskId: "t-fetch-same",
            status: "loading",
            taskStatus: "running",
            taskStage: GENERATION_RESULT_FETCH_STAGE,
            taskProgress: 50,
            taskStartedAt: "2026-06-01T10:00:01.000Z",
            taskProviderRequestId: "prov-diverge",
            taskUpdatedAt: "2026-06-01T10:00:03.000Z",
            prompt: "p",
        });
        const localFetchNode = {
            ...baseFetchNode,
            position: { x: 240, y: 80 },
            metadata: { ...baseFetchNode.metadata, taskProgress: 98, taskUpdatedAt: "2026-06-01T10:00:09.000Z" },
        };
        const remoteFetchNode = {
            ...baseFetchNode,
            metadata: { ...baseFetchNode.metadata, taskProgress: 90, taskUpdatedAt: "2026-06-01T10:00:08.000Z" },
        };
        const divergentFetchRebase = rebaseCanvasDocumentThreeWay({
            base: makeProject([baseFetchNode], 1),
            local: makeProject([localFetchNode], 1),
            remote: makeProject([remoteFetchNode], 2),
        });
        expect(divergentFetchRebase.conflict).toBe(false);
        expect(divergentFetchRebase.project.nodes[0]?.position).toEqual({ x: 240, y: 80 });
        expect(divergentFetchRebase.project.nodes[0]?.metadata?.taskProgress).toBe(98);
        expect(divergentFetchRebase.project.nodes[0]?.metadata?.taskStage).toBe(GENERATION_RESULT_FETCH_STAGE);
        expect(divergentFetchRebase.project.nodes[0]?.metadata?.taskUpdatedAt).toBe("2026-06-01T10:00:09.000Z");

        // Local settled fetching vs remote still generating (stripped), and vice versa, must both preserve settled fetching without conflict.
        const generatingSnapshot = makeNode("v-diverge", {
            taskId: "t-fetch-same",
            status: "loading",
            taskStatus: "running",
            taskStage: "generating",
            taskProgress: 35,
            taskUpdatedAt: "2026-06-01T10:00:02.000Z",
            prompt: "p",
        });
        const localFetchVsRemoteGen = rebaseCanvasDocumentThreeWay({
            base: makeProject([baseFetchNode], 1),
            local: makeProject([localFetchNode], 1),
            remote: makeProject([generatingSnapshot], 2),
        });
        expect(localFetchVsRemoteGen.conflict).toBe(false);
        expect(localFetchVsRemoteGen.project.nodes[0]?.metadata?.taskProgress).toBe(98);
        expect(localFetchVsRemoteGen.project.nodes[0]?.metadata?.taskStage).toBe(GENERATION_RESULT_FETCH_STAGE);

        const localGenVsRemoteFetch = rebaseCanvasDocumentThreeWay({
            base: makeProject([generatingSnapshot], 1),
            local: makeProject([{ ...generatingSnapshot, position: { x: 300, y: 120 } }], 1),
            remote: makeProject([remoteFetchNode], 2),
        });
        expect(localGenVsRemoteFetch.conflict).toBe(false);
        expect(localGenVsRemoteFetch.project.nodes[0]?.position).toEqual({ x: 300, y: 120 });
        expect(localGenVsRemoteFetch.project.nodes[0]?.metadata?.taskProgress).toBe(90);
        expect(localGenVsRemoteFetch.project.nodes[0]?.metadata?.taskStage).toBe(GENERATION_RESULT_FETCH_STAGE);
        expect(localGenVsRemoteFetch.project.nodes[0]?.metadata?.taskProviderRequestId).toBe("prov-diverge");

        // mergeCanvasRefreshPatch (local === base) must adopt newer remote settled progress, outcome, and providerRequestId.
        const refreshBaseNode = makeNode("v-refresh", {
            taskId: "t-refresh-same",
            status: "loading",
            taskStatus: "running",
            taskStage: GENERATION_RESULT_FETCH_STAGE,
            taskProgress: 50,
            taskUpdatedAt: "2026-06-01T10:00:03.000Z",
            prompt: "p",
        });
        const refreshIncomingNode = makeNode("v-refresh", {
            taskId: "t-refresh-same",
            status: "loading",
            taskStatus: "running",
            taskStage: GENERATION_RESULT_FETCH_STAGE,
            taskProgress: 90,
            taskUpdatedAt: "2026-06-01T10:00:09.000Z",
            taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
            taskProviderRequestId: "prov-remote",
            prompt: "p",
        });
        const refreshed = mergeCanvasRefreshPatch(
            makeProject([refreshBaseNode], 1),
            makeProject([refreshIncomingNode], 2),
            [refreshBaseNode],
            [],
        );
        expect(refreshed.nodes[0]?.metadata?.taskProgress).toBe(90);
        expect(refreshed.nodes[0]?.metadata?.taskUpdatedAt).toBe("2026-06-01T10:00:09.000Z");
        expect(refreshed.nodes[0]?.metadata?.taskOutcome).toEqual({
            phase: "retrievable",
            regenerate: "blocked",
            reason: "delivery_pending",
        });
        expect(refreshed.nodes[0]?.metadata?.taskProviderRequestId).toBe("prov-remote");

        // Local settled fetching that lacks taskOutcome/taskProviderRequestId must never delete remote's defined fields.
        const partialLocalSettled = {
            ...refreshBaseNode,
            position: { x: 180, y: 60 },
            metadata: {
                ...refreshBaseNode.metadata,
                taskProgress: 98,
                taskUpdatedAt: "2026-06-01T10:00:10.000Z",
                taskOutcome: { phase: "fetching" as const, regenerate: "blocked" as const, reason: "result_fetching" },
            },
        };
        const partialMerged = rebaseCanvasDocumentThreeWay({
            base: makeProject([refreshBaseNode], 1),
            local: makeProject([partialLocalSettled], 1),
            remote: makeProject([refreshIncomingNode], 2),
        });
        expect(partialMerged.conflict).toBe(false);
        expect(partialMerged.project.nodes[0]?.position).toEqual({ x: 180, y: 60 });
        expect(partialMerged.project.nodes[0]?.metadata?.taskProgress).toBe(98);
        expect(partialMerged.project.nodes[0]?.metadata?.taskProviderRequestId).toBe("prov-remote");
        expect(partialMerged.project.nodes[0]?.metadata?.taskOutcome).toEqual({
            phase: "retrievable",
            regenerate: "blocked",
            reason: "delivery_pending",
        });

        expect(normalizeGenerationTaskProgress(undefined, "queued")).toBe(0);
        expect(normalizeGenerationTaskProgress(undefined, "succeeded")).toBe(100);
        expect(normalizeGenerationTaskProgress(undefined, "running")).toBeUndefined();
    });

    test("settled succeeded and failed tasks persist providerRequestId and timing metadata while clearing live telemetry", () => {
        publishGenerationTaskTelemetry({
            id: "task-draft-done",
            status: "running",
            progress: 80,
            stage: "rendering",
            updatedAt: "2026-06-01T10:00:09.000Z",
        });
        expect(readGenerationTaskTelemetry("task-draft-done")?.progress).toBe(80);

        const succeededMeta = generationTaskMetadata({
            id: "task-draft-done",
            type: "canvas_video",
            status: "succeeded",
            stage: "completed",
            progress: 100,
            prompt: "草稿视频",
            providerRequestId: "prov-draft-99",
            startedAt: "2026-06-01T10:00:02.000Z",
            completedAt: "2026-06-01T10:00:12.000Z",
            attempts: 1,
            createdAt: "2026-06-01T10:00:00.000Z",
            updatedAt: "2026-06-01T10:00:12.000Z",
        });
        expect(readGenerationTaskTelemetry("task-draft-done")).toBeUndefined();
        expect(succeededMeta.taskProviderRequestId).toBe("prov-draft-99");
        expect(succeededMeta.taskProgress).toBe(100);
        expect(succeededMeta.taskDurationMs).toBe(10_000);
        expect(succeededMeta.taskCompletedAt).toBe("2026-06-01T10:00:12.000Z");

        const fixtureHtml = renderToStaticMarkup(
            createElement(CanvasNodeGenerationProgress, {
                node: makeNode("fixture-node", {
                    status: "loading",
                    fixture: "libtv-generating",
                    taskProgress: 42,
                    taskStage: "正在生成画面",
                }),
                theme: canvasThemes.dark,
            }),
        );
        expect(fixtureHtml).toContain("42%");
    });
});
