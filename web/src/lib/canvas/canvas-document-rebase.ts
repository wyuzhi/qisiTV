import {
    equalSerializedValue,
    GENERATION_BIND_METADATA_KEYS,
    GENERATION_ERROR_METADATA_KEYS,
    GENERATION_MEDIA_RESULT_KEYS,
    isInFlightGenerationTelemetryState,
    isNonEmptyMediaRef,
    stripStaleFileUploadMetadata,
    TRANSIENT_TASK_TELEMETRY_KEYS,
} from "@/lib/canvas/canvas-node-metadata-contract";
import { reconcileCanvasUploadNode } from "@/lib/canvas/canvas-upload-rebase";
import { readyTaskOutcome } from "@/lib/task-outcome";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasDocumentRebaseResult = {
    project: CanvasProject;
    conflict: boolean;
};

const VIEW_PREFERENCE_KEYS = new Set(["viewport", "appearance", "backgroundMode", "showImageInfo"]);
const SERVER_OWNED_KEYS = new Set(["revision", "updatedAt", "remoteContentHash", "createdAt"]);
const ENTITY_LIST_KEYS = new Set(["nodes", "connections", "chatSessions"]);
const SKIP_GENERIC_KEYS = new Set(["id", ...VIEW_PREFERENCE_KEYS, ...SERVER_OWNED_KEYS, ...ENTITY_LIST_KEYS]);
const GENERATION_MEDIA_RESULT_KEY_SET = new Set<string>(GENERATION_MEDIA_RESULT_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeField(base: unknown, local: unknown, remote: unknown, conflict: { value: boolean }): unknown {
    if (equalSerializedValue(local, base)) return remote;
    if (equalSerializedValue(remote, base) || equalSerializedValue(local, remote)) return local;
    if (isPlainObject(local) && isPlainObject(remote)) {
        return mergeObject(isPlainObject(base) ? base : {}, local, remote, conflict);
    }
    conflict.value = true;
    return local;
}

function hasDefinedProperty(object: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined;
}

function isClearedProperty(object: Record<string, unknown>, key: string): boolean {
    return !hasDefinedProperty(object, key) || object[key] === null;
}

function mergeObject(
    base: Record<string, unknown>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    conflict: { value: boolean },
): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        const baseHas = hasDefinedProperty(base, key);
        const localHas = hasDefinedProperty(local, key);
        const remoteHas = hasDefinedProperty(remote, key);
        if (!localHas && baseHas) {
            if (remoteHas && !isClearedProperty(remote, key) && !equalSerializedValue(remote[key], base[key])) conflict.value = true;
            continue;
        }
        if (!localHas) {
            if (remoteHas && !isClearedProperty(remote, key)) merged[key] = remote[key];
            continue;
        }
        if (!remoteHas) {
            if (isClearedProperty(local, key)) continue;
            if (baseHas && !equalSerializedValue(local[key], base[key])) {
                conflict.value = true;
                merged[key] = local[key];
            } else if (!baseHas) {
                merged[key] = local[key];
            }
            continue;
        }
        if (!baseHas) {
            merged[key] = mergeField(undefined, local[key], remote[key], conflict);
            continue;
        }
        merged[key] = mergeField(base[key], local[key], remote[key], conflict);
    }
    return merged;
}

function nodeTaskId(node: CanvasNodeData | undefined) {
    const taskId = node?.metadata?.taskId;
    return typeof taskId === "string" ? taskId.trim() : "";
}

function ownMetadataString(metadata: CanvasNodeData["metadata"] | undefined, key: string): string | undefined {
    if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, key)) return undefined;
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
}

function hasInFlightTaskOutcome(value: unknown) {
    if (!isPlainObject(value)) return false;
    return value.phase === "running" || value.phase === "fetching";
}

function isInFlightGenerationOverlay(node: CanvasNodeData) {
    const status = node.metadata?.status;
    if (status === "loading" || status === "error") return true;
    return (
        status === "success"
        && (!node.metadata?.taskStatus || node.metadata.taskStatus === "succeeded")
        && hasInFlightTaskOutcome(node.metadata?.taskOutcome)
    );
}

