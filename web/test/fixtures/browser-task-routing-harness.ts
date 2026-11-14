import { setActiveUserScope } from "@/lib/user-scope";
import { createModelChannel, defaultConfig, encodeChannelModel, useConfigStore } from "@/stores/use-config-store";
import { beginLocalCanvasProject } from "@/services/local-workspace-repository";
import { fetchChannelModels } from "@/services/api/image-models";
import { prepareBackendGenerationTask, runBackendGenerationTask } from "@/services/api/generation-task";
import { createGenerationTask, findGenerationTaskByOperation, recoverTask, waitForGenerationTask } from "@/services/api/task-center";
import { getImageBlob } from "@/services/image-storage";
import { http, ApiError } from "@/services/api/request";

let cancelledTask: Promise<string> | undefined;
let cancellation: AbortController | undefined;
let cancelledProjectId: string | undefined;

Object.assign(window, {
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
        const input = await prepareBackendGenerationTask({ projectId: id, mode: "image", prompt: "Synthetic routing fixture", config, clientOperationId: "browser-routing-operation", referenceImages: [{ id: "reference", name: "reference.png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=" }] });
        const first = await createGenerationTask(input);
        const repeated = await createGenerationTask(input);
        const found = await findGenerationTaskByOperation("browser-routing-operation", id);
        const completed = await waitForGenerationTask(first.id, { intervalMs: 1, timeoutMs: 3000 });
        const recovered = await recoverTask(first.id);
        const result = JSON.parse(completed.resultJson || "{}");
        const bytes = [...new Uint8Array(await (await getImageBlob(result.images[0].storageKey))!.arrayBuffer())];
        let engineRequired = false;
        try { await http.get("/assistant/hosts"); }
        catch (error) { engineRequired = error instanceof ApiError && error.reason === "engine_required"; }
        return { models: catalog.models, sameReceipt: first.id === repeated.id && found?.id === first.id && recovered.id === first.id, status: completed.status, bytes, engineRequired };
    },
});
