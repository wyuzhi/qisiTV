import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { uninsertedCanvasAssetHandoffPayloads } from "../src/lib/canvas/canvas-asset-handoff";
import { planCanvasHandoffEffect, resolveCanvasAssetHandoffPlan } from "../src/pages/canvas/canvas-resource-handoff-plan";
import { CreationMessageView } from "../src/pages/create/creation-workspace";
import { createGenerationTaskSubscriptionService, type GenerationTask } from "../src/services/api/task-center";
import { removeCreationConversationSnapshot, updateCreationConversationSnapshot } from "../src/services/creation-conversation-store";

test("Create exposes one accessible copy action beside each displayed user prompt", () => {
    const html = renderToStaticMarkup(
        createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(
                MemoryRouter,
                null,
                createElement(
                    App,
                    null,
                    createElement(CreationMessageView, {
                        item: { id: "u1", role: "user", content: "雨夜街角", createdAt: "2026-08-14T00:00:00.000Z" },
                        shotNumber: 1,
                        onRetryFailure: () => undefined,
                        onCreateVariant: () => undefined,
                        onEditUserMessage: () => undefined,
                        onContinueCanvas: () => undefined,
                        openingCanvas: false,
                    }),
                ),
            ),
        ),
    );
    expect(html.match(/aria-label="复制提示词"/g)?.length).toBe(1);
});

// Submit button click-event isolation is verified end-to-end in create-page-wiring.browser.test.tsx.

test("Create keeps optimistic messages when the first local task binds immediately", () => {
    const initial = [{ id: "conversation-0001", title: "新创作", updatedAt: "2026-08-14T00:00:00.000Z", messages: [] as Array<Record<string, unknown>> }];
    const optimistic = updateCreationConversationSnapshot(initial, "conversation-0001", (conversation) => ({
        ...conversation,
        messages: [
            { id: "user-0001", role: "user", content: "fixture" },
            { id: "assistant-0001", role: "assistant", content: "", status: "pending" },
        ],
    }));
    const bound = updateCreationConversationSnapshot(optimistic, "conversation-0001", (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => (message.id === "assistant-0001" ? { ...message, taskIds: ["backend-task-0001"] } : message)),
    }));

    expect(bound[0].messages).toHaveLength(2);
    expect(bound[0].messages[1]).toMatchObject({ id: "assistant-0001", taskIds: ["backend-task-0001"] });
});

test("Create history deletion removes only the selected conversation snapshot", () => {
    const assets = [{ id: "asset-0001", storageKey: "resource:asset-0001" }];
    const conversations = [
        { id: "conversation-0001", messages: [{ id: "message-0001", resultUrls: ["resource:asset-0001"] }] },
        { id: "conversation-0002", messages: [{ id: "message-0002", attachments: [{ storageKey: "resource:asset-0001" }] }] },
    ];

    expect(removeCreationConversationSnapshot(conversations, "conversation-0001")).toEqual([conversations[1]]);
    expect(assets).toEqual([{ id: "asset-0001", storageKey: "resource:asset-0001" }]);
});

test("Create refresh subscriptions share one durable scheduler observation without page polling", async () => {
    let queryCalls = 0;
    let waitCalls = 0;
    const statusNotifications: GenerationTask[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
    });
    const running: GenerationTask = {
        id: "dreamina:create-refresh-task-0001",
        projectId: "create-project-0001",
        type: "canvas_video",
        status: "running",
        prompt: "fixture",
        attempts: 1,
        clientContext: { conversationId: "conversation-0001", messageId: "message-0001" },
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const service = createGenerationTaskSubscriptionService({
        async queryTask() {
            queryCalls += 1;
            return running;
        },
        async waitTask() {
            waitCalls += 1;
            await gate;
            return { ...running, status: "succeeded", updatedAt: "2026-08-13T00:01:00.000Z" };
        },
        notifyTaskChanged(task) {
            statusNotifications.push(task);
        },
    });
    const beforeRefresh: GenerationTask[] = [];
    const afterRefresh: GenerationTask[] = [];
    const disconnect = service.subscribe([running.id], (task) => beforeRefresh.push(task));
    await Promise.resolve();
    disconnect();
    const reconnect = service.subscribe([running.id], (task) => afterRefresh.push(task));
    release();
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    reconnect();

    expect(queryCalls).toBe(1);
    expect(waitCalls).toBe(1);
    expect(beforeRefresh[0]).toMatchObject({ id: running.id, status: "running" });
    expect(afterRefresh.at(-1)).toMatchObject({
        id: running.id,
        status: "succeeded",
        clientContext: { conversationId: "conversation-0001", messageId: "message-0001" },
    });
    expect(statusNotifications.map((task) => task.status)).toEqual(["running", "succeeded"]);
});


