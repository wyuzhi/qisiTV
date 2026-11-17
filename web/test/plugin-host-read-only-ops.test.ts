import { expect, mock, test } from "bun:test";

type Call = { op: string; body: { opId?: string; params: Record<string, unknown> } };
const calls: Call[] = [];

mock.module("../src/services/api/operations", () => ({
    executeWorkspaceOperation: async (op: string, body: Call["body"]) => {
        calls.push({ op, body });
        return { op, replayed: false, result: { canvasId: body.params.canvasId, nodes: [], revision: 1 } };
    },
}));
mock.module("@/services/local-workspace-repository", () => ({
    refreshLocalCanvasProjectIfChanged: async () => {},
}));

const { createBeefTVPluginHost } = await import("../src/lib/plugins/plugin-host-runtime");

test("plugin host treats canvas.nodes.get as read-only and still gives batch configure an op id", async () => {
    calls.length = 0;
    const host = createBeefTVPluginHost("probe-plugin");
    const read = await host.ops.call<{ canvasId: string }>("canvas.nodes.get", { canvasId: "canvas-a", nodeIds: ["n1"] });
    expect(read.canvasId).toBe("canvas-a");
    expect(calls[0].op).toBe("canvas.nodes.get");
    expect(calls[0].body.opId).toBeUndefined();

    await host.ops.call("canvas.nodes.configure", {
        canvasId: "canvas-a",
        expectedRevision: 1,
        nodes: [{ nodeId: "n1", kind: "image", patch: { prompt: "草稿" } }],
    });
    expect(calls[1].op).toBe("canvas.nodes.configure");
    expect(calls[1].body.opId).toMatch(/^plugin-probe-plugin-/);
});