function remoteHasBoundGenerationResult(node: CanvasNodeData | undefined) {
    const meta = node?.metadata;
    if (!meta || meta.status !== "success") return false;
    return isNonEmptyMediaRef(meta.content) || isNonEmptyMediaRef(meta.storageKey) || isNonEmptyMediaRef(meta.assetId);
}

function hasTrueGenerationContentConflict(base: CanvasNodeData | undefined, local: CanvasNodeData, remote: CanvasNodeData) {
    const localContent = ownMetadataString(local.metadata, "content");
    if (localContent === undefined) return false;
    // loading/error + 空串是恢复 overlay，不是人把已绑定 success 清掉。
    if (!isNonEmptyMediaRef(localContent) && isInFlightGenerationOverlay(local)) return false;
    const remoteContent = ownMetadataString(remote.metadata, "content") ?? "";
    const baseContent = ownMetadataString(base?.metadata, "content") ?? "";
    return localContent !== remoteContent && localContent !== baseContent;
}

/**
 * 只结算同一任务仍在 loading/error 展示层上的生成字段。
 * 远端必须 status=success 且带有效 media；taskStatus=succeeded 或空 content 不能当已绑定完成。
 * loading/error 上的空 content 是 overlay，不是人类清空，可被远端已绑定 success 结算。
 * 人类写过的非空 content 保留；非 overlay 上的空串按真实编辑保留。
 * 新任务删除 content 键视为正常清旧结果，不同 taskId 不会写回旧 storageKey。
 */
export function settleInFlightGenerationOverlay(input: {
    base: CanvasProject;
    local: CanvasProject;
    remote: CanvasProject;
}): CanvasProject {
    const baseById = new Map((input.base.nodes || []).map((node) => [node.id, node]));
    const remoteById = new Map((input.remote.nodes || []).map((node) => [node.id, node]));
    let changed = false;
    const nodes = (input.local.nodes || []).map((localNode) => {
        const remoteNode = remoteById.get(localNode.id);
        const taskId = nodeTaskId(localNode);
        if (!remoteNode || !taskId || nodeTaskId(remoteNode) !== taskId) return localNode;
        if (!isInFlightGenerationOverlay(localNode) || !remoteHasBoundGenerationResult(remoteNode)) return localNode;
        if (hasTrueGenerationContentConflict(baseById.get(localNode.id), localNode, remoteNode)) return localNode;
        const metadata: CanvasNodeData["metadata"] = { ...(localNode.metadata || {}) };
        const remoteMeta = remoteNode.metadata || {};
        for (const key of GENERATION_BIND_METADATA_KEYS) {
            if (GENERATION_MEDIA_RESULT_KEY_SET.has(key)) {
                const value = remoteMeta[key];
                if (isNonEmptyMediaRef(value)) {
                    (metadata as Record<string, unknown>)[key] = value;
                }
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(remoteMeta, key) && remoteMeta[key] !== undefined && remoteMeta[key] !== null) {
                (metadata as Record<string, unknown>)[key] = remoteMeta[key];
            } else {
                delete (metadata as Record<string, unknown>)[key];
            }
        }
        for (const key of GENERATION_ERROR_METADATA_KEYS) {
            delete (metadata as Record<string, unknown>)[key];
        }
        if (!isPlainObject(metadata.taskOutcome) || hasInFlightTaskOutcome(metadata.taskOutcome)) {
            metadata.taskOutcome = readyTaskOutcome();
        }
        changed = true;
        return { ...localNode, metadata };
    });
    return changed ? { ...input.local, nodes } : input.local;
}

// 节点级 createdAt/updatedAt 由编辑器在打开和编辑时补写，服务端写入的节点常常没有；
// 它们不是用户编辑，远端删掉的节点不能只因为这两个字段不同就被留下。
function stripNodeTimestamps(node: CanvasNodeData | undefined): Record<string, unknown> {
    if (!node) return {};
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = node;
    return rest as unknown as Record<string, unknown>;
}

function sameNodeIgnoringTimestamps(left: CanvasNodeData, right: CanvasNodeData) {
    return equalSerializedValue(stripNodeTimestamps(left), stripNodeTimestamps(right));
}

const TASK_LIFECYCLE_NON_MEDIA_KEYS = [
    "taskId",
    ...GENERATION_BIND_METADATA_KEYS.filter((key) => !GENERATION_MEDIA_RESULT_KEY_SET.has(key)),
    ...GENERATION_ERROR_METADATA_KEYS,
] as const;

