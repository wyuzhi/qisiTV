import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, encodeChannelModel, likeAIWorkspaceConfig, type AiConfig } from "@/stores/use-config-store";
import { syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { createGenerationTask, listGenerationTasks, queryGenerationTask, cancelGenerationTask, subscribeGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { publishCanvasRefresh } from "@/services/canvas-workspace-events";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { applyGenerationTaskResultToNodes, generationTaskNodeId, imageMetadata, videoMetadata, audioMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type ViewportTransform } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type RecordValue = Record<string, unknown>;
type TaskReceipt = { fingerprint: string; nodeId: string; taskId?: string; state: "pending" | "submitted" };
type AgentProject = CanvasProject & { agentTaskReceipts?: Record<string, TaskReceipt> };
export type BrowserAgentInteraction = { canvasId: string | null; selectedNodeIds: string[]; viewport?: ViewportTransform };
export type BrowserAgentCommandContext = {
    getCurrentInteraction?: () => BrowserAgentInteraction | null;
    /** Must reject unbound projects and revoked directory permission. Never prompts from a remote command. */
    assertProjectWritable?: (canvasId: string) => Promise<void>;
    /** Resolves only after the actual project folder and its assets have been committed. */
    persistProject?: (canvasId: string) => Promise<void>;
    createProject?: (title: string, requestedId?: string) => Promise<CanvasProject>;
};

export class BrowserAgentCommandError extends Error {
    constructor(public code: string, message: string) { super(message); this.name = "BrowserAgentCommandError"; }
}
function fail(code: string, message: string): never { throw new BrowserAgentCommandError(code, message); }
function record(value: unknown, label = "参数"): RecordValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_arguments", `${label}必须是对象`);
    return value as RecordValue;
}
function string(value: unknown, label: string, max = 2000): string {
    if (typeof value !== "string" || !value.trim() || value.length > max) fail("invalid_arguments", `${label}无效`);
    return value;
}
function id(value: unknown, label: string): string {
    const result = string(value, label, 200);
    if (!/^[\p{L}\p{N}_:-]+$/u.test(result)) fail("invalid_arguments", `${label}包含无效字符`);
    return result;
}
const forbiddenKeys = /^(?:__proto__|prototype|constructor|api[_-]?key|x[-_]?api[-_]?key|secret[_-]?key|authorization|cookie|headers|base[_-]?url|credential.*|token|access[-_]?token|refresh[-_]?token|pairingToken|connectionToken|client[-_]?secret|secret|password)$/i;
function assertNoSecrets(value: unknown, depth = 0): void {
    if (depth > 30) fail("invalid_arguments", "参数嵌套过深");
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.test(key)) fail("secret_not_allowed", "不要通过 Agent 传递密钥、请求头或服务地址；请在网页模型配置中设置");
        assertNoSecrets(child, depth + 1);
    }
}
function publicValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(publicValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKeys.test(key) && key !== "agentTaskReceipts").map(([key, child]) => [key, publicValue(child)]));
}
function allowedKeys(value: RecordValue, keys: readonly string[], label: string) {
    if (Object.keys(value).some((key) => !keys.includes(key))) fail("invalid_arguments", `${label}包含不支持的字段`);
}
const metadataStrings = new Set(`content storageKey assetId mimeType nodeRole resultOrigin generatedFromNodeId prompt composerContent negativePrompt status error errorDetails model provider modelId modelName mediaRole role resourceKind sourceType sourceNodeId videoStartFrameNodeId videoEndFrameNodeId videoFrameSourceNodeId videoSegmentSourceNodeId videoTrimSourceNodeId videoCropSourceNodeId videoRetakeSourceNodeId taskId taskStatus taskStage taskProvider taskCreatedAt taskUpdatedAt taskCompletedAt taskStartedAt taskErrorCode taskClientOperationId thumbnail previewUrl aspectRatio resolution size color backgroundColor label description workflowKind characterName characterPrompt characterAssetId characterVersionId characterView imageRole mediaKind outputKind generationMode generationType quality transparentBackground seconds vquality generateAudio watermark audioVoice audioFormat audioSpeed audioPitch audioVolume audioInstructions batchRootId primaryImageId stylePresetId styleProfileJson workflowTitle workflowDescription assetCategory`.split(" "));
const metadataNumbers = new Set("bytes naturalWidth naturalHeight durationMs taskProgress taskDurationMs duration count seed fontSize batchFailedCount".split(" "));
const metadataBooleans = new Set("hasAudio freeResize locked isBatchRoot batchUsesReferenceImages imageBatchExpanded externalAgent".split(" "));
const metadataLists = new Set("sourceNodeIds referenceNodeIds referenceAssetNodeIds videoMergeSourceNodeIds generationEffectKeys assetTags tags characterIds batchChildIds".split(" "));
const metadataObjects = new Set("frame storyboard batchTable characterViewNodeIds".split(" "));
function patchMetadata(previous: CanvasNodeMetadata | undefined, input: unknown): CanvasNodeMetadata {
    const next = { ...previous } as RecordValue;
    for (const [key, value] of Object.entries(record(input, "metadata"))) {
        if (value === undefined) continue;
        const valid = metadataStrings.has(key) ? typeof value === "string" : metadataNumbers.has(key) ? typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e15 : metadataBooleans.has(key) ? typeof value === "boolean" : metadataLists.has(key) ? Array.isArray(value) && value.every((item) => typeof item === "string") : metadataObjects.has(key) ? value !== null && typeof value === "object" && !Array.isArray(value) : false;
        if (!metadataStrings.has(key) && !metadataNumbers.has(key) && !metadataBooleans.has(key) && !metadataLists.has(key) && !metadataObjects.has(key)) fail("invalid_arguments", `不支持 metadata.${key}`);
        if (value === null) delete next[key];
        else if (!valid) fail("invalid_arguments", `metadata.${key}类型无效`);
        else next[key] = value;
    }
    return next as CanvasNodeMetadata;
}
function point(value: unknown) {
    const p = record(value, "position");
    allowedKeys(p, ["x", "y"], "position");
    if (typeof p.x !== "number" || !Number.isFinite(p.x) || typeof p.y !== "number" || !Number.isFinite(p.y)) fail("invalid_arguments", "position 坐标必须为有限数值");
    return { x: p.x, y: p.y };
}
function patchNode(node: CanvasNodeData, input: unknown): CanvasNodeData {
    const patch = record(input, "patch");
    allowedKeys(patch, ["title", "position", "width", "height", "parentId", "metadata"], "节点补丁");
    const next = { ...node };
    if (patch.title !== undefined) {
        if (typeof patch.title !== "string" || patch.title.length > 240) fail("invalid_arguments", "节点标题无效");
        next.title = patch.title;
    }
    if (patch.position !== undefined) next.position = point(patch.position);
    for (const dimension of ["width", "height"] as const) {
        const value = patch[dimension];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100000) fail("invalid_arguments", "节点尺寸无效");
        next[dimension] = value;
    }
    if (patch.parentId !== undefined) next.parentId = patch.parentId === null ? undefined : id(patch.parentId, "parentId");
    if (patch.metadata !== undefined) next.metadata = patchMetadata(node.metadata, patch.metadata);
    return next;
}
function newNode(input: unknown): CanvasNodeData {
    const data = record(input, "node");
    const type = string(data.type, "节点类型");
    if (!["text", "image", "video", "audio"].includes(type)) fail("invalid_arguments", "仅支持文字、图片、视频和音频节点");
    const { id: requestedId, type: _, ...patch } = data;
    return patchNode({ id: requestedId === undefined ? crypto.randomUUID() : id(requestedId, "node.id"), type: type as CanvasNodeType, title: type, position: { x: 0, y: 0 }, width: 320, height: type === "audio" ? 120 : 240, metadata: { status: "idle" } }, patch);
}
function requireNode(project: CanvasProject, nodeId: string) {
    const node = project.nodes.find((item) => item.id === nodeId);
    if (!node) fail("node_not_found", "指定节点不存在，请重新读取画布");
    return node;
}
function newConnection(project: CanvasProject, input: unknown): CanvasConnection {
    const data = record(input, "connection");
    allowedKeys(data, ["id", "fromNodeId", "toNodeId", "fromHandleId", "toHandleId", "relation"], "连线");
    const fromNodeId = id(data.fromNodeId, "fromNodeId"), toNodeId = id(data.toNodeId, "toNodeId");
    requireNode(project, fromNodeId); requireNode(project, toNodeId);
    if (fromNodeId === toNodeId) fail("invalid_arguments", "不能连接节点自身");
    const connection: CanvasConnection = { id: data.id === undefined ? crypto.randomUUID() : id(data.id, "connection.id"), fromNodeId, toNodeId };
    for (const key of ["fromHandleId", "toHandleId"] as const) if (data[key] !== undefined) { if (typeof data[key] !== "string") fail("invalid_arguments", "连线端口无效"); connection[key] = data[key]; }
    if (data.relation !== undefined) { if (!["storyboard-output", "storyboard-asset-reference", "batch-output"].includes(String(data.relation))) fail("invalid_arguments", "连线关系无效"); connection.relation = data.relation as CanvasConnection["relation"]; }
    if (project.connections.some((item) => item.id === connection.id)) fail("duplicate_id", "连线 ID 已存在");
    return connection;
}
function validateGraph(project: CanvasProject) {
    const nodeIds = new Set(project.nodes.map((node) => node.id));
    if (nodeIds.size !== project.nodes.length) fail("duplicate_id", "节点 ID 已存在");
    for (const node of project.nodes) {
        if (node.parentId && (!nodeIds.has(node.parentId) || node.parentId === node.id)) fail("invalid_arguments", "父节点不存在或指向自身");
        const visited = new Set([node.id]); let parent = node.parentId;
        while (parent) { if (visited.has(parent)) fail("invalid_arguments", "父节点循环引用"); visited.add(parent); parent = requireNode(project, parent).parentId; }
        for (const field of ["videoStartFrameNodeId", "videoEndFrameNodeId"] as const) {
            const reference = node.metadata?.[field];
            if (reference && (node.type !== "video" || requireNode(project, reference).type !== "image")) fail("invalid_arguments", "首尾帧必须是图片，目标必须是视频节点");
        }
        for (const reference of node.metadata?.referenceNodeIds || []) requireNode(project, reference);
    }
    if (project.connections.some((connection) => !nodeIds.has(connection.fromNodeId) || !nodeIds.has(connection.toNodeId))) fail("invalid_arguments", "连线引用不存在的节点");
}

