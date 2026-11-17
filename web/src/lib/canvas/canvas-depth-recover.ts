import { depthCaptureTaskMetadata, depthCaptureWaitFailureMetadata, isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { canCanvasNodeAcceptGenerationTask } from "@/lib/canvas/canvas-generation-task-identity";
import { equalSerializedValue } from "@/lib/canvas/canvas-node-metadata-contract";
import { assertLocalExecutorSession, beginLocalExecutorSession, isLocalExecutorSessionStop, observeLocalExecutorTask, type LocalExecutorSession } from "@/lib/plugins/builtin/editor/local-executor-session";
import type { GenerationTask } from "@/services/api/task-center";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import type { CanvasNodeData } from "@/types/canvas";

type DepthTarget = {
    node: CanvasNodeData;
    session: LocalExecutorSession;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: (updater: (current: CanvasNodeData[]) => CanvasNodeData[]) => void;
};

function ownsTask(input: DepthTarget, node: CanvasNodeData) {
    const taskId = input.node.metadata?.taskId?.trim() || "";
    return (
        node.id === input.node.id
        && Boolean(taskId)
        && node.metadata?.taskId === taskId
        && canCanvasNodeAcceptGenerationTask(node, { id: taskId })
    );
}

function sameDepthNodeState(left: CanvasNodeData, right: CanvasNodeData): boolean {
    if (left === right) return true;
    return (
        left.id === right.id &&
        left.type === right.type &&
        left.title === right.title &&
        left.width === right.width &&
        left.height === right.height &&
        left.parentId === right.parentId &&
        equalSerializedValue(left.position, right.position) &&
        equalSerializedValue(left.metadata, right.metadata)
    );
}

function applyDepthTargetUpdate(
    nodes: CanvasNodeData[],
    input: DepthTarget,
    update: (node: CanvasNodeData) => CanvasNodeData,
): CanvasNodeData[] {
    let changed = false;
    const mapped = nodes.map((node) => {
        if (!ownsTask(input, node)) return node;
        const nextNode = update(node);
        if (sameDepthNodeState(node, nextNode)) return node;
        changed = true;
        return nextNode;
    });
    return changed ? mapped : nodes;
}

function updateDepthTarget(input: DepthTarget, update: (node: CanvasNodeData) => CanvasNodeData) {
    assertLocalExecutorSession(input.session);
    const prevRefNodes = input.nodesRef.current;
    const nextRefNodes = applyDepthTargetUpdate(prevRefNodes, input, update);
    input.nodesRef.current = nextRefNodes;
    input.setNodes((current) => (current === prevRefNodes ? nextRefNodes : applyDepthTargetUpdate(current, input, update)));
}

// First completion, retry and reopen share the backend binding receipt. The
// backend patches the current node and refuses deleted or replaced targets.
export async function attachOwnedDepthCaptureResult(input: DepthTarget & { task: GenerationTask }, bind = bindBackendCanvasGenerationResult) {
    assertLocalExecutorSession(input.session);
    if (!input.nodesRef.current.some(node => ownsTask(input, node))) return;
    await bind({
        canvasId: input.session.projectId,
        nodeId: input.node.id,
        task: input.task,
        signal: input.session.controller.signal,
        nodesRef: input.nodesRef,
        setNodes: value => input.setNodes(current => typeof value === "function" ? value(current) : value),
        isCurrent: () => {
            assertLocalExecutorSession(input.session);
            return input.nodesRef.current.some(node => ownsTask(input, node));
        },
        isNodeOwned: () => input.nodesRef.current.some(node => ownsTask(input, node)),
    });
}

export async function recoverOwnedDepthCaptureNode(
    input: DepthTarget,
    bind = bindBackendCanvasGenerationResult,
    observeTask = observeLocalExecutorTask,
): Promise<void> {
    const taskId = input.node.metadata?.taskId;
    if (!taskId) {
        updateDepthTarget(input, node => ({ ...node, metadata: { ...node.metadata, status: "error", errorDetails: "深度任务未成功提交，请重新生成" } }));
        return;
    }
    let latestTask: GenerationTask | undefined;
    try {
        const task = await observeTask(taskId, input.session, {
            intervalMs: 1000,
            onTaskUpdate: task => {
                latestTask = task;
                updateDepthTarget(input, node => ({ ...node, metadata: { ...node.metadata, ...depthCaptureTaskMetadata(task) } }));
            },
        });
        await attachOwnedDepthCaptureResult({ ...input, task }, bind);
    } catch (error) {
        if (isLocalExecutorSessionStop(error)) return;
        try { assertLocalExecutorSession(input.session); } catch (stop) {
            if (isLocalExecutorSessionStop(stop)) return;
            throw stop;
        }
        // Attachment failure must never turn a succeeded task into a failed one.
        updateDepthTarget(input, node => ({ ...node, metadata: { ...node.metadata, ...depthCaptureWaitFailureMetadata(error, latestTask || taskId) } }));
    }
}

export function recoverOwnedDepthCaptureNodes(input: {
    nodesRef: { current: CanvasNodeData[] };
    signal: AbortSignal;
    projectId: string;
    getLiveProjectId: () => string;
    observers: Set<AbortController>;
    registerNodeObserver?: (nodeId: string, controller: AbortController) => () => void;
    setNodes: DepthTarget["setNodes"];
}): void {
    if (input.signal.aborted) return;
    for (const node of input.nodesRef.current) {
        if (node.metadata?.generationErrorCode === "result_target_unavailable") continue;
        if (!isDepthCaptureResultNode(node) || (node.metadata?.status !== "loading" && !(node.metadata?.status === "error" && node.metadata.taskId))) continue;
        const observer = new AbortController();
        input.observers.add(observer);
        const unregisterNodeObserver = input.registerNodeObserver?.(node.id, observer);
        const onAbort = () => observer.abort();
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
        const session = beginLocalExecutorSession(input.projectId, { controller: observer, getLiveProjectId: input.getLiveProjectId });
        void recoverOwnedDepthCaptureNode({ node, session, nodesRef: input.nodesRef, setNodes: input.setNodes }).finally(() => {
            input.signal.removeEventListener("abort", onAbort);
            input.observers.delete(observer);
            unregisterNodeObserver?.();
        });
    }
}
