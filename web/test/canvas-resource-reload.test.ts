import { expect, test } from "bun:test";
import { reloadCanvasGenerationResource } from "../src/pages/canvas/use-canvas-generation";
import type { GenerationTask } from "../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const task: GenerationTask = { id: "original-task", projectId: "canvas-a", type: "canvas_video", status: "succeeded", prompt: "original", attempts: 1, createdAt: "2026-10-02", updatedAt: "2026-10-02", clientContext: { nodeId: "node-a" }, resultState: "READY" };
function fixture() {
    let target: { projectId: string; revision: number; node?: CanvasNodeData } = { projectId: "canvas-a", revision: 3, node: { id: "node-a", type: CanvasNodeType.Video, title: "original", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { taskId: task.id, resourceReloadAvailable: true } } };
    const controller = new AbortController();
    const queries: string[] = [];
    let applied = 0;
    return {
        controller, queries, get applied() { return applied; },
        change(next: Partial<typeof target>) { target = { ...target, ...next }; },
        input: {
            projectId: "canvas-a", nodeId: "node-a", taskId: task.id, signal: controller.signal,
            readTarget: () => target,
            queryTask: async (id: string) => { queries.push(id); return task; },
            applyResult: async (_nodeId: string, _task: GenerationTask, options: { assertCurrent?: () => void }) => { options.assertCurrent?.(); applied++; },
        },
    };
}

test("resource recovery only queries the same accepted task before attaching it", async () => {
    const f = fixture();
    expect(await reloadCanvasGenerationResource(f.input)).toBe(task);
    expect(f.queries).toEqual([task.id]);
    expect(f.applied).toBe(1);
});

test("an old button cannot query a replacement task already assigned to the node", async () => {
    const f = fixture();
    f.change({ node: { ...f.input.readTarget().node!, metadata: { taskId: "replacement-task" } } });
    await expect(reloadCanvasGenerationResource(f.input)).rejects.toThrow("找不到可取回的原任务");
    expect(f.queries).toEqual([]);
});

for (const change of ["project", "revision", "delete", "replace-task", "edit"] as const) {
    test(`a ${change} change while querying cannot apply stale results`, async () => {
        const f = fixture();
        const query = f.input.queryTask;
        f.input.queryTask = async (id) => {
            if (change === "project") f.change({ projectId: "canvas-b" });
            if (change === "revision") f.change({ revision: 4 });
            if (change === "delete") f.change({ node: undefined });
            if (change === "replace-task") f.change({ node: { ...f.input.readTarget().node!, metadata: { taskId: "replacement-task" } } });
            if (change === "edit") f.change({ node: { ...f.input.readTarget().node!, title: "edited" } });
            return query(id);
        };
        await expect(reloadCanvasGenerationResource(f.input)).rejects.toThrow("画布或节点已改变");
        expect(f.applied).toBe(0);
    });
}

test("the guard also blocks a replacement during materialization before persistence", async () => {
    const f = fixture();
    f.input.applyResult = async (_id, _task, options) => {
        await Promise.resolve();
        f.change({ revision: 4 });
        options.assertCurrent?.();
        throw new Error("must not persist");
    };
    await expect(reloadCanvasGenerationResource(f.input)).rejects.toThrow("画布或节点已改变");
});

test("abort after query never attaches or marks the node as failed", async () => {
    const f = fixture();
    f.input.queryTask = async () => { f.controller.abort(); return task; };
    await expect(reloadCanvasGenerationResource(f.input)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.applied).toBe(0);
    expect(f.input.readTarget().node?.metadata?.status).toBeUndefined();
});

test("wrong task ownership and unavailable original results never attach", async () => {
    for (const patch of [{ id: "wrong" }, { projectId: "other" }, { clientContext: { nodeId: "other" } }, { clientContext: { nodeId: "node-a", externalAgent: true } }, { status: "failed" as const }, { resultState: "FAILED_RETRYABLE" as const, errorCode: "result_download_failed" }]) {
        const f = fixture();
        f.input.queryTask = async () => ({ ...task, ...patch });
        await expect(reloadCanvasGenerationResource(f.input)).rejects.toThrow();
        expect(f.applied).toBe(0);
    }
});

test("failed folder persistence propagates and can reattach the same cached result", async () => {
    const f = fixture();
    const apply = f.input.applyResult;
    f.input.applyResult = async () => { throw new Error("project folder permission denied"); };
    await expect(reloadCanvasGenerationResource(f.input)).rejects.toThrow("permission denied");
    f.input.applyResult = apply;
    await reloadCanvasGenerationResource(f.input);
    expect(f.queries).toEqual([task.id, task.id]);
    expect(f.applied).toBe(1);
});