/** Validate a whole batch on a clone; an invalid operation never mutates the real store. */
export function planBrowserAgentBatch(project: CanvasProject, operations: unknown): CanvasProject {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) fail("invalid_arguments", "批量操作数量必须为 1 到 100");
    const next = structuredClone(project);
    for (const item of operations) {
        const operation = record(item, "operation");
        switch (operation.op) {
            case "add": { const node = newNode(operation.node); if (next.nodes.some((existing) => existing.id === node.id)) fail("duplicate_id", "节点 ID 已存在"); next.nodes.push(node); break; }
            case "update": { const nodeId = id(operation.nodeId, "nodeId"); const node = requireNode(next, nodeId); next.nodes = next.nodes.map((item) => item.id === nodeId ? patchNode(node, operation.patch) : item); break; }
            case "delete": {
                const nodeId = id(operation.nodeId, "nodeId"); requireNode(next, nodeId);
                next.nodes = next.nodes.filter((node) => node.id !== nodeId).map((node) => {
                    const copy = { ...node, metadata: { ...node.metadata } };
                    if (copy.parentId === nodeId) delete copy.parentId;
                    for (const key of ["videoStartFrameNodeId", "videoEndFrameNodeId"] as const) if (copy.metadata[key] === nodeId) delete copy.metadata[key];
                    for (const key of ["referenceNodeIds", "sourceNodeIds", "referenceAssetNodeIds"] as const) if (copy.metadata[key]) copy.metadata[key] = copy.metadata[key]?.filter((value) => value !== nodeId);
                    return copy;
                });
                next.connections = next.connections.filter((edge) => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId); break;
            }
            case "connect": next.connections.push(newConnection(next, operation.connection)); break;
            case "disconnect": { const connectionId = id(operation.connectionId, "connectionId"); if (!next.connections.some((edge) => edge.id === connectionId)) fail("connection_not_found", "连线不存在"); next.connections = next.connections.filter((edge) => edge.id !== connectionId); break; }
            case "project": { const patch = record(operation.patch, "project.patch"); allowedKeys(patch, ["title", "canvasTitle"], "项目补丁"); if (patch.title !== undefined) next.title = string(patch.title, "title", 240); if (patch.canvasTitle !== undefined) next.canvasTitle = string(patch.canvasTitle, "canvasTitle", 240); break; }
            default: fail("invalid_arguments", "不支持的批量操作");
        }
    }
    validateGraph(next);
    next.updatedAt = new Date().toISOString();
    return next;
}

