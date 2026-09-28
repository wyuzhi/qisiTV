import { describe, expect, test } from "bun:test";
import { createBrowserAgentCommandExecutor, type BrowserAgentCommandContext } from "../src/services/browser-agent-commands";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";
import { CanvasNodeType } from "../src/types/canvas";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { GenerationTask } from "../src/services/api/task-center";

const project = (): CanvasProject => ({ id: "project", title: "Project", revision: 4, createdAt: "now", updatedAt: "now", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] });
function fixture(options: { lostCreateResponse?: boolean; watch?: boolean } = {}) {
    let projects = [project()];
    const tasks: GenerationTask[] = [];
    const prepared: unknown[] = [];
    let writes = 0, submissions = 0, failWrite = false;
    let prepareHook: (() => void) | undefined;
    let observer: ((task: GenerationTask) => void) | undefined;
    const config = { ...defaultConfig, channels: [createModelChannel({ id: "likeai", name: "LikeAI", apiFormat: "likeai", baseUrl: "https://task.likeai.pro/task-api", apiKey: "must-never-leak", models: ["image-model"], modelProfiles: [{ model: "image-model", capability: "image", protocol: "likeai-image" }] })] };
    const execute = createBrowserAgentCommandExecutor({
        projects: () => projects,
        replace: (next) => { projects = projects.map((item) => item.id === next.id ? next : item); },
        config: () => config,
        prepare: async (options) => { prepared.push(options); prepareHook?.(); return { projectId: options.projectId, type: `canvas_${options.mode}`, model: "image-model", prompt: options.prompt, input: { metadata: { nodeId: options.metadata?.nodeId, clientOperationId: options.clientOperationId } } }; },
        createTask: async (request) => {
            submissions++;
            const metadata = request.input?.metadata as Record<string, string>;
            const task: GenerationTask = { id: `task-${submissions}`, projectId: request.projectId, clientOperationId: metadata.clientOperationId, clientContext: { nodeId: metadata.nodeId }, type: request.type!, prompt: request.prompt, model: request.model, status: "queued", attempts: 1, createdAt: "now", updatedAt: "now" };
            tasks.push(task); if (options.lostCreateResponse) throw new Error("lost response"); return task;
        },
        listTasks: async () => tasks,
        queryTask: async (taskId) => { const found = tasks.find((task) => task.id === taskId); if (!found) throw new Error("missing task"); return found; },
        cancelTask: async (taskId) => ({ ...tasks.find((task) => task.id === taskId)!, status: "cancelled" }),
        applyResult: async (nodes, task, nodeId) => ({ nodes: nodes.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, content: "saved-result", taskId: task.id, status: "success" } } : node), updated: true, nodeId: nodeId!, node: nodes[0] }),
        importImage: async () => ({ url: "blob:safe", storageKey: "image:local:import", width: 640, height: 480, bytes: 3, mimeType: "image/png" }),
        importMedia: async () => { throw new Error("unused"); },
        subscribeTasks: options.watch ? (_ids, listener) => { observer = listener; return () => { observer = undefined; }; } : undefined,
    });
    const context: BrowserAgentCommandContext = {
        getCurrentInteraction: () => ({ canvasId: "project", selectedNodeIds: ["image", "removed"] }),
        assertProjectWritable: async () => {},
        persistProject: async (canvasId) => { writes++; if (failWrite) throw new Error("disk unavailable"); projects = projects.map((item) => item.id === canvasId ? { ...item, revision: (item.revision || 0) + 1 } : item); },
    };
    const call = (operation: string, args: Record<string, unknown> = {}) => execute(operation, { canvasId: "project", baseRevision: projects[0].revision, ...args }, context);
    return { execute, call, context, state: () => projects[0], tasks, prepared, writes: () => writes, submissions: () => submissions, failWrites: () => { failWrite = true; }, beforePrepare: (fn: () => void) => { prepareHook = fn; }, renameByUser: (title: string) => { projects = projects.map((item) => ({ ...item, title })); }, observe: (task: GenerationTask) => observer?.(task) };
}
const imageNode = { id: "image", type: "image", title: "Reference", metadata: { storageKey: "image:local:ref", content: "blob:ref", mimeType: "image/png" } };
const generation = { nodeId: "target", type: "image", model: "image-model", prompt: "draw", idempotencyKey: "approved-request", consent: { approved: true, scope: "one image, approved budget" } };

