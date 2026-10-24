import { expect, test } from "bun:test";
import { bindBackendCanvasGenerationResult } from "../src/services/canvas-generation-consumer";
import { generationTaskMetadata, resetInterruptedGeneration } from "../src/lib/canvas/canvas-project-generation";
import type { GenerationTask } from "../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { useCanvasStore, type CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { captureUserScope } from "../src/lib/user-scope-guard";

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

test("external Agent output uses the same idempotent engine bind and retains manual node edits", async () => {
    const nodes = [structuredClone(node)];
    const nodesRef = { current: nodes };
    const project = { id: "canvas", revision: 2, nodes, connections: [] } as unknown as CanvasProject;
    const previous = useCanvasStore.getState().projects;
    useCanvasStore.setState({ projects: [project] });
    const operations = new Set<string>();
    let binds = 0;
    const identity = captureUserScope();
    const consume = () => bindBackendCanvasGenerationResult({
        canvasId: "canvas", nodeId: node.id, task: { ...task, outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "already-saved-by-backend" }] },
        nodesRef, isCurrent: () => true, setNodes: (value) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
        runtime: {
            captureScope: () => identity, liveScope: () => identity,
            hydrateOutputs: async () => undefined,
            persistDocument: async (_id, patch) => { expect(patch.nodes?.[0]?.metadata?.prompt).toBe("Unsaved local prompt"); },
            bindOutput: async (input) => {
                binds++;
                const replayed = operations.has(input.operationId);
                operations.add(input.operationId);
                const confirmed = { ...project, revision: 3, nodes: [{ ...nodes[0]!, metadata: { ...nodes[0]!.metadata, storageKey: "resource:generated", assetId: "already-saved-by-backend" } }] };
                return { op: "canvas.task.bind", opId: input.operationId, replayed, result: { bindingStatus: "bound", revision: 3, canvas: confirmed } };
            },
            adoptConfirmedProjection: async (confirmed) => confirmed,
        },
    });
    try {
        await consume();
        await consume();
        expect(binds).toBe(2);
        expect(operations.size).toBe(1);
        expect(nodesRef.current[0]?.position).toEqual(node.position);
        expect(nodesRef.current[0]?.title).toBe(node.title);
        expect(nodesRef.current[0]?.metadata?.storageKey).toBe("resource:generated");
    } finally { useCanvasStore.setState({ projects: previous }); }
});

test("page refresh preserves an external running task and its current manual edits", () => {
    const nodes = [structuredClone(node)];
    const restored = resetInterruptedGeneration(nodes);
    expect(restored[0]?.metadata?.taskId).toBe(task.id);
    expect(restored[0]?.metadata?.errorDetails).toContain("恢复");
    expect(restored[0]?.metadata?.prompt).toBe("Unsaved local prompt");
    expect(nodes[0]!.metadata!.errorDetails).toBeUndefined();
    expect(nodes[0]!.position).toEqual({ x: 700, y: 400 });
    expect(generationTaskMetadata(task).taskId).toBe(task.id);
});