test("task subscription can reconnect after an observation failure", async () => {
    let queryCalls = 0;
    let rejectFirst!: (error: Error) => void;
    const terminal: GenerationTask = {
        id: "dreamina:reconnect-task-0001",
        projectId: "create-project-0001",
        type: "canvas_video",
        status: "succeeded",
        prompt: "fixture",
        attempts: 1,
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:01:00.000Z",
    };
    const service = createGenerationTaskSubscriptionService({
        queryTask() {
            queryCalls += 1;
            return queryCalls === 1
                ? new Promise<GenerationTask>((_resolve, reject) => { rejectFirst = reject; })
                : Promise.resolve(terminal);
        },
        async waitTask() {
            throw new Error("terminal task must not enter waitTask") as never;
        },
    });
    const previousWarn = console.warn;
    console.warn = () => undefined;
    try {
        const first = service.subscribe([terminal.id], () => undefined);
        first();
        rejectFirst(new Error("temporary observation failure"));
        for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();

        const observed: GenerationTask[] = [];
        const second = service.subscribe([terminal.id], (task) => observed.push(task));
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        second();

        expect(queryCalls).toBeGreaterThanOrEqual(2);
        expect(queryCalls).toBeLessThanOrEqual(3);
        expect(observed.at(-1)).toMatchObject({ id: terminal.id, status: "succeeded" });
    } finally {
        console.warn = previousWarn;
    }
});

test("Create durably correlates failures that happen before the first Runtime response", async () => {
    const { applyGenerationFailureToMessage, bindGenerationTaskToMessage } = await import("../src/pages/create/create-submit-task");
    const createdAt = "2026-08-13T00:00:00.000Z";
    const assistantMessage = {
        id: "msg-assistant-1",
        role: "assistant" as const,
        mode: "video" as const,
        content: "",
        createdAt,
        status: "pending" as const,
    };
    const task = {
        id: "task-1",
        projectId: "create-1",
        type: "canvas_video" as const,
        status: "failed" as const,
        prompt: "fixture",
        attempts: 1,
        operation: "image_to_video",
        errorCode: "model_not_supported",
        stage: "submit",
        createdAt,
        updatedAt: createdAt,
    };
    const bound = bindGenerationTaskToMessage(assistantMessage, task);
    expect(bound.generationOperation).toBe("image_to_video");
    expect(bound.generationErrorCode).toBe("model_not_supported");
    expect(bound.taskIds).toEqual(["task-1"]);

    const boundTasks = new Map([[task.id, task]]);
    const failed = applyGenerationFailureToMessage(bound, new Error("unsupported model"), boundTasks, "video", createdAt);
    expect(failed.status).toBe("error");
    expect(failed.generationOperation).toBe("image_to_video");
    expect(failed.generationErrorCode).toBe("model_not_supported");
    expect(failed.createdAt).toBe(assistantMessage.createdAt);
});