const SAME_ACTIVE_TASK_SETTLED_TELEMETRY_KEYS = [
    ...TRANSIENT_TASK_TELEMETRY_KEYS,
    "processingLabel",
    "taskOutcome",
] as const;

function outcomePhaseRank(value: unknown): number {
    if (!isPlainObject(value)) return 0;
    const phase = value.phase;
    if (phase === "ready" || phase === "failed") return 4;
    if (phase === "retrievable") return 3;
    if (phase === "fetching") return 2;
    if (phase === "running") return 1;
    return 0;
}

function resolveSameActiveTaskTelemetryField(
    key: (typeof SAME_ACTIVE_TASK_SETTLED_TELEMETRY_KEYS)[number],
    baseMeta: Record<string, unknown>,
    localMeta: Record<string, unknown>,
    remoteMeta: Record<string, unknown>,
    localInFlight: boolean,
    remoteInFlight: boolean,
    remoteIsNewer: boolean,
): unknown {
    const lHas = hasDefinedProperty(localMeta, key);
    const rHas = hasDefinedProperty(remoteMeta, key);
    const bHas = hasDefinedProperty(baseMeta, key);

    if (key !== "taskOutcome") {
        if (localInFlight && remoteInFlight) return undefined;
        if (localInFlight && !remoteInFlight) return rHas ? remoteMeta[key] : undefined;
        if (!localInFlight && remoteInFlight) return lHas ? localMeta[key] : undefined;
    }

    if (!lHas && !rHas) return undefined;
    // 不因单侧缺失字段而清空对侧已落定的权威/追踪字段。
    if (lHas && !rHas) return localMeta[key];
    if (!lHas && rHas) return remoteMeta[key];

    const lVal = localMeta[key];
    const rVal = remoteMeta[key];
    if (equalSerializedValue(lVal, rVal)) return lVal;
    if (bHas && equalSerializedValue(lVal, baseMeta[key])) return rVal;
    if (bHas && equalSerializedValue(rVal, baseMeta[key])) return lVal;

    if (key === "taskOutcome") {
        const lRank = outcomePhaseRank(lVal);
        const rRank = outcomePhaseRank(rVal);
        if (rRank !== lRank) return rRank > lRank ? rVal : lVal;
    }
    return remoteIsNewer ? rVal : lVal;
}

function isNodeInFlightTaskTelemetry(node: CanvasNodeData | undefined): boolean {
    const metadata = node?.metadata;
    if (!metadata || metadata.status !== "loading" || !nodeTaskId(node)) return false;
    return isInFlightGenerationTelemetryState({
        status: metadata.taskStatus,
        stage: metadata.taskStage,
        outcome: isPlainObject(metadata.taskOutcome) ? (metadata.taskOutcome as { phase?: string }) : undefined,
    });
}

function stripInFlightTaskTelemetry(node: CanvasNodeData | undefined): CanvasNodeData | undefined {
    const metadata = node?.metadata;
    if (!metadata || !isNodeInFlightTaskTelemetry(node)) {
        return node;
    }
    const record = metadata as Record<string, unknown>;
    const stripDepthLabel = Boolean(metadata.depthSourceNodeId || metadata.taskType === "depth_capture") && record.processingLabel !== undefined;
    if (!stripDepthLabel && !TRANSIENT_TASK_TELEMETRY_KEYS.some((key) => record[key] !== undefined)) {
        return node;
    }
    const cleaned: Record<string, unknown> = { ...record };
    for (const key of TRANSIENT_TASK_TELEMETRY_KEYS) {
        delete cleaned[key];
    }
    if (stripDepthLabel) {
        delete cleaned.processingLabel;
    }
    return { ...node, metadata: cleaned as CanvasNodeData["metadata"] };
}

