import { expect, test } from "bun:test";
import { applyCanvasGenerationTaskNodeEffect } from "../src/services/canvas-generation-consumer";
import { generationTaskMetadata, resetInterruptedGeneration } from "../src/lib/canvas/canvas-project-generation";
import type { GenerationTask } from "../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const task: GenerationTask = {
    id: "external-task", projectId: "canvas", type: "canvas_image", status: "succeeded",
    operation: "external_agent_generate", prompt: "Reference frame", attempts: 1,
    createdAt: "2026-09-26T08:00:00Z", updatedAt: "2026-09-26T09:00:00Z",
    clientContext: { externalAgent: true, nodeId: "target" },
};
const node: CanvasNodeData = {
    id: "target", type: CanvasNodeType.Image, title: "Manually edited title",
    position: { x: 700, y: 400 }, width: 320, height: 180,
    metadata: { externalAgent: true, taskId: task.id, taskStatus: "running", status: "loading", prompt: "Unsaved local prompt" },
};

test("external Agent task consumption never duplicates server writeback or edits the live graph", async () => {
    const nodes = [structuredClone(node)];
    const nodesRef = { current: nodes };
    let writes = 0;
    const consume = () => applyCanvasGenerationTaskNodeEffect({
        projectId: "canvas", nodeId: node.id, task,
        output: { outputIndex: 0, mediaType: "image", materializedAssetId: "already-saved-by-backend" },
        effectKey: "same-result", nodesRef, setNodes: () => { writes++; },
    });
    await consume();
    await consume();
    expect(writes).toBe(0);
    expect(nodesRef.current).toBe(nodes);
    expect(nodesRef.current[0]).toEqual(node);
});

test("page refresh preserves an external running task and its current manual edits", () => {
    const nodes = [structuredClone(node)];
    expect(resetInterruptedGeneration(nodes)).toBe(nodes);
    expect(nodes[0]!.metadata!.errorDetails).toBeUndefined();
    expect(nodes[0]!.position).toEqual({ x: 700, y: 400 });
    expect(generationTaskMetadata(task).externalAgent).toBe(true);
    expect(generationTaskMetadata({ ...task, clientContext: { nodeId: node.id } }).externalAgent).toBe(false);
});