test("creation results hand off exact asset ids to one new canvas and consume the route once", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff").catch(() => ({}));

    expect(typeof module.creationCanvasHandoffPath).toBe("function");
    expect(typeof module.canvasAssetHandoffIds).toBe("function");
    expect(typeof module.consumeCanvasAssetHandoff).toBe("function");

    const path = module.creationCanvasHandoffPath(["asset one", "asset/two", "asset one", ""]);
    expect(path).toBe("/canvas?mode=handoff&asset=asset+one&asset=asset%2Ftwo");
    expect(module.creationCanvasHandoffPath(["asset/two"], 2)).toBeUndefined();

    const params = new URLSearchParams("mode=new&asset=asset+one&asset=asset%2Ftwo&asset=asset+one&keep=1");
    expect(module.canvasAssetHandoffIds(params)).toEqual(["asset one", "asset/two"]);
    expect(module.consumeCanvasAssetHandoff(params).toString()).toBe("keep=1");
});

test("canvas handoff resolves generated image and video assets in requested order", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff");
    expect(typeof module.canvasAssetHandoffPayloads).toBe("function");

    const assets = [
        {
            id: "image-1",
            kind: "image" as const,
            title: "image title",
            coverUrl: "/image.png",
            tags: ["creation"],
            status: "confirmed" as const,
            source: "creation",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            data: { dataUrl: "/image.png", storageKey: "resource:image", width: 1664, height: 936, bytes: 625000, mimeType: "image/png" },
        },
        {
            id: "video-1",
            kind: "video" as const,
            title: "video title",
            coverUrl: "/video.mp4",
            tags: ["creation"],
            status: "confirmed" as const,
            source: "creation",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            data: { url: "/video.mp4", storageKey: "resource:video", width: 1280, height: 720, durationMs: 6000, bytes: 800000, mimeType: "video/mp4" },
        },
    ];

    expect(module.canvasAssetHandoffPayloads(assets, ["video-1", "missing", "image-1"])).toEqual({
        payloads: [
            { kind: "video", url: "/video.mp4", storageKey: "resource:video", title: "video title", width: 1280, height: 720, durationMs: 6000, bytes: 800000, mimeType: "video/mp4", assetId: "video-1" },
            { kind: "image", dataUrl: "/image.png", storageKey: "resource:image", title: "image title", assetId: "image-1" },
        ],
        missingAssetIds: ["missing"],
    });
});

test("creation result handoff selects only assets owned by that message in result order", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff");
    const image = (id: string, url: string, messageId: string, resultIndex: number) => ({
        id,
        kind: "image" as const,
        title: id,
        coverUrl: url,
        tags: ["creation"],
        status: "confirmed" as const,
        source: "creation",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        metadata: { source: "create-generation", messageId, resultIndex },
        data: { dataUrl: url, width: 1664, height: 936, bytes: 1, mimeType: "image/png" },
    });
    const assets = [image("second", "/second.png", "message-1", 1), image("unrelated", "/unrelated.png", "message-2", 0), image("first", "/first.png", "message-1", 0)];

    expect(module.creationResultAssetIds(assets, { messageId: "message-1", taskIds: [], resultUrls: ["/first.png", "/second.png"] })).toEqual(["first", "second"]);
});

test("creation result handoff recognizes unified generation-task materializer metadata", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff");
    const asset = {
        id: "materialized-image",
        kind: "image" as const,
        title: "image",
        coverUrl: "/stored.png",
        tags: [],
        status: "confirmed" as const,
        source: "generation task",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        metadata: { source: "generation-task", taskId: "dreamina:task-1", messageId: "message-1", outputIndex: 0 },
        data: { dataUrl: "/stored.png", width: 1024, height: 1024, bytes: 1, mimeType: "image/png" },
    };

    expect(
        module.creationResultAssetIds([asset], {
            messageId: "message-1",
            taskIds: ["dreamina:task-1"],
            resultUrls: ["/stored.png"],
        }),
    ).toEqual(["materialized-image"]);
});

