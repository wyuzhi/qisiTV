import { generationTaskInput, generationTaskNodeId } from "@/lib/canvas/canvas-generation-task-identity";
import {
    buildImageHistoryItemId,
    resolveCanvasNodeImageHistory,
} from "@/lib/canvas/canvas-image-history";
import { extractOwnedResourceId } from "@/lib/canvas/canvas-resource-id";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import { ownedResourceIdFromMediaRef, resourceFileUrl, resourceStorageKey } from "@/services/api/resources";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasImageHistoryItem, type CanvasNodeData } from "@/types/canvas";

function isImageGenerationTask(task: GenerationTask): boolean {
    const inputMode = generationTaskInput(task)?.mode;
    if (inputMode === "text" || inputMode === "video" || inputMode === "audio") return false;
    if (inputMode === "image") return true;
    if (task.type === "canvas_text" || task.type === "canvas_video" || task.type === "canvas_audio") return false;
    return true;
}

function nonDataUrl(value?: string): string | undefined {
    const trimmed = value?.trim() || "";
    if (!trimmed || trimmed.toLowerCase().startsWith("data:")) return undefined;
    return trimmed;
}

function normalizedStorageKey(storageKey?: string, content?: string): string | undefined {
    const explicit = storageKey?.trim();
    if (explicit) return explicit;
    const owned = ownedResourceIdFromMediaRef(undefined, content);
    return owned ? resourceStorageKey(owned) : undefined;
}

export function canBackfillNodeHistoryFromTasks(node: CanvasNodeData | null | undefined): boolean {
    if (!node || node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) return false;
    const origin = node.metadata?.resultOrigin;
    if (origin === "upload" || origin === "imported" || origin === "library" || node.metadata?.importSource) return false;
    return Boolean(
        origin === "generated"
        || node.metadata?.nodeRole === "generator"
        || node.metadata?.taskId?.trim()
        || (node.metadata?.imageHistory?.length || 0) > 0,
    );
}

function historyItemsFromTask(task: GenerationTask, nodeId: string, resetEpochMs?: number): CanvasImageHistoryItem[] {
    if (!task || task.status !== "succeeded" || !isImageGenerationTask(task)) return [];
    if (resetEpochMs !== undefined && Number.isFinite(resetEpochMs)) {
        const taskTime = Date.parse(task.completedAt || task.createdAt || task.created_at || "");
        if (!Number.isFinite(taskTime) || taskTime <= resetEpochMs) return [];
    }
    const targetNodeId = task.clientContext?.nodeId || generationTaskNodeId(task);
    const input = generationTaskInput(task);
    const meta = input?.metadata && typeof input.metadata === "object" ? (input.metadata as Record<string, unknown>) : undefined;
    const outputIds = Array.isArray(meta?.outputNodeIds) ? meta.outputNodeIds : [];
    const matchesNode = targetNodeId === nodeId
        || (outputIds.length === 1 && outputIds[0] === nodeId)
        || (outputIds.length === 0 && meta?.sourceNodeId === nodeId);
    if (!matchesNode) return [];

    const parsed = parseBackendGenerationResult(task);
    let config: Record<string, unknown> | undefined;
    if (task.inputJson?.trim()) {
        try {
            const rawInput = JSON.parse(task.inputJson) as { config?: unknown };
            if (rawInput?.config && typeof rawInput.config === "object" && !Array.isArray(rawInput.config)) {
                config = rawInput.config as Record<string, unknown>;
            }
        } catch {
            config = undefined;
        }
    }
    const size = typeof config?.size === "string" && config.size.trim() ? config.size.trim() : undefined;
    const quality = typeof config?.quality === "string" && config.quality.trim() ? config.quality.trim() : undefined;
    const createdAt = (task.completedAt || task.createdAt || task.created_at || "").trim() || undefined;
    const images = parsed.images || [];

    return images.flatMap((image, index) => {
        const storageKey = normalizedStorageKey(image.storageKey, image.dataUrl || image.url);
        const ownedId = extractOwnedResourceId(storageKey, image.dataUrl || image.url);
        const content = nonDataUrl(image.url || image.dataUrl) || (ownedId ? resourceFileUrl(ownedId) : undefined);
        if (!storageKey && !content) return [];
        const id = buildImageHistoryItemId({ taskId: task.id, outputIndex: index, storageKey, content });
        if (!id) return [];
        return [{
            id,
            taskId: task.id,
            outputIndex: index,
            ...(storageKey ? { storageKey } : {}),
            ...(content ? { content } : {}),
            ...(image.width && image.width > 0 ? { naturalWidth: image.width } : {}),
            ...(image.height && image.height > 0 ? { naturalHeight: image.height } : {}),
            ...(image.bytes && image.bytes > 0 ? { bytes: image.bytes } : {}),
            ...(image.mimeType?.trim() ? { mimeType: image.mimeType.trim() } : {}),
            ...(task.model?.trim() ? { model: task.model.trim() } : {}),
            ...(size ? { size } : {}),
            ...(quality ? { quality } : {}),
            ...(task.prompt?.trim() ? { prompt: task.prompt.trim() } : {}),
            ...(createdAt ? { createdAt } : {}),
        }];
    });
}

export function discoverNodeImageHistoryFromTasks(
    nodeOrId: CanvasNodeData | string,
    projectTasks?: GenerationTask[],
): CanvasImageHistoryItem[] {
    if (!projectTasks?.length) return [];
    let nodeId: string;
    let resetEpochMs: number | undefined;
    if (typeof nodeOrId === "string") {
        nodeId = nodeOrId;
    } else {
        if (!canBackfillNodeHistoryFromTasks(nodeOrId)) return [];
        nodeId = nodeOrId.id;
        if (nodeOrId.metadata?.imageHistoryResetAt) {
            const parsedEpoch = Date.parse(nodeOrId.metadata.imageHistoryResetAt);
            if (Number.isFinite(parsedEpoch)) resetEpochMs = parsedEpoch;
        }
    }
    if (!nodeId) return [];
    const sortedTasks = [...projectTasks].sort((left, right) => {
        const leftTime = Date.parse(left.completedAt || left.createdAt || "") || 0;
        const rightTime = Date.parse(right.completedAt || right.createdAt || "") || 0;
        return leftTime - rightTime;
    });
    const out: CanvasImageHistoryItem[] = [];
    for (const task of sortedTasks) {
        out.push(...historyItemsFromTask(task, nodeId, resetEpochMs));
    }
    return out;
}

export function filterPersistableDiscoveredHistoryItems(
    discoveredItems: CanvasImageHistoryItem[],
    readyResourceIds: ReadonlySet<string>,
): CanvasImageHistoryItem[] {
    return discoveredItems.filter((item) => {
        const resourceId = extractOwnedResourceId(item.storageKey, item.content);
        if (!resourceId) return Boolean(item.content);
        return readyResourceIds.has(resourceId);
    });
}

export function resolveCanvasNodeImageHistoryWithTasks(
    node: CanvasNodeData,
    projectTasks?: GenerationTask[],
): CanvasImageHistoryItem[] {
    if (node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) return [];
    const discovered = discoverNodeImageHistoryFromTasks(node, projectTasks);
    return resolveCanvasNodeImageHistory(node, discovered);
}
