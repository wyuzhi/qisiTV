import { normalizeTaskOutcome } from "@/lib/task-outcome";
import type { CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { canvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";

/** Recovery skips these on purpose: the depth flow owns its own reads, and an
 * unavailable result target must keep opening history instead of a backend
 * verdict. Backfill must not read or write them either. */
function backfillEligible(node: CanvasNodeData) {
    const metadata = node.metadata;
    if (!metadata?.taskId || normalizeTaskOutcome(metadata.taskOutcome)) return false;
    if (metadata.generationErrorCode === "result_target_unavailable" || metadata.fileUpload === "uploading") return false;
    const view = canvasNodeFailureView(node);
    return !view.depthResult && !view.needsRecovery;
}

type BackfillOptions = {
    nodes: CanvasNodeData[];
    query: (id: string) => Promise<GenerationTask>;
    update: (apply: (nodes: CanvasNodeData[]) => CanvasNodeData[]) => void;
    active: () => boolean;
};

/** Only read existing task outcomes. A missing/unreachable task keeps the
 * legacy display fallback; this path never recovers or creates a task. */
export async function backfillCanvasTaskOutcomes({ nodes, query, update, active }: BackfillOptions) {
    const bindings = nodes.filter(backfillEligible);
    const ids = [...new Set(bindings.map(node => node.metadata!.taskId!))];
    let cursor = 0;
    const worker = async () => {
        while (active() && cursor < ids.length) {
            const id = ids[cursor++];
            let task: GenerationTask;
            try { task = await query(id); } catch { continue; }
            if (!active() || task.id !== id || !normalizeTaskOutcome(task.outcome)) continue;
            const original = new Map(bindings.filter(node => node.metadata?.taskId === id).map(node => [node.id, node.metadata?.taskClientOperationId]));
            update(current => {
                if (!active()) return current;
                let changed = false;
                const next = current.map(node => {
                    if (!original.has(node.id) || node.metadata?.taskId !== id
                        || node.metadata.taskClientOperationId !== original.get(node.id)
                        || !backfillEligible(node)) return node;
                    changed = true;
                    return { ...node, metadata: { ...node.metadata, taskOutcome: task.outcome, taskOutcomeSource: undefined, generationPreflightError: undefined } };
                });
                return changed ? next : current;
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
}
