import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { queryGenerationTask, retryGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import type { CanvasNodeData } from "@/types/canvas";

export function updateCanvasVideoRecoveryFeedback(nodes: CanvasNodeData[], nodeId: string, taskId: string, error?: string): CanvasNodeData[] {
    return nodes.map((node) => node.id === nodeId && node.metadata?.taskId === taskId
        ? { ...node, metadata: { ...node.metadata, ...(error ? { status: "error" as const } : {}), taskRecoveryError: error } }
        : node);
}

/** Recover the saved task first; never reconstruct a failed video's inputs from an edited canvas. */
export async function retryStoredCanvasVideo(
    taskId: string,
    signal: AbortSignal,
    onTaskUpdate: (task: GenerationTask) => void,
    dependencies = { queryGenerationTask, retryGenerationTask, waitForGenerationTask, isBrowserWorkspace },
) {
    const expectedScope = captureUserScope();
    const check = () => { signal.throwIfAborted(); assertUserScope(expectedScope); };
    check();
    // Browser cancellation only stops local waiting. Refresh the provider receipt
    // before trusting the local terminal state, so a finished video is recovered.
    const browserWorkspace = dependencies.isBrowserWorkspace();
    let task = await dependencies.queryGenerationTask(taskId, { signal, expectedScope });
    check();
    if (task.type !== "canvas_video") throw new Error("原任务不是画布视频任务，无法按原输入重试");
    if (browserWorkspace && task.providerRequestId && (task.status === "failed" || task.status === "cancelled")) {
        task = await dependencies.queryGenerationTask(taskId, { signal, expectedScope, refreshProvider: true });
        check();
    }
    if (task.status === "failed" || task.status === "cancelled") {
        onTaskUpdate(task);
        // Browser records deliberately omit the full request and credentials.
        // Creating from current canvas state here would silently change inputs.
        if (browserWorkspace) throw new Error("原视频任务未能恢复，未重新提交收费任务。原任务费用以服务商记录为准；需要再次生成时，请从原输入节点重新生成，将使用当前提示词、素材和参数并产生新费用。");
        task = await dependencies.retryGenerationTask(taskId, { signal, expectedScope });
        check();
    }
    onTaskUpdate(task);
    if (task.status === "succeeded") return task;
    const completed = await dependencies.waitForGenerationTask(task.id, {
        signal, expectedScope, initialTask: task,
        onTaskUpdate: (update) => { check(); onTaskUpdate(update); },
    });
    check();
    return completed;
}
