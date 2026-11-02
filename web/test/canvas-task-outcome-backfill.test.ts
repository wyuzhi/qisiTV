import { expect, test } from "bun:test";
import { backfillCanvasTaskOutcomes } from "@/services/canvas-task-outcome-backfill";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

const outcome = { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" } as const;
const node = (id: string): CanvasNodeData => ({ id, title: id, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "success", content: "resource:original", taskStatus: "succeeded", taskId: "original" } });
const task = (id: string) => ({ id, outcome }) as GenerationTask;

test("opening old nodes reads one original task and fills every bound output", async () => {
    let live = [node("a"), node("b")];
    let queries = 0;
    await backfillCanvasTaskOutcomes({ nodes: live, query: async id => { queries++; return task(id); }, active: () => true, update: apply => { live = apply(live); } });
    expect(queries).toBe(1);
    expect(live.map(item => item.metadata?.taskOutcome)).toEqual([outcome, outcome]);
    const saved = live;
    await backfillCanvasTaskOutcomes({ nodes: live, query: async () => { throw new Error("already backfilled"); }, active: () => true, update: apply => { live = apply(live); } });
    expect(live).toBe(saved);
});

test("late results cannot overwrite a replacement binding or newer outcome", async () => {
    let live = [node("a"), node("b")];
    const replacement = { phase: "ready", regenerate: "allowed", reason: "result_ready" } as const;
    await backfillCanvasTaskOutcomes({ nodes: live, query: async id => {
        live = [{ ...live[0], metadata: { ...live[0].metadata, taskId: "replacement" } }, { ...live[1], metadata: { ...live[1].metadata, taskOutcome: replacement } }];
        return task(id);
    }, active: () => true, update: apply => { live = apply(live); } });
    expect(live[0].metadata?.taskOutcome).toBeUndefined();
    expect(live[1].metadata?.taskOutcome).toBe(replacement);
});

test("switching canvas or account cancels writes; missing tasks retain fallback", async () => {
    let active = true;
    const live = [node("a")];
    let writes = 0;
    await backfillCanvasTaskOutcomes({ nodes: live, query: async id => { active = false; return task(id); }, active: () => active, update: () => { writes++; } });
    expect(writes).toBe(0);
    await backfillCanvasTaskOutcomes({ nodes: live, query: async () => { throw new Error("404"); }, active: () => true, update: () => { writes++; } });
    expect(writes).toBe(0);
});

test("the existing generation recovery remains the sole reader of pending or failed nodes", async () => {
    const failed = node("a");
    failed.metadata = { status: "error", taskId: "original" };
    let queries = 0;
    await backfillCanvasTaskOutcomes({ nodes: [failed], query: async id => { queries++; return task(id); }, active: () => true, update: () => { throw new Error("recovery owns this node"); } });
    expect(queries).toBe(0);
});

test("depth results and unavailable result targets stay with their own flows", async () => {
    const depth = node("depth");
    depth.metadata = { ...depth.metadata, depthSourceNodeId: "source", taskType: "depth_capture" };
    const unavailable = node("unavailable");
    unavailable.metadata = { ...unavailable.metadata, status: "error", content: undefined, generationErrorCode: "result_target_unavailable", taskStatus: "succeeded" };
    let queries = 0;
    await backfillCanvasTaskOutcomes({ nodes: [depth, unavailable], query: async id => { queries++; return task(id); }, active: () => true, update: () => { throw new Error("must not write"); } });
    expect(queries).toBe(0);
});
