import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { ensureMediaNodeMinimumSize } from "@/lib/canvas/canvas-node-size";
import { repairOverlappingImageBatches } from "@/lib/canvas/canvas-generation-layout";
import { interruptFileUpload } from "@/lib/canvas/canvas-file-upload";
import { canvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";
import { nodeReferenceImage } from "./canvas-project-generation-metadata";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export const MISSING_GENERATION_TASK_IDENTITY_DETAILS = "上次提交缺少任务标识，暂时无法确认是否已生成。请先在生成历史中核对结果，避免重复扣费。";

/** 节点是否还要和任务中心对账。首次打开画布和之后才载入的快照共用这一条判定。 */
export function canvasNodeNeedsGenerationRecovery(node: CanvasNodeData) {
    return canvasNodeFailureView(node).needsRecovery;
}

// 快照恢复交给任务对账的节点，在 metadata 上挂一个只存在于本页面内存里的记号（symbol 键）。
// JSON 序列化、保存和内容对比都看不到它；节点被复制时随之带走，恢复器读过后作废，普通刷新合并进来的节点没有它。
const GENERATION_RECOVERY_RESTORE = Symbol("generationRecoveryRestore");
type RestoreTaggedMetadata = CanvasNodeMetadata & { [GENERATION_RECOVERY_RESTORE]?: object };
const consumedRestoreTokens = new WeakSet<object>();

function generationRecoveryRestoreToken(node: CanvasNodeData) {
    return (node.metadata as RestoreTaggedMetadata | undefined)?.[GENERATION_RECOVERY_RESTORE];
}

export function isGenerationRecoveryRestored(node: CanvasNodeData) {
    const token = generationRecoveryRestoreToken(node);
    return Boolean(token && !consumedRestoreTokens.has(token));
}

/** 恢复器读过这些节点后调用：同一次恢复只交出一次。 */
export function consumeGenerationRecoveryRestore(nodes: readonly CanvasNodeData[]) {
    nodes.forEach((node) => {
        const token = generationRecoveryRestoreToken(node);
        if (token) consumedRestoreTokens.add(token);
    });
}

/** 三路合并只处理持久化字段；把打开快照的恢复资格交给合并后仍绑定同一任务的节点。 */
export function carryGenerationRecoveryRestore(nodes: CanvasNodeData[], restored: readonly CanvasNodeData[]) {
    const sources = new Map(restored.map((node) => [node.id, node]));
    let changed = false;
    const next = nodes.map((node) => {
        const source = sources.get(node.id);
        if (!source || !isGenerationRecoveryRestored(source) || !canvasNodeNeedsGenerationRecovery(node)) return node;
        if (source.metadata?.taskId !== node.metadata?.taskId
            || source.metadata?.taskClientOperationId !== node.metadata?.taskClientOperationId
            || source.metadata?.agentGenerationContinuation?.id !== node.metadata?.agentGenerationContinuation?.id
            || source.metadata?.agentGenerationContinuation?.taskId !== node.metadata?.agentGenerationContinuation?.taskId) return node;
        const token = generationRecoveryRestoreToken(source);
        if (generationRecoveryRestoreToken(node) === token) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, [GENERATION_RECOVERY_RESTORE]: token } };
    });
    return changed ? next : nodes;
}

function markGenerationRecoveryRestore(node: CanvasNodeData): CanvasNodeData {
    if (!canvasNodeNeedsGenerationRecovery(node)) return node;
    const metadata: RestoreTaggedMetadata = { ...node.metadata, [GENERATION_RECOVERY_RESTORE]: {} };
    return { ...node, metadata };
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[] = []) {
    const sourceNodes = Array.isArray(nodes) ? nodes : [];
    const configWidth = NODE_DEFAULT_SIZE[CanvasNodeType.Config].width;
    const configHeight = NODE_DEFAULT_SIZE[CanvasNodeType.Config].height;
    let changed = false;
    const reset = sourceNodes.map((node) => {
        const mediaNode = ensureMediaNodeMinimumSize(interruptFileUpload(node));
        const resizedNode =
            mediaNode.type === CanvasNodeType.Config && (mediaNode.width < configWidth || mediaNode.height < configHeight)
                ? { ...mediaNode, width: Math.max(mediaNode.width, configWidth), height: Math.max(mediaNode.height, configHeight) }
                : mediaNode.type === CanvasNodeType.Script && mediaNode.height < NODE_DEFAULT_SIZE[CanvasNodeType.Script].height
                  ? { ...mediaNode, height: NODE_DEFAULT_SIZE[CanvasNodeType.Script].height }
                  : mediaNode;
        const restoredNode = markGenerationRecoveryRestore(resizedNode.metadata?.status === "loading" ? { ...resizedNode, metadata: { ...resizedNode.metadata, errorDetails: "正在从任务中心恢复生成状态..." } } : resizedNode);
        if (restoredNode !== node) changed = true;
        return restoredNode;
    });
    return repairOverlappingImageBatches(changed ? reset : sourceNodes);
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === "请求已取消" || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    const reference = node ? nodeReferenceImage(node) : null;
    return reference ? [reference] : [];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(file.name);
}
