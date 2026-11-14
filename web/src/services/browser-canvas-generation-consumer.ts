import { getActiveUserScope } from "@/lib/user-scope";
import { applyMaterializedGenerationTaskResultToNodes, applyRecoveredGenerationTaskResultToNodes, canvasGenerationOutputIsBound } from "@/lib/canvas/canvas-generation-task-sync";
import { rebaseCanvasDocumentThreeWay } from "@/lib/canvas/canvas-document-rebase";
import { attachNodeEffectKey } from "./generation-task-materializer";
import { materializeGenerationTaskAssets } from "./project-asset-sync";
import { readBrowserCanvas, persistBrowserCanvas } from "./browser-canvas-repository";
import { browserLikeAITasks } from "./browser-likeai-tasks";
import { CanvasGenerationMaterializationError, CanvasGenerationOutputMissingError } from "./canvas-generation-errors";
import type { GenerationTask } from "./api/task-center";
import type { CanvasNodeData } from "@/types/canvas";

export async function bindBrowserCanvasGenerationResult(input: {
    canvasId: string;
    nodeId: string;
    task: GenerationTask;
    outputIndex?: number;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    isNodeOwned?: () => boolean;
    readNodes: () => CanvasNodeData[];
    setNodes: (nodes: CanvasNodeData[]) => void;
}) {
    const { canvasId, nodeId, task, signal, readNodes } = input;
    const scope = getActiveUserScope();
    const outputIndex = input.outputIndex ?? 0;
    const effectKey = attachNodeEffectKey(task.id, nodeId, outputIndex);
    const isText = task.type === "canvas_text" || task.type === "text_replay";
    const assertTarget = () => {
        if (signal?.aborted || getActiveUserScope() !== scope || !input.isCurrent() || input.isNodeOwned?.() === false) {
            throw new DOMException("画布已切换，结果仍保存在原任务中", "AbortError");
        }
        const target = readNodes().find(node => node.id === nodeId);
        const meta = target?.metadata;
        // Replacing an image keeps the node ID and can keep the old operation ID. Only a
        // pending placeholder may adopt a task by operation ID before its task ID arrives.
        const pendingOperation = !meta?.taskId && meta?.status === "loading"
            && Boolean(task.clientOperationId && meta.taskClientOperationId === task.clientOperationId)
            && !meta.content && !meta.storageKey && !meta.assetId;
        if (!readBrowserCanvas(canvasId) || task.projectId !== canvasId || !target
            || (meta?.taskId !== task.id && !pendingOperation)
            || (meta?.taskClientOperationId && task.clientOperationId && meta.taskClientOperationId !== task.clientOperationId)
            || (meta?.taskOutputIndex ?? 0) !== outputIndex) {
            throw Object.assign(new Error("原任务的目标节点已改变，结果保留在生成历史中"), { code: "result_target_unavailable" });
        }
        return target;
    };

    assertTarget();
    const service = browserLikeAITasks();
    const localTask = isText ? task : await service.ensureDownloaded(task.id, signal);
    if (localTask.stage === "download_pending" || localTask.resultState === "FAILED_RETRYABLE") {
        throw new CanvasGenerationMaterializationError(new Error(localTask.error || "结果尚未保存到本机"));
    }
    if (!isText && !localTask.outputs?.some(output => output.outputIndex === outputIndex && output.providerArtifactRef)) {
        throw new CanvasGenerationOutputMissingError(outputIndex);
    }
    // The browser owns these stored media keys. It also creates the asset IDs, which the engine would otherwise deliver.
    const materialized = isText ? localTask : await materializeGenerationTaskAssets(localTask, signal);
    const output = isText ? undefined : materialized.outputs?.find(item => item.outputIndex === outputIndex);
    if (!isText && !output?.materializedAssetId) throw new CanvasGenerationOutputMissingError(outputIndex);
    const target = assertTarget();
    const isBound = (node: CanvasNodeData | undefined) => canvasGenerationOutputIsBound(node, task.id, effectKey, output);
    if (!isBound(target)) {
        const base = { ...readBrowserCanvas(canvasId)!, nodes: readNodes() };
        const projected = isText
            ? await applyRecoveredGenerationTaskResultToNodes(base.nodes, task, nodeId)
            : await applyMaterializedGenerationTaskResultToNodes(base.nodes, materialized, output!, effectKey, nodeId);
        if (!projected.updated) throw new CanvasGenerationOutputMissingError(outputIndex);
        const latest = assertTarget();
        if (!isBound(latest)) {
            // Resolving a stored image/audio/video URL can yield while another output lands or the user moves a node.
            const currentNodes = readNodes();
            const nodes = currentNodes === base.nodes ? projected.nodes : rebaseCanvasDocumentThreeWay({
                base, local: { ...base, nodes: currentNodes }, remote: { ...base, nodes: projected.nodes },
            }).project.nodes;
            input.setNodes(nodes);
        }
    }
    const assertBound = () => {
        if (!isBound(assertTarget()) || !isBound(readBrowserCanvas(canvasId)?.nodes.find(node => node.id === nodeId))) {
            throw new Error("画布尚未保存原任务的素材，请继续取回");
        }
    };
    // A rebase or concurrent edit can displace the output while saving.
    assertBound();
    await persistBrowserCanvas(canvasId);
    assertBound();
    if (output) await service.confirmMaterializedOutputs(task.id, [output]);
}