describe("website local Agent commands", () => {
    test("adds, connects and sets an actual frame reference, saving before replying", async () => {
        const f = fixture();
        await f.call("canvas_add_node", { node: imageNode });
        await f.call("canvas_add_node", { node: { id: "video", type: "video" } });
        await f.call("canvas_connect_nodes", { connection: { id: "edge", fromNodeId: "image", toNodeId: "video" } });
        await f.call("canvas_set_reference", { sourceNodeId: "image", targetNodeId: "video", role: "first-frame" });
        expect(f.state().nodes[1].metadata?.videoStartFrameNodeId).toBe("image");
        expect(f.state().connections).toHaveLength(1);
        expect(f.state().revision).toBe(8);
        expect(f.writes()).toBe(4);
        expect(await f.call("canvas_current")).toMatchObject({ interaction: { canvasId: "project", selectedNodeIds: ["image"], revision: 8 } });
    });

    test("validates an entire batch without partially applying an earlier valid mutation", async () => {
        const f = fixture();
        await expect(f.call("canvas_batch_apply", { operations: [{ op: "add", node: imageNode }, { op: "connect", connection: { fromNodeId: "image", toNodeId: "missing" } }] })).rejects.toThrow("不存在");
        expect(f.state().nodes).toEqual([]);
        expect(f.writes()).toBe(0);
        await expect(f.call("canvas_add_node", { node: imageNode, baseRevision: 3 })).rejects.toThrow("revision=4");
        await expect(f.execute("canvas_add_node", { canvasId: "project", node: imageNode }, f.context)).rejects.toThrow("baseRevision");
    });

    test("disk failure and missing folder permission never acknowledge a successful mutation", async () => {
        const f = fixture(); f.failWrites();
        await expect(f.call("canvas_add_node", { node: imageNode })).rejects.toThrow("disk unavailable");
        expect(f.state().nodes).toEqual([]);
        await expect(f.execute("canvas_add_node", { canvasId: "project", node: imageNode, baseRevision: 4 })).rejects.toThrow("项目文件夹");
    });

    test("uses current interaction instead of a guessed most recent project", async () => {
        const f = fixture();
        expect(await f.execute("canvas_current", {}, { ...f.context, getCurrentInteraction: () => null })).toEqual({ interaction: null });
        expect(await f.call("canvas_interaction", { canvasId: "different-project" })).toEqual({ interaction: null });
    });

    test("rejects paid submission without explicit approval and credential-bearing arguments", async () => {
        const f = fixture();
        await f.call("canvas_add_node", { node: { id: "target", type: "image" } });
        await expect(f.call("task_submit", { ...generation, consent: { approved: false, scope: "none" } })).rejects.toThrow("同意");
        await expect(f.call("task_submit", { ...generation, input: { options: { providerOptions: { "likeai-image": { kwargs: { apiKey: "secret" } } } } } })).rejects.toThrow("密钥");
        await expect(f.call("task_submit", { ...generation, input: { options: { count: 2 } } })).rejects.toThrow("一个");
        expect(f.submissions()).toBe(0);
        expect(JSON.stringify(await f.call("model_list"))).not.toContain("must-never-leak");
    });

    test("resolves real incoming references and records stable idempotency before one paid submission", async () => {
        const f = fixture();
        await f.call("canvas_add_node", { node: imageNode });
        await f.call("canvas_add_node", { node: { id: "target", type: "image" } });
        await f.call("canvas_set_reference", { sourceNodeId: "image", targetNodeId: "target", role: "reference" });
        await f.call("task_submit", generation);
        expect(f.prepared[0]).toMatchObject({ referenceImages: [{ id: "image", storageKey: "image:local:ref" }] });
        expect(await f.call("task_submit", generation)).toMatchObject({ reused: true, task: { id: "task-1" } });
        await expect(f.call("task_submit", { ...generation, prompt: "different image" })).rejects.toThrow("不同的请求");
        expect(f.submissions()).toBe(1);
        expect(JSON.stringify(f.state())).not.toContain("must-never-leak");
        expect(JSON.stringify(await f.call("canvas_get"))).not.toContain("agentTaskReceipts");
    });

    test("refuses to charge if intent cannot be saved, and applies only the task's original binding", async () => {
        const f = fixture();
        await f.call("canvas_add_node", { node: { id: "target", type: "image" } });
        f.failWrites();
        await expect(f.call("task_submit", generation)).rejects.toThrow("disk unavailable");
        expect(f.submissions()).toBe(0);
        const g = fixture();
        await g.call("canvas_add_node", { node: { id: "target", type: "image" } });
        await g.call("task_submit", generation);
        g.tasks[0].status = "succeeded";
        await expect(g.call("task_apply_result", { taskId: "task-1", nodeId: "another" })).rejects.toThrow("不属于");
        await g.call("task_apply_result", { taskId: "task-1" });
        expect(g.state().nodes[0].metadata?.content).toBe("saved-result");
    });

    test("imports bytes through existing media storage and deletes connections/reference fields together", async () => {
        const f = fixture();
        await f.call("asset_import", { nodeId: "image", base64: "AQID", mime: "image/png", name: "ref.png", kind: "image" });
        expect(f.state().nodes[0].metadata?.storageKey).toBe("image:local:import");
        await f.call("canvas_add_node", { node: { id: "target", type: CanvasNodeType.Video } });
        await f.call("canvas_set_reference", { sourceNodeId: "image", targetNodeId: "target", role: "first-frame" });
        await f.call("canvas_delete_node", { nodeId: "image" });
        expect(f.state().connections).toEqual([]);
        expect(f.state().nodes[0].metadata?.videoStartFrameNodeId).toBeUndefined();
        await expect(f.call("asset_import", { base64: "AQID", mime: "image/png", name: "../secret.png", kind: "image" })).rejects.toThrow("名称");
    });

    test("detects user changes while preparing references and never submits after a conflict", async () => {
        const f = fixture();
        await f.call("canvas_add_node", { node: { id: "target", type: "image" } });
        f.beforePrepare(() => f.renameByUser("User edit"));
        await expect(f.call("task_submit", generation)).rejects.toThrow("画布发生变化");
        expect(f.state().title).toBe("User edit");
        expect(f.submissions()).toBe(0);
    });

    test("recovers a persisted task after a lost create reply without another submission", async () => {
        const f = fixture({ lostCreateResponse: true });
        await f.call("canvas_add_node", { node: { id: "target", type: "image" } });
        await expect(f.call("task_submit", generation)).rejects.toThrow("lost response");
        expect(await f.call("task_submit", generation)).toMatchObject({ reused: true, task: { id: "task-1" } });
        expect(f.submissions()).toBe(1);
    });

    test("subscribes to terminal results and persists them even after the active canvas changes", async () => {
        const f = fixture({ watch: true });
        await f.call("canvas_add_node", { node: { id: "target", type: "image" } });
        await f.call("task_submit", generation);
        f.context.getCurrentInteraction = () => null;
        f.observe({ ...f.tasks[0], status: "succeeded" });
        // A following command shares the executor queue and awaits result persistence.
        await f.call("canvas_list");
        expect(f.state().nodes[0].metadata?.content).toBe("saved-result");
        expect(f.state().nodes[0].metadata?.status).toBe("success");
        expect(f.writes()).toBe(4);
    });
});