function mergeCanvasNodeItem(
    baseItem: CanvasNodeData | undefined,
    localItem: CanvasNodeData,
    remoteItem: CanvasNodeData,
    conflict: { value: boolean },
): CanvasNodeData {
    const uploadReconciled = reconcileCanvasUploadNode(baseItem, localItem, remoteItem, conflict);
    const localInFlight = isNodeInFlightTaskTelemetry(uploadReconciled.local);
    const remoteInFlight = isNodeInFlightTaskTelemetry(uploadReconciled.remote);
    const baseClean = stripInFlightTaskTelemetry(uploadReconciled.base);
    let localNormalized = stripInFlightTaskTelemetry(uploadReconciled.local)!;
    let remoteNormalized = stripInFlightTaskTelemetry(uploadReconciled.remote)!;

    const taskId = nodeTaskId(localNormalized);
    const baseMeta = (baseClean?.metadata || {}) as Record<string, unknown>;
    const localMeta = (localNormalized.metadata || {}) as Record<string, unknown>;
    const sameActiveTaskStatus =
        Boolean(taskId) &&
        nodeTaskId(remoteNormalized) === taskId &&
        localNormalized.metadata?.status === "loading" &&
        remoteNormalized.metadata?.status === "loading" &&
        localNormalized.metadata?.taskStatus === remoteNormalized.metadata?.taskStatus;
    if (
        sameActiveTaskStatus &&
        !remoteHasBoundGenerationResult(remoteNormalized) &&
        !hasTrueGenerationContentConflict(baseClean, localNormalized, remoteNormalized)
    ) {
        // 同一活跃任务在取回结果/待恢复阶段按字段结合基线合并：本端未改时采纳远端新进度/结果状态，
        // 单侧缺失字段时保留已定义值，双侧同时推进时按更新时间戳与结果阶段演进消解，不制造假三路冲突。
        const remoteNormMeta = (remoteNormalized.metadata || {}) as Record<string, unknown>;
        const localUpdatedAt = typeof localMeta.taskUpdatedAt === "string" ? localMeta.taskUpdatedAt : "";
        const remoteUpdatedAt = typeof remoteNormMeta.taskUpdatedAt === "string" ? remoteNormMeta.taskUpdatedAt : "";
        const remoteIsNewer = Boolean(localUpdatedAt && remoteUpdatedAt && remoteUpdatedAt > localUpdatedAt);
        const alignedLocalMeta: Record<string, unknown> = { ...localMeta };
        const alignedRemoteMeta: Record<string, unknown> = { ...remoteNormMeta };
        for (const key of SAME_ACTIVE_TASK_SETTLED_TELEMETRY_KEYS) {
            const resolved = resolveSameActiveTaskTelemetryField(
                key,
                baseMeta,
                localMeta,
                remoteNormMeta,
                localInFlight,
                remoteInFlight,
                remoteIsNewer,
            );
            if (resolved !== undefined) {
                alignedLocalMeta[key] = resolved;
                alignedRemoteMeta[key] = resolved;
            } else {
                delete alignedLocalMeta[key];
                delete alignedRemoteMeta[key];
            }
        }
        localNormalized = { ...localNormalized, metadata: alignedLocalMeta as CanvasNodeData["metadata"] };
        remoteNormalized = { ...remoteNormalized, metadata: alignedRemoteMeta as CanvasNodeData["metadata"] };
    } else if (
        !sameActiveTaskStatus &&
        TASK_LIFECYCLE_NON_MEDIA_KEYS.some(key => !equalSerializedValue(baseMeta[key], localMeta[key])) &&
        !remoteHasBoundGenerationResult(remoteNormalized) &&
        !hasTrueGenerationContentConflict(baseClean, localNormalized, remoteNormalized) &&
        (localNormalized.metadata?.status === "loading" || localNormalized.metadata?.status === "error") &&
        (remoteNormalized.metadata?.status === "loading" || remoteNormalized.metadata?.status === "error")
    ) {
        const alignedMeta: Record<string, unknown> = { ...(remoteNormalized.metadata || {}) };
        for (const key of TASK_LIFECYCLE_NON_MEDIA_KEYS) {
            if (hasDefinedProperty(localMeta, key)) {
                alignedMeta[key] = localMeta[key];
            } else {
                delete alignedMeta[key];
            }
        }
        remoteNormalized = { ...remoteNormalized, metadata: alignedMeta as CanvasNodeData["metadata"] };
    }
    const merged = stripStaleFileUploadMetadata(
        mergeObject(
            stripNodeTimestamps(baseClean),
            stripNodeTimestamps(localNormalized),
            stripNodeTimestamps(remoteNormalized),
            conflict,
        ) as unknown as CanvasNodeData,
    );
    const createdAt = localItem.createdAt || remoteItem.createdAt || baseItem?.createdAt;
    const updatedAt = localItem.updatedAt || remoteItem.updatedAt || baseItem?.updatedAt;
    return {
        ...merged,
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
    };
}

