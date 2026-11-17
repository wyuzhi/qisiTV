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

const {
    createBeefTVPluginHost,
    currentCanvasId,
    navigatePluginHost,
    setPluginHostNavigator,
} = await import("../src/lib/plugins/plugin-host-runtime");

test("plugin host treats canvas.nodes.get and task.wait as read-only and gates ops.call by declared permissions", async () => {
    calls.length = 0;
    const rwHost = createBeefTVPluginHost("probe-plugin", {
        apiVersion: "beeftv.plugin/v2",
        id: "probe-plugin",
        name: "Probe",
        version: "1.0.0",
        description: "Probe",
        permissions: ["canvas.read", "canvas.write"],
        contributes: {},
    });
    const read = await rwHost.ops.call<{ canvasId: string }>("canvas.nodes.get", { canvasId: "canvas-a", nodeIds: ["n1"] });
    expect(read.canvasId).toBe("canvas-a");
    expect(calls[0].op).toBe("canvas.nodes.get");
    expect(calls[0].body.opId).toBeUndefined();

    await rwHost.ops.call("canvas.nodes.configure", {
        canvasId: "canvas-a",
        expectedRevision: 1,
        nodes: [{ nodeId: "n1", kind: "image", patch: { prompt: "草稿" } }],
    });
    expect(calls[1].op).toBe("canvas.nodes.configure");
    expect(calls[1].body.opId).toMatch(/^plugin-probe-plugin-/);

    await expect(rwHost.ops.call("canvas.generation.submit", { runId: "r1" })).rejects.toThrow("缺少执行操作 canvas.generation.submit 的权限");

    const readOnlyHost = createBeefTVPluginHost("readonly-plugin", {
        apiVersion: "beeftv.plugin/v2",
        id: "readonly-plugin",
        name: "ReadOnly",
        version: "1.0.0",
        description: "ReadOnly",
        permissions: ["canvas.read"],
        contributes: {},
    });
    await expect(readOnlyHost.ops.call("canvas.nodes.configure", { canvasId: "canvas-a" })).rejects.toThrow("缺少执行操作 canvas.nodes.configure 的权限");
    await expect(readOnlyHost.ops.call("canvas.generation.propose", { canvasId: "canvas-a" })).rejects.toThrow("缺少执行操作 canvas.generation.propose 的权限");
    await expect(readOnlyHost.ops.call("task.cancel", { taskId: "t1" })).rejects.toThrow("缺少执行操作 task.cancel 的权限");
    await expect(readOnlyHost.ops.call("skill.draft", { name: "x" })).rejects.toThrow("缺少执行操作 skill.draft 的权限");
    await expect(readOnlyHost.ops.call("skill.publish.prepare", { skillId: "s1" })).rejects.toThrow("缺少执行操作 skill.publish.prepare 的权限");

    await readOnlyHost.ops.call("task.get", { taskId: "t1" });
    await readOnlyHost.ops.call("task.wait", { taskId: "t1" });
    await readOnlyHost.ops.call("skill.catalog", {});
    expect(calls.slice(-3).map((c) => ({ op: c.op, opId: c.body.opId }))).toEqual([
        { op: "task.get", opId: undefined },
        { op: "task.wait", opId: undefined },
        { op: "skill.catalog", opId: undefined },
    ]);

    const textOnlyHost = createBeefTVPluginHost("text-plugin", {
        apiVersion: "beeftv.plugin/v2",
        id: "text-plugin",
        name: "TextOnly",
        version: "1.0.0",
        description: "TextOnly",
        permissions: ["ai.text"],
        contributes: {},
    });
    await expect(textOnlyHost.ops.call("task.cancel", { taskId: "t1" })).rejects.toThrow("缺少执行操作 task.cancel 的权限");
    await expect(textOnlyHost.ops.call("skill.draft", { name: "x" })).rejects.toThrow("缺少执行操作 skill.draft 的权限");

    const skillWriteHost = createBeefTVPluginHost("skill-author-plugin", {
        apiVersion: "beeftv.plugin/v2",
        id: "skill-author-plugin",
        name: "SkillAuthor",
        version: "1.0.0",
        description: "SkillAuthor",
        permissions: ["skill.write", "timeline.write"],
        contributes: {},
    });
    await skillWriteHost.ops.call("skill.draft", { name: "story-helper" });
    await skillWriteHost.ops.call("skill.publish.prepare", { skillId: "s1" });
    await skillWriteHost.ops.call("canvas.timeline.update", { canvasId: "canvas-a" });
    await expect(skillWriteHost.ops.call("canvas.node.delete", { canvasId: "canvas-a", nodeId: "n1" })).rejects.toThrow(
        "缺少执行操作 canvas.node.delete 的权限",
    );

    const assetReadOnlyHost = createBeefTVPluginHost("asset-read-plugin", {
        apiVersion: "beeftv.plugin/v2",
        id: "asset-read-plugin",
        name: "AssetRead",
        version: "1.0.0",
        description: "AssetRead",
        permissions: ["asset.read"],
        contributes: {},
    });
    await assetReadOnlyHost.ops.call("asset.list", {});
    await expect(assetReadOnlyHost.ops.call("asset.delete", { id: "a1" })).rejects.toThrow("缺少执行操作 asset.delete 的权限");

    const assetUploadOnlyHost = createBeefTVPluginHost("asset-upload-plugin", {
        apiVersion: "beeftv.plugin/v2",
        id: "asset-upload-plugin",
        name: "AssetUpload",
        version: "1.0.0",
        description: "AssetUpload",
        permissions: ["asset.upload"],
        contributes: {},
    });
    await expect(assetUploadOnlyHost.ops.call("asset.list", {})).rejects.toThrow("缺少执行操作 asset.list 的权限");
    await assetUploadOnlyHost.ops.call("asset.create", { name: "a.png" });
});