type Dependencies = {
    projects(): AgentProject[];
    replace(project: AgentProject): void;
    config(): AiConfig;
    prepare: typeof prepareBackendGenerationTask;
    createTask: typeof createGenerationTask;
    listTasks: typeof listGenerationTasks;
    queryTask: typeof queryGenerationTask;
    cancelTask: typeof cancelGenerationTask;
    applyResult: typeof applyGenerationTaskResultToNodes;
    importImage: typeof uploadImage;
    importMedia: typeof uploadMediaFile;
    subscribeTasks?: typeof subscribeGenerationTasks;
};
const defaults: Dependencies = {
    projects: () => useCanvasStore.getState().projects,
    replace: (project) => {
        const previous = useCanvasStore.getState().projects.find((item) => item.id === project.id);
        // The active editor has its own immediate refs; notify it before replacing
        // the cached document so same-field edits can reject this command.
        publishCanvasRefresh(project, previous);
        useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === project.id ? project : item) }));
    },
    config: () => likeAIWorkspaceConfig(useConfigStore.getState().config),
    prepare: prepareBackendGenerationTask, createTask: createGenerationTask, listTasks: listGenerationTasks,
    queryTask: queryGenerationTask, cancelTask: cancelGenerationTask, applyResult: applyGenerationTaskResultToNodes,
    importImage: uploadImage, importMedia: uploadMediaFile, subscribeTasks: subscribeGenerationTasks,
};
function currentRouteInteraction(): BrowserAgentInteraction | null {
    if (typeof window === "undefined") return null;
    const match = (window.location.hash.slice(1) || window.location.pathname).match(/^\/canvas\/([^/?#]+)(?:[/?#]|$)/);
    if (!match) return null;
    try { return { canvasId: decodeURIComponent(match[1]), selectedNodeIds: [] }; } catch { return null; }
}
function checkRevision(project: CanvasProject, value: unknown, required = true) {
    if (value === undefined && !required) return;
    if (!Number.isSafeInteger(value) || Number(value) < 0) fail("revision_required", "请先读取画布并提供 baseRevision");
    if ((project.revision || 0) !== value) fail("revision_conflict", `画布已发生变化，当前 revision=${project.revision || 0}；请重新读取后再编辑`);
}
function publicTask(task: GenerationTask) {
    const { inputJson: _, ...safe } = task;
    let result: unknown;
    try { result = task.resultJson ? publicValue(JSON.parse(task.resultJson)) : undefined; } catch { result = undefined; }
    return { ...publicValue({ ...safe, resultJson: undefined }) as RecordValue, ...(result ? { result } : {}) };
}
function stableJSON(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJSON(item)}`).join(",")}}`;
    return JSON.stringify(value);
}
async function fingerprint(value: unknown) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJSON(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createBrowserAgentCommandExecutor(deps: Dependencies = defaults) {
    // Serialize commands in this page. Folder persistence additionally locks across tabs.
    let tail = Promise.resolve();
    const watchingTasks = new Set<string>();
    const projectFor = (value: unknown) => {
        const canvasId = id(value, "canvasId");
        const project = deps.projects().find((item) => item.id === canvasId);
        if (!project) fail("canvas_not_found", "网页中未加载这个项目，请先打开项目文件夹");
        return project;
    };
    const interactionFor = (context: BrowserAgentCommandContext) => {
        const interaction = context.getCurrentInteraction ? context.getCurrentInteraction() : currentRouteInteraction();
        const project = deps.projects().find((item) => item.id === interaction?.canvasId);
        return project && interaction ? { ...interaction, selectedNodeIds: interaction.selectedNodeIds.filter((nodeId) => project.nodes.some((node) => node.id === nodeId)), viewport: interaction.viewport || project.viewport, revision: project.revision || 0 } : null;
    };
    const writable = async (context: BrowserAgentCommandContext, canvasId: string) => {
        if (!context.assertProjectWritable) fail("folder_required", "请先在网页选择项目文件夹并授予读写权限");
        await context.assertProjectWritable(canvasId);
    };
    const commit = async (previous: AgentProject, next: AgentProject, context: BrowserAgentCommandContext) => {
        // Guards may await permissions/IDB; never overwrite an edit made during that wait.
        const latest = projectFor(previous.id);
        if (latest !== previous && stableJSON(latest) !== stableJSON(previous)) fail("revision_conflict", "保存前画布发生变化，请重新读取后再编辑");
        deps.replace(next);
        try { await (context.persistProject || syncLocalCanvasProjectToBackend)(next.id); }
        catch (error) {
            if (deps.projects().find((item) => item.id === next.id) === next) deps.replace(previous);
            throw error;
        }
        return projectFor(next.id);
    };
    const applyTask = async (task: GenerationTask, args: RecordValue, context: BrowserAgentCommandContext) => {
        const project = projectFor(args.canvasId);
        if (task.projectId !== project.id || (args.nodeId !== undefined && args.nodeId !== generationTaskNodeId(task))) fail("task_binding_mismatch", "任务不属于指定的画布或节点");
        const nodeId = generationTaskNodeId(task); const node = requireNode(project, nodeId);
        if (node.metadata?.taskId && node.metadata.taskId !== task.id) fail("task_binding_mismatch", "节点已有更新的生成任务，不能覆盖");
        checkRevision(project, args.baseRevision);
        await writable(context, project.id);
        if (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled") fail("task_not_terminal", "任务尚未结束");
        if (task.status === "succeeded" && node.metadata?.taskId === task.id && node.metadata?.status === "success" && node.metadata.content) return { task: publicTask(task), project: publicValue(project), applied: false };
        const applied = task.status === "succeeded" ? await deps.applyResult(project.nodes, task, nodeId) : {
            updated: true,
            nodes: project.nodes.map((item) => item.id === nodeId ? { ...item, metadata: { ...item.metadata, taskId: task.id, taskStatus: task.status, taskStage: task.stage, status: "error" as const, errorDetails: task.error || (task.status === "cancelled" ? "任务已取消" : "任务失败") } } : item),
        };
        const saved = await commit(project, { ...project, nodes: applied.nodes, updatedAt: new Date().toISOString() }, context);
        return { task: publicTask(task), project: publicValue(saved), applied: applied.updated };
    };
    const execute = async (operation: string, input: unknown, context: BrowserAgentCommandContext): Promise<unknown> => {
        const args = record(input || {});
        assertNoSecrets(args);
        if (operation === "canvas_current") return { interaction: interactionFor(context) };
        if (operation === "canvas_list") return { projects: deps.projects().map(({ id, title, canvasTitle, revision, createdAt, updatedAt }) => ({ id, title, canvasTitle, revision: revision || 0, createdAt, updatedAt })) };
        if (operation === "canvas_get") return { project: publicValue(projectFor(args.canvasId)) };
        if (operation === "canvas_interaction") { const current = interactionFor(context); return { interaction: current?.canvasId === args.canvasId ? current : null }; }
        if (operation === "canvas_create") {
            if (!context.createProject) fail("folder_required", "请先在网页选择项目根文件夹");
            if (args.canvasId !== undefined && deps.projects().some((project) => project.id === args.canvasId)) fail("duplicate_id", "画布 ID 已存在");
            return { project: publicValue(await context.createProject(string(args.title, "title", 240), args.canvasId === undefined ? undefined : id(args.canvasId, "canvasId"))) };
        }
        if (operation === "model_list") return { models: deps.config().channels.filter((channel) => channel.enabled !== false).flatMap((channel) => channel.models.map((model) => {
            const profile = channel.modelProfiles?.find((item) => item.model === model);
            return publicValue({ model, channelId: channel.id, channelName: channel.name, configured: Boolean(channel.apiKey || channel.hasApiKey), capability: profile?.capability, displayName: profile?.displayName, protocol: profile?.protocol || channel.interfaceType, capabilities: profile?.capabilityConfig, defaultOptions: profile?.defaultOptions });
        })) };
        if (operation === "task_list") return { tasks: (await deps.listTasks(500, { projectId: typeof args.canvasId === "string" ? args.canvasId : undefined, activeOnly: args.activeOnly === true })).map(publicTask) };
        if (operation === "task_get") return { task: publicTask(await deps.queryTask(id(args.taskId, "taskId"))) };
        if (operation === "task_cancel") {
            const task = await deps.queryTask(id(args.taskId, "taskId"));
            if (!task.projectId) fail("task_binding_mismatch", "任务未绑定项目");
            await writable(context, task.projectId);
            return { task: publicTask(await deps.cancelTask(task.id)) };
        }
        if (operation === "task_apply_result") return applyTask(await deps.queryTask(id(args.taskId, "taskId")), args, context);
        if (operation === "task_submit") return submitTask(args, context);
        const project = projectFor(args.canvasId);
        checkRevision(project, args.baseRevision);
        await writable(context, project.id);
        let operations: unknown;
        switch (operation) {
            case "canvas_add_node": operations = [{ op: "add", node: args.node }]; break;
            case "canvas_update_node": operations = [{ op: "update", nodeId: args.nodeId, patch: args.patch }]; break;
            case "canvas_delete_node": operations = [{ op: "delete", nodeId: args.nodeId }]; break;
            case "canvas_connect_nodes": operations = [{ op: "connect", connection: args.connection }]; break;
            case "canvas_disconnect": operations = [{ op: "disconnect", connectionId: args.connectionId }]; break;
            case "canvas_batch_apply": operations = args.operations; break;
            case "canvas_set_reference": {
                const source = requireNode(project, id(args.sourceNodeId, "sourceNodeId")), target = requireNode(project, id(args.targetNodeId, "targetNodeId"));
                if (!["image", "video", "audio"].includes(source.type) || source.id === target.id) fail("invalid_reference", "参考源必须是不同的媒体节点");
                if (!["reference", "first-frame", "last-frame"].includes(String(args.role))) fail("invalid_reference", "参考角色无效");
                if (args.role !== "reference" && (source.type !== "image" || target.type !== "video")) fail("invalid_reference", "首尾帧需要图片源和视频目标");
                const metadata = args.role === "first-frame" ? { videoStartFrameNodeId: source.id } : args.role === "last-frame" ? { videoEndFrameNodeId: source.id } : { referenceNodeIds: [...new Set([...(target.metadata?.referenceNodeIds || []), source.id])] };
                operations = [...(project.connections.some((edge) => edge.fromNodeId === source.id && edge.toNodeId === target.id) ? [] : [{ op: "connect", connection: { fromNodeId: source.id, toNodeId: target.id } }]), { op: "update", nodeId: target.id, patch: { metadata } }]; break;
            }
            case "asset_import": {
                const kind = string(args.kind, "kind"), mime = string(args.mime, "mime", 120), name = string(args.name, "name", 240);
                if (!["image", "video", "audio"].includes(kind) || !mime.startsWith(`${kind}/`) || /[\\/\x00-\x1f]/.test(name)) fail("invalid_asset", "素材名称或类型无效");
                const encoded = string(args.base64, "base64", 45 * 1024 * 1024);
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail("invalid_asset", "素材编码无效");
                let bytes: Uint8Array;
                try { bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)); } catch { return fail("invalid_asset", "素材编码无效"); }
                if (bytes.length > 32 * 1024 * 1024) fail("asset_too_large", "Agent 导入单个素材不能超过 32 MiB，请从网页导入大文件");
                const file = new File([new Uint8Array(bytes)], name, { type: mime });
                const uploaded = kind === "image" ? await deps.importImage(file) : await deps.importMedia(file, kind);
                const metadata = kind === "image" ? imageMetadata(uploaded as Awaited<ReturnType<typeof uploadImage>>) : kind === "video" ? videoMetadata(uploaded) : audioMetadata(uploaded);
                operations = [{ op: "add", node: { id: args.nodeId || crypto.randomUUID(), type: kind, title: args.title || name, position: args.position || { x: 0, y: 0 }, metadata: { ...metadata, nodeRole: "result", resultOrigin: "imported" } } }]; break;
            }
            default: fail("unknown_operation", "不支持的 Agent 操作");
        }
        const next = planBrowserAgentBatch(project, operations);
        const saved = await commit(project, next, context);
        return { project: publicValue(saved) };
    };

    const submitTask = async (args: RecordValue, context: BrowserAgentCommandContext) => {
        const consent = record(args.consent, "consent");
        if (consent.approved !== true) fail("consent_required", "付费生成必须得到用户明确同意");
        string(consent.scope, "consent.scope", 2000);
        const project = projectFor(args.canvasId);
        checkRevision(project, args.baseRevision);
        await writable(context, project.id);
        const nodeId = id(args.nodeId, "nodeId"), node = requireNode(project, nodeId);
        const mode = string(args.type, "type");
        if (!["image", "video", "audio", "text"].includes(mode) || node.type !== mode) fail("invalid_arguments", "生成类型与目标节点类型不一致");
        const model = string(args.model, "model", 240), prompt = string(args.prompt, "prompt", 100000), key = string(args.idempotencyKey, "idempotencyKey", 160);
        const input = args.input === undefined ? {} : record(args.input, "input");
        allowedKeys(input, ["referenceNodeIds", "options"], "input");
        const options = input.options === undefined ? {} : record(input.options, "options");
        allowedKeys(options, ["size", "quality", "audioVoice", "audioFormat", "audioInstructions", "systemPrompt", "count", "videoSeconds", "audioSpeed", "transparentBackground", "videoGenerateAudio", "videoWatermark", "vquality", "providerOptions"], "生成选项");
        for (const [field, value] of Object.entries(options)) {
            if (field === "providerOptions") continue;
            if (["transparentBackground", "videoGenerateAudio", "videoWatermark"].includes(field)) {
                if (![true, false, "true", "false"].includes(value as boolean | string)) fail("invalid_arguments", `生成选项 ${field} 必须为布尔值`);
            } else if (["count", "videoSeconds", "audioSpeed"].includes(field)) {
                if ((typeof value !== "string" && typeof value !== "number") || !Number.isFinite(Number(value)) || Number(value) <= 0) fail("invalid_arguments", `生成选项 ${field} 必须为正数`);
            } else if (typeof value !== "string" || value.length > 100000) fail("invalid_arguments", `生成选项 ${field} 必须为字符串`);
        }
        if (options.count !== undefined && Number(options.count) !== 1) fail("invalid_arguments", "每次 Agent 提交仅允许一个生成任务");
        if (options.providerOptions !== undefined) {
            const extensions = record(options.providerOptions, "providerOptions");
            allowedKeys(extensions, [`likeai-${mode}`], "providerOptions");
            const protocol = record(extensions[`likeai-${mode}`], "协议选项");
            allowedKeys(protocol, ["kwargs"], "协议选项（时长与分辨率请使用公开字段）");
            if (protocol.kwargs !== undefined) {
                const kwargs = record(protocol.kwargs, "kwargs");
                if (Object.keys(kwargs).some((field) => /(?:url|prompt|model|duration|seconds|count|num|resolution|api_name|token|key)/i.test(field))) fail("invalid_arguments", "模型扩展参数不能覆盖参考素材、模型或费用范围");
            }
        }
        const config = deps.config();
        const channels = config.channels.filter((channel) => channel.enabled !== false && channel.models.includes(model) && (args.channelId === undefined || channel.id === args.channelId));
        if (channels.length !== 1) fail("model_not_configured", "模型未配置或重名，请调用 model_list 并指定 channelId");
        const channel = channels[0], profile = channel.modelProfiles?.find((item) => item.model === model);
        if (profile?.capability !== mode) fail("model_not_configured", "配置模型的能力与生成类型不一致");
        const referencesExplicit = input.referenceNodeIds !== undefined;
        const refIds = referencesExplicit ? input.referenceNodeIds : [...project.connections.filter((edge) => edge.toNodeId === nodeId).map((edge) => edge.fromNodeId), ...(node.metadata?.referenceNodeIds || []), node.metadata?.videoStartFrameNodeId, node.metadata?.videoEndFrameNodeId].filter(Boolean);
        if (!Array.isArray(refIds) || refIds.length > 50 || refIds.some((item) => typeof item !== "string" || item === nodeId)) fail("invalid_reference", "参考节点列表无效（最多 50 个）");
        const refs = [...new Set(refIds as string[])].map((refId) => requireNode(project, refId));
        const referenceImages: ReferenceImage[] = [], referenceVideos: ReferenceVideo[] = [], referenceAudios: ReferenceAudio[] = [];
        for (const ref of refs) {
            const meta = ref.metadata || {};
            if (!["image", "video", "audio"].includes(ref.type) || (!meta.storageKey && !/^https:\/\//.test(meta.content || ""))) fail("invalid_reference", "参考节点必须包含已保存的媒体");
            const common = { id: ref.id, name: ref.title, type: meta.mimeType || `${ref.type}/${ref.type === "image" ? "png" : ref.type === "video" ? "mp4" : "mpeg"}`, url: meta.content || "", storageKey: meta.storageKey, width: meta.naturalWidth, height: meta.naturalHeight, bytes: meta.bytes, durationMs: meta.durationMs };
            if (ref.type === "image") referenceImages.push({ ...common, dataUrl: "" });
            if (ref.type === "video") referenceVideos.push(common);
            if (ref.type === "audio") referenceAudios.push(common);
        }
        const rawOptions = Object.fromEntries(Object.entries(options).filter(([field]) => field !== "providerOptions").map(([field, value]) => [field, String(value)]));
        const taskConfig: AiConfig = { ...config, ...rawOptions, count: "1", model: encodeChannelModel(channel.id, model), taskWorkflowProvider: "model" };
        const intentFingerprint = await fingerprint({ nodeId, mode, model, channelId: channel.id, prompt, options, referenceNodeIds: refIds, references: refs.map((ref) => ({ id: ref.id, storageKey: ref.metadata?.storageKey, content: ref.metadata?.storageKey ? undefined : ref.metadata?.content })), consent });
        const receiptKey = await fingerprint(key), operationId = `agent:${project.id}:${receiptKey}`;
        const previousReceipt = project.agentTaskReceipts?.[receiptKey];
        if (previousReceipt) {
            if (previousReceipt.fingerprint !== intentFingerprint) fail("idempotency_conflict", "该 idempotencyKey 已用于不同的请求，不会再次提交");
            const prior = previousReceipt.taskId ? await deps.queryTask(previousReceipt.taskId) : (await deps.listTasks(1000, { projectId: project.id })).find((task) => task.clientOperationId === operationId);
            if (prior) { watchTask(prior, context); return { task: publicTask(prior), reused: true }; }
            fail("submission_uncertain", "这个请求曾开始提交但尚无回执，请先核对 LikeAI 任务；系统不会再次提交");
        }
        if (Object.keys(project.agentTaskReceipts || {}).length >= 1000) fail("receipt_limit", "此项目已达到 1000 条 Agent 生成回执，请新建项目继续");
        if (node.metadata?.status === "loading" || node.metadata?.taskStatus === "queued" || node.metadata?.taskStatus === "running") fail("task_in_progress", "节点已有进行中的任务");
        const prepared = await deps.prepare({ projectId: project.id, mode: mode as "image" | "video" | "audio" | "text", prompt, config: taskConfig, referenceImages, referenceVideos, referenceAudios, clientOperationId: operationId,
            metadata: { source: "browser-local-agent", nodeId, ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}), ...(!referencesExplicit ? { videoStartFrameNodeId: node.metadata?.videoStartFrameNodeId, videoEndFrameNodeId: node.metadata?.videoEndFrameNodeId } : {}) } });
        const pending: AgentProject = { ...project, agentTaskReceipts: { ...project.agentTaskReceipts, [receiptKey]: { fingerprint: intentFingerprint, nodeId, state: "pending" } } };
        await commit(project, pending, context);
        // Only this call may charge money. No retry surrounds it; intent was committed first.
        const task = await deps.createTask(prepared);
        const latest = projectFor(project.id);
        const saved = await commit(latest, { ...latest, agentTaskReceipts: { ...latest.agentTaskReceipts, [receiptKey]: { fingerprint: intentFingerprint, nodeId, state: "submitted", taskId: task.id } }, nodes: latest.nodes.map((item) => item.id === nodeId ? { ...item, metadata: { ...item.metadata, taskId: task.id, taskStatus: task.status, taskStage: task.stage, taskClientOperationId: operationId, status: task.status === "failed" ? "error" : "loading", prompt, model, externalAgent: false } } : item) }, context);
        watchTask(task, context);
        return { task: publicTask(task), revision: saved.revision || 0 };
    };
    const watchTask = (task: GenerationTask, context: BrowserAgentCommandContext) => {
        if (!deps.subscribeTasks || watchingTasks.has(task.id)) return;
        watchingTasks.add(task.id);
        let unsubscribe: (() => void) | undefined, stopped = false;
        const terminal = (completed: GenerationTask) => {
            if (!["succeeded", "failed", "cancelled"].includes(completed.status) || stopped) return;
            stopped = true;
            unsubscribe?.();
            watchingTasks.delete(task.id);
            const apply = tail.then(async () => {
                if (!completed.projectId) return;
                const current = projectFor(completed.projectId);
                await applyTask(completed, { canvasId: current.id, nodeId: generationTaskNodeId(completed), baseRevision: current.revision || 0 }, context);
            });
            tail = apply.then(() => undefined, () => undefined);
            // Preserve the provider receipt on any disk/conflict failure. A later
            // explicit task_apply_result can safely retry attachment, never creation.
            void apply.catch(() => {
                if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("qisitv:agent-save-error", { detail: { taskId: task.id, message: "生成任务已结束，但画布保存未完成。请检查项目文件夹权限，再让 Agent 执行 task_apply_result。" } }));
            });
        };
        unsubscribe = deps.subscribeTasks([task.id], terminal);
        if (stopped) unsubscribe();
    };
    return (operation: string, args: unknown, context: BrowserAgentCommandContext = {}) => {
        const result = tail.then(() => execute(operation, args, context));
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}

export const executeBrowserAgentCommand = createBrowserAgentCommandExecutor();
