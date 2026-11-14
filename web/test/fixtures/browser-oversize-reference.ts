import { createModelChannel, defaultConfig, encodeChannelModel, useConfigStore } from "@/stores/use-config-store";
import { beginLocalCanvasProject } from "@/services/local-workspace-repository";
import { selectBrowserProjectRoot } from "@/services/browser-folder-workspace";
import { getProjectFolderState } from "@/services/browser-project-folder";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { findGenerationTaskByOperation } from "@/services/api/task-center";
import type { ResolveReferenceLinks } from "@/services/api/reference-link-replacement";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export async function runOversizeVideo(resolveReferenceLinks: ResolveReferenceLinks) {
    const root = await navigator.storage.getDirectory();
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => root });
    await selectBrowserProjectRoot();
    const { id, saved } = beginLocalCanvasProject("参考文件测试");
    await saved;
    const model = "vidu_seedance_2_5";
    const channel = createModelChannel({ id: "fixture", apiFormat: "likeai", baseUrl: "https://task.likeai.pro/task-api", apiKey: "fixture-only", models: [model], modelProfiles: [{ model, capability: "video", protocol: "likeai-video" }] });
    const config = { ...structuredClone(defaultConfig), channels: [channel], model: encodeChannelModel(channel.id, model) };
    useConfigStore.getState().replaceConfig(config);
    const node: CanvasNodeData = { id: "output", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "loading" } };
    useCanvasStore.getState().updateProject(id, { nodes: [node] });
    const reference = { id: "video", name: "动作.mp4", type: "video/mp4", url: "", storageKey: "video:fixture", durationMs: 1000, width: 640, height: 360 };
    await setMediaBlob(reference.storageKey, new Blob([new Uint8Array(34_601_262)], { type: reference.type }));
    await setImageBlob("image:fixture", new Blob(["fixture"], { type: "image/png" }));
    await setMediaBlob("audio:fixture", new Blob(["audio"], { type: "audio/mpeg" }));
    const operation = crypto.randomUUID();
    const controller = new AbortController();
    let savedBeforePrompt = false;
    let accepted = false;
    try {
        await runCanvasGenerationTaskToConsumer({
            projectId: id, nodeId: node.id, clientOperationId: operation, mode: "video", prompt: "test", config, signal: controller.signal,
            referenceVideos: [reference],
            referenceImages: [{ id: "image", name: "角色.png", type: "image/png", storageKey: "image:fixture", dataUrl: "", width: 50, height: 50 }],
            referenceAudios: [{ id: "audio", name: "音频.mp3", type: "audio/mpeg", storageKey: "audio:fixture", url: "", durationMs: 1000 }],
            resolveReferenceLinks: async (...args) => {
                const folder = await root.getDirectoryHandle(getProjectFolderState().projectDirectories[id]);
                const file = await (await folder.getFileHandle("project.qisitv.json")).getFile();
                savedBeforePrompt = JSON.parse(await file.text()).project.nodes[0].metadata.taskClientOperationId === operation;
                return resolveReferenceLinks(...args);
            },
        }, {
            bindTask: (task) => {
                accepted = task.providerRequestId === "fixture-video";
                controller.abort(); // We only exercise submission and receipt, never query for media.
            },
            consumeTask: async () => { throw new Error("unexpected result"); },
        });
    } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    }
    const task = await findGenerationTaskByOperation(operation, id);
    return JSON.stringify({ savedBeforePrompt, accepted, received: Boolean(task), originalBytes: (await getMediaBlob(reference.storageKey))?.size, originalURL: reference.url });
}