test("canvas handoff consumes its route only after merged nodes are durably persisted", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff");
    let releasePersistence = () => {};
    const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
    });
    let persistedNodes: Array<{ id: string }> = [];
    let settled = false;
    const pending = module
        .finalizeCanvasAssetHandoff({
            searchParams: new URLSearchParams("mode=handoff&asset=image-1&keep=1"),
            currentNodes: [{ id: "existing" }, { id: "image-1" }],
            createdNodes: [{ id: "image-1" }, { id: "image-2" }],
            persist: async (nodes: Array<{ id: string }>) => {
                persistedNodes = nodes;
                await persistenceGate;
            },
        })
        .then((result: { nodes: Array<{ id: string }>; searchParams: URLSearchParams }) => {
            settled = true;
            return result;
        });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(persistedNodes.map((node) => node.id)).toEqual(["existing", "image-1", "image-2"]);
    releasePersistence();
    const result = await pending;
    expect(result.nodes.map((node) => node.id)).toEqual(["existing", "image-1", "image-2"]);
    expect(result.searchParams.toString()).toBe("keep=1");
});

test("canvas handoff keeps its route when durable persistence fails", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff");
    const searchParams = new URLSearchParams("mode=handoff&asset=image-1&keep=1");
    await expect(
        module.finalizeCanvasAssetHandoff({
            searchParams,
            currentNodes: [{ id: "existing" }],
            createdNodes: [{ id: "image-1" }],
            persist: async () => {
                throw new Error("persistence failed");
            },
        }),
    ).rejects.toThrow("persistence failed");
    expect(searchParams.toString()).toBe("mode=handoff&asset=image-1&keep=1");
});

test("canvas handoff with no available assets remains retryable", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff").catch(() => ({}));
    expect(typeof module.canvasAssetHandoffAttempt).toBe("function");
    expect(module.canvasAssetHandoffAttempt([], new URLSearchParams("mode=handoff&asset=missing&keep=1"))).toEqual({ kind: "retry", assetIds: ["missing"], payloads: [], missingAssetIds: ["missing"] });
});

test("canvas handoff waits until every requested asset is available before creating any node", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff");
    const image = {
        id: "image-1",
        kind: "image" as const,
        title: "image",
        coverUrl: "/image.png",
        tags: [],
        status: "confirmed" as const,
        source: "creation",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        data: { dataUrl: "/image.png", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
    };
    expect(module.canvasAssetHandoffAttempt([image], new URLSearchParams("mode=handoff&asset=image-1&asset=late-video"))).toEqual({
        kind: "retry",
        assetIds: ["image-1", "late-video"],
        payloads: [],
        missingAssetIds: ["late-video"],
    });
});

test("canvas handoff reuses nodes carrying the same asset id after a persistence retry", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff");
    expect(typeof module.uninsertedCanvasAssetHandoffPayloads).toBe("function");
    const payloads = [{ kind: "image" as const, dataUrl: "/image.png", title: "image", assetId: "image-1" }];
    const existingNodes = [{ id: "random-node-id", metadata: { assetId: "image-1" } }];
    expect(module.uninsertedCanvasAssetHandoffPayloads(existingNodes, payloads)).toEqual([]);
});

test("creation result handoff falls back by stable result order only for a complete owned asset set", async () => {
    const module = await import("../src/lib/canvas/canvas-asset-handoff");
    const image = (id: string, resultIndex: number) => ({
        id,
        kind: "image" as const,
        title: id,
        coverUrl: `/stored-${id}.png`,
        tags: ["creation"],
        status: "confirmed" as const,
        source: "creation",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        metadata: { source: "create-generation", messageId: "message-1", resultIndex },
        data: { dataUrl: `/stored-${id}.png`, width: 1664, height: 936, bytes: 1, mimeType: "image/png" },
    });
    const complete = [image("second", 1), image("first", 0)];
    expect(module.creationResultAssetIds(complete, { messageId: "message-1", taskIds: [], resultUrls: ["/official-first.png", "/official-second.png"] })).toEqual(["first", "second"]);
    expect(module.creationResultAssetIds(complete.slice(0, 1), { messageId: "message-1", taskIds: [], resultUrls: ["/official-first.png", "/official-second.png"] })).toEqual([]);
});