test("navigatePluginHost and currentCanvasId honor desktop hash routing, basename browser routing, and registered router navigator", () => {
    const seenNavigations: string[] = [];
    setPluginHostNavigator((target) => seenNavigations.push(target));
    try {
        navigatePluginHost("/plugins");
        navigatePluginHost("p/beeftv-plugin-eagle-asset-connector");
        expect(seenNavigations).toEqual(["/plugins", "/p/beeftv-plugin-eagle-asset-connector"]);
    } finally {
        setPluginHostNavigator(null);
    }

    const replacedDesktopUrls: string[] = [];
    const desktopRuntime = {
        location: {
            protocol: "wails:",
            hostname: "wails",
            host: "wails",
            origin: "wails://wails",
            pathname: "/index.html",
            search: "",
            hash: "#/canvas/proj%20alpha",
            href: "wails://wails/index.html#/canvas/proj%20alpha",
        },
        desktopApp: {},
        history: {
            replaceState: (_data: unknown, _unused: string, url: string) => {
                replacedDesktopUrls.push(url);
            },
        },
    };
    expect(currentCanvasId(desktopRuntime)).toBe("proj alpha");
    navigatePluginHost("/plugins", desktopRuntime);
    expect(desktopRuntime.location.hash).toBe("#/plugins");
    expect(replacedDesktopUrls).toEqual(["wails://wails/#/plugins"]);

    const replacedBrowserUrls: string[] = [];
    const basenameRuntime = {
        location: {
            protocol: "https:",
            hostname: "studio.example.com",
            host: "studio.example.com",
            origin: "https://studio.example.com",
            pathname: "/subapp/canvas/canvas-99",
            search: "",
            hash: "",
            href: "https://studio.example.com/subapp/canvas/canvas-99",
        },
        basePath: "/subapp",
        history: {
            replaceState: (_data: unknown, _unused: string, url: string) => {
                replacedBrowserUrls.push(url);
            },
        },
    };
    expect(currentCanvasId(basenameRuntime)).toBe("canvas-99");
    navigatePluginHost("/assets?tab=eagle", basenameRuntime);
    expect(replacedBrowserUrls).toEqual(["/subapp/assets?tab=eagle"]);
    expect(basenameRuntime.location.pathname).toBe("/subapp/assets");
    expect(basenameRuntime.location.search).toBe("?tab=eagle");
});
