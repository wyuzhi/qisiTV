import { setActiveUserScope } from "@/lib/user-scope";
import { createModelChannel, defaultConfig, encodeChannelModel, useConfigStore } from "@/stores/use-config-store";
import { beginLocalCanvasProject } from "@/services/local-workspace-repository";
import { fetchChannelModels } from "@/services/api/image-models";
import { prepareBackendGenerationTask, runBackendGenerationTask } from "@/services/api/generation-task";
import { createGenerationTask, findGenerationTaskByOperation, recoverTask, waitForGenerationTask } from "@/services/api/task-center";
import { getImageBlob } from "@/services/image-storage";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import { bindBrowserCanvasGenerationResult } from "@/services/browser-canvas-generation-consumer";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";
import { useAssetStore } from "@/stores/use-asset-store";
import { syncGenerationTaskToCanvasStore } from "@/lib/canvas/canvas-generation-task-sync";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { http, ApiError } from "@/services/api/request";
import { runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { selectBrowserProjectRoot } from "@/services/browser-folder-workspace";
import { getProjectFolderState } from "@/services/browser-project-folder";
import { projectSyncProgress, useSyncProgressStore } from "@/stores/use-sync-progress-store";

let cancelledTask: Promise<string> | undefined;
let cancellation: AbortController | undefined;
let cancelledProjectId: string | undefined;

Object.assign(window, {
    videoSavePreflight: async () => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("video-fixture", { create: true });
        Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => root });
        await selectBrowserProjectRoot();
        const { id, saved } = beginLocalCanvasProject("预检");
        await saved;
        const node: CanvasNodeData = { id: "video-target", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "loading" } };
        useCanvasStore.getState().updateProject(id, { nodes: [node] });
        const folder = await root.getDirectoryHandle(getProjectFolderState().projectDirectories[id]);
        let submissions = 0;
        let savedOperation: string | undefined;
        const run = (op: string) => runCanvasGenerationTaskToConsumer({
            mode: "video", config: useConfigStore.getState().config, prompt: "保存预检", nodeId: node.id, projectId: id, clientOperationId: op,
        }, {
            bindTask: () => {}, consumeTask: async () => {},
            runTask: async () => {
                submissions++;
                const file = await (await folder.getFileHandle("project.qisitv.json")).getFile();
                savedOperation = JSON.parse(await file.text()).project.nodes.find((n: CanvasNodeData) => n.id === node.id).metadata.taskClientOperationId;
                throw new Error("fixture stops before model submission");
            },
        }).catch((error: Error) => ({ name: error.name, message: error.message, cause: error.cause instanceof Error ? error.cause.message : undefined }));
        await run("video-first");
        const unsubscribe = useSyncProgressStore.subscribe(() => {
            if (projectSyncProgress(id)?.phase !== "done") return;
            useCanvasStore.getState().updateProject(id, { nodes: [{ ...node, metadata: { ...node.metadata, taskClientOperationId: "newer-attempt" } }] });
        });
        const displaced = await run("video-displaced").finally(unsubscribe);
        const preservedOperation = useCanvasStore.getState().openProject(id)?.nodes[0].metadata?.taskClientOperationId;
        const descriptor = Object.getOwnPropertyDescriptor(FileSystemHandle.prototype, "queryPermission")!;
        try {
            Object.defineProperty(FileSystemHandle.prototype, "queryPermission", { configurable: true, value: async () => "denied" });
            const failure = await run("video-denied");
            return { savedOperation, submissions, failure, displaced, preservedOperation };
        } finally { Object.defineProperty(FileSystemHandle.prototype, "queryPermission", descriptor); }
    },
    startCancelledBrowserTask: async () => {
        const { id, saved } = beginLocalCanvasProject("Cancelled browser task");
        await saved;
        cancelledProjectId = id;
        cancellation = new AbortController();
        cancelledTask = runBackendGenerationTask({ projectId: id, mode: "image", prompt: "Never submit after cancellation", config: useConfigStore.getState().config, clientOperationId: "browser-cancelled-operation", signal: cancellation.signal,
            referenceImages: [{ id: "reference", name: "reference.png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=" }],
        }).then(() => "unexpected success", (error: unknown) => error instanceof Error ? error.name : "unknown failure");
    },
    abortBrowserTask: () => cancellation?.abort(),
    cancelledBrowserTaskResult: async () => {
        const error = await cancelledTask;
        const receipt = await findGenerationTaskByOperation("browser-cancelled-operation", cancelledProjectId!);
        if (!receipt) throw new Error("Cancelled operation lost its local receipt");
        const recovered = await recoverTask(receipt.id);
        return { error, stage: receipt.stage, status: receipt.status, providerRequestId: receipt.providerRequestId || null, sameReceipt: recovered.id === receipt.id };
    },
    runBrowserTaskSmoke: async () => {
        setActiveUserScope("local");
        const channel = createModelChannel({ id: "browser-likeai", apiFormat: "likeai", interfaceType: "likeai-image", baseUrl: "http://119.91.105.101:18282/api", apiKey: "test-only-not-a-real-key", models: ["doubao_seedream_4_5"], modelProfiles: [{ model: "doubao_seedream_4_5", capability: "image", protocol: "likeai-image" }] });
        const model = encodeChannelModel(channel.id, "doubao_seedream_4_5");
        const config = { ...structuredClone(defaultConfig), channels: [channel], model, imageModel: model, models: [model], imageModels: [model], size: "1:1", quality: "1080p", count: "1" };
        useConfigStore.getState().replaceConfig(config);
        const { id, saved } = beginLocalCanvasProject("Browser routing fixture");
        await saved;
        const catalog = await fetchChannelModels(channel);
        const input = await prepareBackendGenerationTask({ projectId: id, mode: "image", prompt: "Synthetic routing fixture", config, clientOperationId: "browser-routing-operation", metadata: { nodeId: "image-output" }, referenceImages: [{ id: "reference", name: "reference.png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=" }] });
        const first = await createGenerationTask(input);
        const repeated = await createGenerationTask(input);
        const found = await findGenerationTaskByOperation("browser-routing-operation", id);
        const completed = await waitForGenerationTask(first.id, { intervalMs: 1, timeoutMs: 3000 });
        const recovered = await recoverTask(first.id);
        const result = JSON.parse(completed.resultJson || "{}");
        const bytes = [...new Uint8Array(await (await getImageBlob(result.images[0].storageKey))!.arrayBuffer())];
        const node: CanvasNodeData = { id: "image-output", title: "生成图片", position: { x: 0, y: 0 }, width: 280, height: 160, type: CanvasNodeType.Image, metadata: { taskId: first.id, status: "loading", generationEffectKeys: [attachNodeEffectKey(first.id, "image-output", 0)] } };
        const nodesRef = { current: [node] };
        useCanvasStore.getState().updateProject(id, { nodes: nodesRef.current });
        let interrupted = false;
        try {
            await bindBrowserCanvasGenerationResult({ canvasId: id, nodeId: node.id, task: recovered, isCurrent: () => true,
                readNodes: () => nodesRef.current, setNodes: () => { /* Concurrent editor did not adopt the projection. */ } });
        } catch { interrupted = true; }
        const pendingAfterConflict = interrupted && (await recoverTask(first.id)).resultState === "PENDING_MATERIALIZATION";
        await bindBackendCanvasGenerationResult({
            canvasId: id, nodeId: node.id, task: recovered, nodesRef, isCurrent: () => true,
            setNodes: update => { nodesRef.current = typeof update === "function" ? update(nodesRef.current) : update; },
        });
        const receipt = await recoverTask(first.id);
        const bound = useCanvasStore.getState().openProject(id)?.nodes[0];
        const binding = { status: bound?.metadata?.status, keyMatches: bound?.metadata?.storageKey === result.images[0].storageKey,
            assetMatches: Boolean(bound?.metadata?.assetId && bound.metadata.assetId === receipt.outputs?.[0]?.materializedAssetId), resultState: receipt.resultState };
        const originalId = bound!.metadata!.assetId;
        const changeNode = (metadata: CanvasNodeData["metadata"]) => useCanvasStore.getState().updateProject(id, { nodes: [{ ...bound!, metadata }] });
        const readNode = () => useCanvasStore.getState().openProject(id)!.nodes[0];
        // A second tab has the completed receipt but not this asset in its live asset list.
        // Do not request an actual persisted deletion; only this tab's live snapshot is stale.
        useAssetStore.getState().assets = [];
        changeNode({ ...bound!.metadata, assetId: "stale-asset", storageKey: "stale-key" });
        await syncGenerationTaskToCanvasStore(receipt);
        const repaired = readNode();
        const repairedStamped = repaired.metadata?.assetId === originalId && repaired.metadata?.storageKey === result.images[0].storageKey;
        changeNode({ ...repaired.metadata, taskId: undefined, taskClientOperationId: receipt.clientOperationId,
            resultOrigin: "upload", content: "blob:manual", storageKey: "manual-upload" });
        let rejectedManual = false;
        try { await syncGenerationTaskToCanvasStore(receipt); } catch { rejectedManual = true; }
        const preservedUpload = rejectedManual && readNode().metadata?.storageKey === "manual-upload";
        let engineRequired = false;
        try { await http.get("/assistant/hosts"); }
        catch (error) { engineRequired = error instanceof ApiError && error.reason === "engine_required"; }
        return { models: catalog.models, sameReceipt: first.id === repeated.id && found?.id === first.id && recovered.id === first.id, status: completed.status, bytes,
            binding: { ...binding, pendingAfterConflict, repairedStamped, preservedUpload }, engineRequired };
    },
});