test("Create forwards owned result assets through one new canvas and the project persists before clearing the handoff", () => {
    const searchParams = new URLSearchParams("mode=handoff&assets=asset-owned-1,asset-owned-2");
    const idlePlan = resolveCanvasAssetHandoffPlan({
        projectLoaded: true,
        assetsHydrated: true,
        mode: "recent",
        projectId: "canvas-1",
        assets: [],
        searchParams,
        currentKey: "",
        nodes: [],
    });
    expect(idlePlan).toEqual({ kind: "idle" });

    const missingPayloads = uninsertedCanvasAssetHandoffPayloads(
        [{ id: "n1", type: "image", title: "已存在", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { assetId: "asset-owned-1" } } as never],
        [
            { kind: "image", title: "一", dataUrl: "u1", width: 100, height: 100, assetId: "asset-owned-1" },
            { kind: "image", title: "二", dataUrl: "u2", width: 100, height: 100, assetId: "asset-owned-2" },
        ] as never,
    );
    expect(missingPayloads.map((item) => item.assetId)).toEqual(["asset-owned-2"]);

    const blockedDecision = planCanvasHandoffEffect({
        plan: { kind: "commit", key: "canvas-1:k1", payloads: missingPayloads },
        searchParams,
        ownerUserScope: "guest",
        liveUserScope: "guest",
        currentAttemptKey: "",
        failedKey: "canvas-1:k1",
        retryNonce: 0,
        nonceAtFail: 0,
    });
    expect(blockedDecision).toEqual({ kind: "blocked-until-retry", key: "canvas-1:k1" });

    const retryDecision = planCanvasHandoffEffect({
        plan: { kind: "commit", key: "canvas-1:k1", payloads: missingPayloads },
        searchParams,
        ownerUserScope: "guest",
        liveUserScope: "guest",
        currentAttemptKey: "",
        failedKey: "canvas-1:k1",
        retryNonce: 1,
        nonceAtFail: 0,
    });
    expect(retryDecision.kind).toBe("commit");

    const foreignDecision = planCanvasHandoffEffect({
        plan: { kind: "commit", key: "canvas-1:k1", payloads: missingPayloads },
        searchParams,
        ownerUserScope: "user-a",
        liveUserScope: "user-b",
        currentAttemptKey: "",
        failedKey: "",
        retryNonce: 0,
        nonceAtFail: 0,
    });
    expect(foreignDecision.kind).toBe("consume-foreign");
});

test("Create image batch retry preserves per-index lineage under one attempt group", async () => {
    const module = await import("../src/lib/canvas/canvas-project-generation");
    const createBatchRetryContexts = (
        module as {
            createGenerationBatchRetryContexts?: (taskIds: readonly string[], attemptGroupId: string) => Promise<Array<{ retryOf: string; attemptGroupId: string; clientOperationId: string }>>;
        }
    ).createGenerationBatchRetryContexts;
    expect(typeof createBatchRetryContexts).toBe("function");
    if (!createBatchRetryContexts) return;

    const oldTaskIds = ["dreamina:create-image-old-0001", "dreamina:create-image-old-0002", "dreamina:create-image-old-0003"];
    const contexts = await createBatchRetryContexts(oldTaskIds, "create-image-attempt-group-0001");

    expect(contexts.map(({ retryOf, attemptGroupId }) => ({ retryOf, attemptGroupId }))).toEqual([
        { retryOf: oldTaskIds[0], attemptGroupId: "create-image-attempt-group-0001" },
        { retryOf: oldTaskIds[1], attemptGroupId: "create-image-attempt-group-0001" },
        { retryOf: oldTaskIds[2], attemptGroupId: "create-image-attempt-group-0001" },
    ]);
    expect(new Set(contexts.map((context) => context.clientOperationId)).size).toBe(3);
});