function mergeEntityList<T extends { id: string }>(
    base: T[] | undefined,
    local: T[] | undefined,
    remote: T[] | undefined,
    conflict: { value: boolean },
    sameAsBase: (local: T, base: T) => boolean = equalSerializedValue,
    mergeItem?: (baseItem: T | undefined, localItem: T, remoteItem: T, conflict: { value: boolean }) => T,
): T[] {
    const baseItems = Array.isArray(base) ? base : [];
    const localItems = Array.isArray(local) ? local : [];
    const remoteItems = Array.isArray(remote) ? remote : [];
    const baseById = new Map(baseItems.map((item) => [item.id, item]));
    const localById = new Map(localItems.map((item) => [item.id, item]));
    const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
    const result: T[] = [];
    const seen = new Set<string>();

    const consider = (id: string) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        const baseItem = baseById.get(id);
        const localItem = localById.get(id);
        const remoteItem = remoteById.get(id);
        if (baseItem && !localItem) {
            if (remoteItem && !sameAsBase(remoteItem, baseItem)) conflict.value = true;
            return;
        }
        if (baseItem && !remoteItem) {
            if (localItem && !sameAsBase(localItem, baseItem)) {
                conflict.value = true;
                result.push(localItem);
            }
            return;
        }
        if (localItem && remoteItem) {
            result.push(
                mergeItem
                    ? mergeItem(baseItem, localItem, remoteItem, conflict)
                    : (mergeObject(
                          (baseItem || {}) as unknown as Record<string, unknown>,
                          localItem as unknown as Record<string, unknown>,
                          remoteItem as unknown as Record<string, unknown>,
                          conflict,
                      ) as unknown as T),
            );
            return;
        }
        if (localItem) {
            result.push(localItem);
            return;
        }
        if (remoteItem) result.push(remoteItem);
    };

    for (const item of localItems) consider(item.id);
    for (const item of remoteItems) consider(item.id);
    return result;
}

/**
 * 以已确认快照为基线的字段级三路合并。
 *
 * 本地相对基线的删除与未冲突编辑保留；服务端相对基线、本地未改的字段（含生成媒体）采纳。
 * 同一字段双方都改过时保留本地可见值并标冲突，不猜胜者。
 */
export function rebaseCanvasDocumentThreeWay(input: {
    base: CanvasProject;
    local: CanvasProject;
    remote: CanvasProject;
}): CanvasDocumentRebaseResult {
    const conflict = { value: false };
    const generic = mergeObject(
        Object.fromEntries(Object.entries(input.base).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        Object.fromEntries(Object.entries(input.local).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        Object.fromEntries(Object.entries(input.remote).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        conflict,
    );
    const project: CanvasProject = {
        ...input.remote,
        ...generic,
        id: input.local.id,
        title: (generic.title as string | undefined) ?? input.local.title,
        nodes: mergeEntityList<CanvasNodeData>(
            input.base.nodes?.map((node) => stripStaleFileUploadMetadata(node)),
            input.local.nodes?.map((node) => stripStaleFileUploadMetadata(node)),
            input.remote.nodes?.map((node) => stripStaleFileUploadMetadata(node)),
            conflict,
            sameNodeIgnoringTimestamps,
            mergeCanvasNodeItem,
        ),
        connections: mergeEntityList<CanvasConnection>(input.base.connections, input.local.connections, input.remote.connections, conflict),
        chatSessions: mergeEntityList(input.base.chatSessions, input.local.chatSessions, input.remote.chatSessions, conflict),
        viewport: input.local.viewport || input.remote.viewport,
        appearance: input.local.appearance || input.remote.appearance,
        backgroundMode: input.local.backgroundMode || input.remote.backgroundMode,
        showImageInfo: input.local.showImageInfo,
        revision: input.remote.revision,
        updatedAt: input.remote.updatedAt,
        remoteContentHash: input.remote.remoteContentHash,
        createdAt: input.remote.createdAt || input.local.createdAt,
    };
    return { project, conflict: conflict.value };
}
