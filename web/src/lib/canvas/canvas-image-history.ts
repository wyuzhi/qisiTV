import { fitImageNodeToDecodedSize } from "@/lib/canvas/canvas-node-size";
import { assetResourceId, extractOwnedResourceId } from "@/lib/canvas/canvas-resource-id";
import { canReloadCanvasNodeResource } from "@/lib/task-outcome";
import { ownedResourceIdFromMediaRef, resourceFileUrl, resourceStorageKey } from "@/services/api/resources";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasImageHistoryItem, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export const MAX_CANVAS_IMAGE_HISTORY = 50;
const MAX_IMAGE_HISTORY_TOMBSTONES = 200;

export type PrimaryImageHistorySwitchBlockReason = "loading" | "retrievable" | "invalid";

export type PrimaryImageHistorySwitchPlan =
    | {
          ok: true;
          node: CanvasNodeData;
          item: CanvasImageHistoryItem;
          needsAssetEnsure: boolean;
      }
    | {
          ok: false;
          reason: PrimaryImageHistorySwitchBlockReason;
      };

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

export function buildImageHistoryItemId(input: { taskId?: string; outputIndex?: number; storageKey?: string; content?: string }): string {
    const taskId = input.taskId?.trim();
    if (taskId) return `${taskId}:${input.outputIndex ?? 0}`;
    const key = normalizedStorageKey(input.storageKey, input.content);
    if (key) return `storage:${key}`;
    const url = nonDataUrl(input.content);
    return url ? `url:${url}` : "";
}

export function buildImageHistoryItemFromMetadata(metadata: CanvasNodeMetadata | undefined): CanvasImageHistoryItem | null {
    if (!metadata || metadata.isBatchRoot || metadata.fileUpload) return null;
    const storageKey = normalizedStorageKey(metadata.storageKey, metadata.content);
    const ownedId = extractOwnedResourceId(storageKey, metadata.content);
    const content = nonDataUrl(metadata.content) || (ownedId ? resourceFileUrl(ownedId) : undefined);
    if (!storageKey && !content) return null;
    const id = buildImageHistoryItemId({
        taskId: metadata.taskId,
        outputIndex: metadata.taskOutputIndex,
        storageKey,
        content,
    });
    if (!id) return null;
    return {
        id,
        ...(metadata.taskId?.trim() ? { taskId: metadata.taskId.trim() } : {}),
        ...(typeof metadata.taskOutputIndex === "number" ? { outputIndex: metadata.taskOutputIndex } : {}),
        ...(storageKey ? { storageKey } : {}),
        ...(content ? { content } : {}),
        ...(metadata.assetId?.trim() ? { assetId: metadata.assetId.trim() } : {}),
        ...(metadata.naturalWidth && metadata.naturalWidth > 0 ? { naturalWidth: metadata.naturalWidth } : {}),
        ...(metadata.naturalHeight && metadata.naturalHeight > 0 ? { naturalHeight: metadata.naturalHeight } : {}),
        ...(metadata.bytes && metadata.bytes > 0 ? { bytes: metadata.bytes } : {}),
        ...(metadata.mimeType?.trim() ? { mimeType: metadata.mimeType.trim() } : {}),
        ...(metadata.model?.trim() ? { model: metadata.model.trim() } : {}),
        ...(metadata.size?.trim() ? { size: metadata.size.trim() } : {}),
        ...(metadata.quality?.trim() ? { quality: metadata.quality.trim() } : {}),
        ...(metadata.prompt?.trim() ? { prompt: metadata.prompt.trim() } : {}),
        ...((metadata.taskCompletedAt || metadata.taskCreatedAt)?.trim()
            ? { createdAt: (metadata.taskCompletedAt || metadata.taskCreatedAt)!.trim() }
            : {}),
    };
}

export function sameHistoryIdentity(left: CanvasImageHistoryItem, right: CanvasImageHistoryItem): boolean {
    const leftKey = normalizedStorageKey(left.storageKey, left.content);
    const rightKey = normalizedStorageKey(right.storageKey, right.content);
    if (leftKey && rightKey) return leftKey === rightKey;
    const leftUrl = nonDataUrl(left.content);
    const rightUrl = nonDataUrl(right.content);
    if (!leftKey && !rightKey && leftUrl && rightUrl) return leftUrl === rightUrl;
    return Boolean(left.id && right.id && left.id === right.id);
}

function mergeHistoryItem(
    existing: CanvasImageHistoryItem,
    incoming: CanvasImageHistoryItem,
    options?: { overwriteGeneration?: boolean },
): CanvasImageHistoryItem {
    const overwriteGeneration = Boolean(options?.overwriteGeneration);
    const preferTaskId = existing.taskId || incoming.taskId;
    const preferOutputIndex = existing.outputIndex ?? incoming.outputIndex;
    const storageKey = incoming.storageKey || existing.storageKey;
    const content = incoming.content || existing.content;
    const pickGen = <T extends string | undefined>(prev: T, next: T): T =>
        (overwriteGeneration ? next || prev : prev || next) as T;

    const model = pickGen(existing.model, incoming.model);
    const size = pickGen(existing.size, incoming.size);
    const quality = pickGen(existing.quality, incoming.quality);
    const prompt = pickGen(existing.prompt, incoming.prompt);
    const createdAt = pickGen(existing.createdAt, incoming.createdAt);

    return {
        id: preferTaskId ? `${preferTaskId}:${preferOutputIndex ?? 0}` : existing.id || incoming.id,
        ...(preferTaskId ? { taskId: preferTaskId } : {}),
        ...(preferOutputIndex !== undefined ? { outputIndex: preferOutputIndex } : {}),
        ...(storageKey ? { storageKey } : {}),
        ...(content ? { content } : {}),
        ...((incoming.assetId || existing.assetId) ? { assetId: incoming.assetId || existing.assetId } : {}),
        ...((incoming.naturalWidth || existing.naturalWidth) ? { naturalWidth: incoming.naturalWidth || existing.naturalWidth } : {}),
        ...((incoming.naturalHeight || existing.naturalHeight) ? { naturalHeight: incoming.naturalHeight || existing.naturalHeight } : {}),
        ...((incoming.bytes || existing.bytes) ? { bytes: incoming.bytes || existing.bytes } : {}),
        ...((incoming.mimeType || existing.mimeType) ? { mimeType: incoming.mimeType || existing.mimeType } : {}),
        ...(model ? { model } : {}),
        ...(size ? { size } : {}),
        ...(quality ? { quality } : {}),
        ...(prompt ? { prompt } : {}),
        ...(createdAt ? { createdAt } : {}),
    };
}

function sanitizeHistoryList(items: CanvasImageHistoryItem[] | undefined): CanvasImageHistoryItem[] {
    if (!Array.isArray(items) || !items.length) return [];
    const deduped: CanvasImageHistoryItem[] = [];
    for (const raw of items) {
        if (!raw || typeof raw !== "object") continue;
        const storageKey = normalizedStorageKey(raw.storageKey, raw.content);
        const ownedId = extractOwnedResourceId(storageKey, raw.content);
        const content = nonDataUrl(raw.content) || (ownedId ? resourceFileUrl(ownedId) : undefined);
        if (!storageKey && !content) continue;
        const id = raw.id?.trim() || buildImageHistoryItemId({ taskId: raw.taskId, outputIndex: raw.outputIndex, storageKey, content });
        if (!id) continue;
        const normalized: CanvasImageHistoryItem = {
            ...raw,
            id,
            ...(storageKey ? { storageKey } : { storageKey: undefined }),
            ...(content ? { content } : { content: undefined }),
        };
        const matchIndex = deduped.findIndex((candidate) => sameHistoryIdentity(candidate, normalized));
        if (matchIndex >= 0) {
            deduped[matchIndex] = mergeHistoryItem(deduped[matchIndex]!, normalized, { overwriteGeneration: false });
        } else {
            deduped.push(normalized);
        }
    }
    return deduped;
}

export function trimCanvasImageHistory(items: CanvasImageHistoryItem[], activeItem?: CanvasImageHistoryItem | null): CanvasImageHistoryItem[] {
    if (items.length <= MAX_CANVAS_IMAGE_HISTORY) return items;
    const next = [...items];
    while (next.length > MAX_CANVAS_IMAGE_HISTORY) {
        const removableIndex = activeItem
            ? next.findIndex((entry) => !sameHistoryIdentity(entry, activeItem))
            : 0;
        next.splice(removableIndex >= 0 ? removableIndex : 0, 1);
    }
    return next;
}

export function upsertCanvasImageHistory(
    existing: CanvasImageHistoryItem[] | undefined,
    item: CanvasImageHistoryItem | null | undefined,
    activeItem?: CanvasImageHistoryItem | null,
    options?: { overwriteGeneration?: boolean },
): CanvasImageHistoryItem[] {
    const list = sanitizeHistoryList(existing);
    if (!item) return trimCanvasImageHistory(list, activeItem);
    const normalized = sanitizeHistoryList([item])[0];
    if (!normalized) return trimCanvasImageHistory(list, activeItem);
    const matchIndex = list.findIndex((entry) => sameHistoryIdentity(entry, normalized));
    if (matchIndex >= 0) {
        list[matchIndex] = mergeHistoryItem(list[matchIndex]!, normalized, options);
    } else {
        list.push(normalized);
    }
    return trimCanvasImageHistory(list, activeItem ?? normalized);
}

export function snapshotNodeImageHistoryBeforeRegenerate(node: CanvasNodeData | undefined): CanvasImageHistoryItem[] | undefined {
    if (!node || node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) {
        return node?.metadata?.imageHistory;
    }
    const current = buildImageHistoryItemFromMetadata(node.metadata);
    // Do not overwrite already-archived generation fields with draft edits on node.metadata.
    const next = upsertCanvasImageHistory(node.metadata?.imageHistory, current, current, { overwriteGeneration: false });
    return next.length ? next : undefined;
}

export function resolveCanvasNodeImageHistory(
    node: CanvasNodeData,
    discoveredItems?: CanvasImageHistoryItem[],
): CanvasImageHistoryItem[] {
    if (node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) return [];
    const removedSet = new Set((node.metadata?.imageHistoryRemovedIds || []).map((id) => id.trim()).filter(Boolean));
    const current = buildImageHistoryItemFromMetadata(node.metadata);
    const persisted = (node.metadata?.imageHistory || []).filter(
        (entry) => !removedSet.has(entry.id) || Boolean(current && sameHistoryIdentity(entry, current)),
    );
    let list = upsertCanvasImageHistory(persisted, current, current, { overwriteGeneration: false });

    if (discoveredItems?.length) {
        const extra: CanvasImageHistoryItem[] = [];
        for (const candidate of sanitizeHistoryList(discoveredItems)) {
            if (removedSet.has(candidate.id) && !(current && sameHistoryIdentity(candidate, current))) {
                continue;
            }
            const existingIndex = list.findIndex((entry) => sameHistoryIdentity(entry, candidate));
            if (existingIndex >= 0) {
                list[existingIndex] = mergeHistoryItem(list[existingIndex]!, candidate, { overwriteGeneration: false });
            } else {
                extra.push(candidate);
            }
        }
        if (extra.length) {
            list = sanitizeHistoryList([...extra, ...list]);
            list.sort((left, right) => {
                const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
                const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
                if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
                    return leftTime - rightTime;
                }
                return 0;
            });
        }
    }
    return trimCanvasImageHistory(list, current);
}

export function activeImageHistoryIndex(node: CanvasNodeData, items: CanvasImageHistoryItem[]): number {
    if (!items.length) return -1;
    const current = buildImageHistoryItemFromMetadata(node.metadata);
    if (!current) return -1;
    return items.findIndex((entry) => sameHistoryIdentity(entry, current));
}

export function isActiveImageHistoryItem(node: CanvasNodeData, item: CanvasImageHistoryItem): boolean {
    const current = buildImageHistoryItemFromMetadata(node.metadata);
    return Boolean(current && sameHistoryIdentity(current, item));
}

export function resolveActiveCanvasImageHistoryItem(node: CanvasNodeData | null | undefined): CanvasImageHistoryItem | undefined {
    if (!node || node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) return undefined;
    const items = resolveCanvasNodeImageHistory(node);
    if (!items.length) return undefined;
    const index = activeImageHistoryIndex(node, items);
    return index >= 0 ? items[index] : undefined;
}

function findMatchingAssetId(nodeId: string, item: CanvasImageHistoryItem, assets?: Asset[]): string | undefined {
    const storedAssetId = item.assetId?.trim() || undefined;
    const resourceId = extractOwnedResourceId(item.storageKey, item.content);
    if (assets === undefined) {
        return storedAssetId;
    }
    if (storedAssetId) {
        const existing = assets.find((asset) => asset.id === storedAssetId);
        if (existing && (!resourceId || assetResourceId(existing) === resourceId)) {
            return existing.id;
        }
    }
    if (!resourceId) return storedAssetId;
    const nodeScoped = assets.find((asset) => asset.metadata?.nodeId === nodeId && assetResourceId(asset) === resourceId);
    if (nodeScoped) return nodeScoped.id;
    const matches = assets.filter((asset) => assetResourceId(asset) === resourceId);
    return matches.length === 1 ? matches[0]!.id : undefined;
}

export function getPrimarySwitchBlockReason(node: CanvasNodeData | null | undefined): PrimaryImageHistorySwitchBlockReason | null {
    if (!node || node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) return "invalid";
    if (node.metadata?.status === "loading") return "loading";
    if (canReloadCanvasNodeResource(node)) return "retrievable";
    return null;
}

export function planPrimaryImageHistorySwitch(
    node: CanvasNodeData,
    item: CanvasImageHistoryItem,
    assets?: Asset[],
): PrimaryImageHistorySwitchPlan {
    const blockReason = getPrimarySwitchBlockReason(node);
    if (blockReason) return { ok: false, reason: blockReason };

    const ownedId = extractOwnedResourceId(item.storageKey, item.content);
    const storageKey = normalizedStorageKey(item.storageKey, item.content);
    const content = nonDataUrl(item.content) || (ownedId ? resourceFileUrl(ownedId) : "");
    if (!storageKey && !content) return { ok: false, reason: "invalid" };

    // Snapshot the outgoing primary image before switching so pre-upgrade nodes never lose it.
    const baseHistory = snapshotNodeImageHistoryBeforeRegenerate(node) || [];
    const storedMatch = baseHistory.find((entry) => sameHistoryIdentity(entry, item));
    const resolvedAssetId = findMatchingAssetId(node.id, storedMatch ? mergeHistoryItem(storedMatch, item) : item, assets);
    const needsAssetEnsure = Boolean(ownedId && !resolvedAssetId);

    const incomingCandidate: CanvasImageHistoryItem = {
        ...item,
        ...(storageKey ? { storageKey } : {}),
        ...(content ? { content } : {}),
        assetId: resolvedAssetId,
    };
    const canonicalItem = storedMatch
        ? {
              ...mergeHistoryItem(storedMatch, incomingCandidate, { overwriteGeneration: false }),
              assetId: resolvedAssetId,
          }
        : incomingCandidate;

    const nextHistory = upsertCanvasImageHistory(baseHistory, canonicalItem, canonicalItem, { overwriteGeneration: false }).map((entry) =>
        sameHistoryIdentity(entry, canonicalItem) ? { ...entry, assetId: resolvedAssetId } : entry,
    );
    const nextRemovedIds = (node.metadata?.imageHistoryRemovedIds || []).filter((id) => id !== canonicalItem.id);

    const terminalErrorCleared = node.metadata?.status === "error"
        ? {
              errorDetails: undefined,
              generationErrorCode: undefined,
              generationErrorSummary: undefined,
              generationProviderCode: undefined,
              taskFailureDiagnostics: undefined,
              generationFailure: undefined,
              taskOutcome: undefined,
              taskOutcomeSource: undefined,
              failedPromptFingerprint: undefined,
              failedInputFingerprint: undefined,
          }
        : {};

    const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
    let updated: CanvasNodeData = {
        ...node,
        metadata: {
            ...node.metadata,
            ...terminalErrorCleared,
            status: "success",
            content: content || (ownedId ? resourceFileUrl(ownedId) : ""),
            storageKey,
            assetId: resolvedAssetId,
            naturalWidth: canonicalItem.naturalWidth || node.metadata?.naturalWidth,
            naturalHeight: canonicalItem.naturalHeight || node.metadata?.naturalHeight,
            bytes: canonicalItem.bytes ?? node.metadata?.bytes,
            mimeType: canonicalItem.mimeType || node.metadata?.mimeType,
            taskId: canonicalItem.taskId,
            taskOutputIndex: canonicalItem.taskId ? canonicalItem.outputIndex : undefined,
            ...(canonicalItem.createdAt ? { taskCompletedAt: canonicalItem.createdAt } : {}),
            imageHistory: nextHistory,
            imageHistoryRemovedIds: nextRemovedIds.length ? nextRemovedIds : undefined,
        },
    };

    if (canonicalItem.naturalWidth && canonicalItem.naturalHeight) {
        const fitted = fitImageNodeToDecodedSize(updated, canonicalItem.naturalWidth, canonicalItem.naturalHeight);
        if (fitted.width !== updated.width || fitted.height !== updated.height) {
            updated = {
                ...fitted,
                position: {
                    x: center.x - fitted.width / 2,
                    y: center.y - fitted.height / 2,
                },
            };
        } else {
            updated = fitted;
        }
    }

    return {
        ok: true,
        node: updated,
        item: canonicalItem,
        needsAssetEnsure,
    };
}

export function stampHistoryItemAssetId(node: CanvasNodeData, targetItem: CanvasImageHistoryItem, assetId: string): CanvasNodeData {
    const trimmed = assetId.trim();
    if (!trimmed) return node;
    const nextHistory = (node.metadata?.imageHistory || []).map((entry) =>
        sameHistoryIdentity(entry, targetItem) ? { ...entry, assetId: trimmed } : entry,
    );
    return {
        ...node,
        metadata: {
            ...node.metadata,
            ...(isActiveImageHistoryItem(node, targetItem) ? { assetId: trimmed } : {}),
            ...(nextHistory.length ? { imageHistory: nextHistory } : {}),
        },
    };
}

export function applyPrimaryImageHistoryItem(
    node: CanvasNodeData,
    item: CanvasImageHistoryItem,
    assets?: Asset[],
): CanvasNodeData {
    const plan = planPrimaryImageHistorySwitch(node, item, assets);
    if (!plan.ok) return node;
    // Refuse synchronous unbound resource swaps when an Asset catalog was provided;
    // UI callers must run switchNodePrimaryHistoryImage to ensure the Asset first.
    if (assets !== undefined && plan.needsAssetEnsure) return node;
    return plan.node;
}

export function stepCanvasNodeImageHistory(
    node: CanvasNodeData,
    offset: -1 | 1,
    assets?: Asset[],
    discoveredItems?: CanvasImageHistoryItem[],
): CanvasNodeData {
    const items = resolveCanvasNodeImageHistory(node, discoveredItems);
    if (!items.length) return node;
    const currentIndex = activeImageHistoryIndex(node, items);
    if (currentIndex >= 0 && items.length <= 1) return node;
    const nextIndex = currentIndex < 0
        ? (offset < 0 ? items.length - 1 : 0)
        : (currentIndex + offset + items.length) % items.length;
    const target = items[nextIndex];
    return target ? applyPrimaryImageHistoryItem(node, target, assets) : node;
}

export function restoreNodeMediaFromLatestImageHistory(node: CanvasNodeData, assets?: Asset[]): CanvasNodeData {
    if (node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) return node;
    if (canReloadCanvasNodeResource(node)) return node;
    const items = resolveCanvasNodeImageHistory(node);
    const latest = items[items.length - 1];
    if (!latest) return node;
    const idleBase: CanvasNodeData = {
        ...node,
        metadata: {
            ...node.metadata,
            status: "idle",
            taskClientOperationId: undefined,
            generationSubmissionState: undefined,
            taskStatus: latest.taskId ? "succeeded" : undefined,
            taskProgress: latest.taskId ? 100 : undefined,
            taskStage: undefined,
            taskOutcome: undefined,
            taskOutcomeSource: undefined,
        },
    };
    const plan = planPrimaryImageHistorySwitch(idleBase, latest, assets);
    // Never synchronously commit an owned resource lacking an Asset ID onto top-level metadata,
    // which ValidateCanvasMediaAssets would reject; leave the node idle with its history badge visible.
    if (!plan.ok || plan.needsAssetEnsure) {
        return {
            ...idleBase,
            metadata: {
                ...idleBase.metadata,
                taskStatus: undefined,
                taskProgress: undefined,
            },
        };
    }
    return plan.node;
}

export function removeCanvasImageHistoryItem(
    node: CanvasNodeData,
    itemId: string,
    assets?: Asset[],
    discoveredItems?: CanvasImageHistoryItem[],
): CanvasNodeData {
    if (node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) return node;
    const items = resolveCanvasNodeImageHistory(node, discoveredItems);
    if (items.length <= 1) return node;
    const targetIndex = items.findIndex((entry) => entry.id === itemId);
    if (targetIndex < 0) return node;
    const removingActive = isActiveImageHistoryItem(node, items[targetIndex]!);
    const remaining = items.filter((entry) => entry.id !== itemId);
    const nextRemovedIds = Array.from(
        new Set([...(node.metadata?.imageHistoryRemovedIds || []), itemId]),
    ).slice(-MAX_IMAGE_HISTORY_TOMBSTONES);
    const withRemaining: CanvasNodeData = {
        ...node,
        metadata: {
            ...node.metadata,
            imageHistory: remaining,
            imageHistoryRemovedIds: nextRemovedIds,
        },
    };
    if (!removingActive) return withRemaining;
    const fallback = remaining[Math.min(targetIndex, remaining.length - 1)] || remaining[remaining.length - 1];
    return fallback ? applyPrimaryImageHistoryItem(withRemaining, fallback, assets) : withRemaining;
}

export function syncDiscoveredCanvasNodeHistory(
    node: CanvasNodeData,
    discoveredItems?: CanvasImageHistoryItem[],
): CanvasNodeData {
    if (node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot || !discoveredItems?.length) {
        return node;
    }
    const persistedOnly = resolveCanvasNodeImageHistory(node);
    const merged = resolveCanvasNodeImageHistory(node, discoveredItems);
    if (merged.length <= 1 || merged.length === persistedOnly.length) {
        const allPresent = merged.every((entry) =>
            (node.metadata?.imageHistory || []).some((saved) => sameHistoryIdentity(saved, entry)),
        );
        if (allPresent) return node;
    }
    return {
        ...node,
        metadata: {
            ...node.metadata,
            imageHistory: merged,
        },
    };
}

export type ExecutePrimaryImageHistorySwitchOptions = {
    nodeId: string;
    targetItem: CanvasImageHistoryItem;
    readOnly?: boolean;
    silentSuccess?: boolean;
    getNodes: () => CanvasNodeData[];
    getAssets: () => Asset[];
    ensureAsset: (node: CanvasNodeData) => Promise<{ assetId?: string; confirmed: boolean }>;
    commitNode: (nodeId: string, committedNode: CanvasNodeData) => void;
    isAlive?: () => boolean;
    isAbortedError?: (error: unknown) => boolean;
    onBlocked?: (reason: PrimaryImageHistorySwitchBlockReason | "readonly") => void;
    onAssetError?: (message: string) => void;
    onAfterConfirmedAsset?: () => Promise<void> | void;
    onSuccess?: () => void;
};

export async function executePrimaryImageHistorySwitch({
    nodeId,
    targetItem,
    readOnly = false,
    silentSuccess = false,
    getNodes,
    getAssets,
    ensureAsset,
    commitNode,
    isAlive = () => true,
    isAbortedError = () => false,
    onBlocked,
    onAssetError,
    onAfterConfirmedAsset,
    onSuccess,
}: ExecutePrimaryImageHistorySwitchOptions): Promise<boolean> {
    if (readOnly) {
        onBlocked?.("readonly");
        return false;
    }
    const liveNode = getNodes().find((node) => node.id === nodeId);
    const plan = liveNode
        ? planPrimaryImageHistorySwitch(liveNode, targetItem, getAssets())
        : ({ ok: false, reason: "invalid" } as const);
    if (!plan.ok) {
        onBlocked?.(plan.reason);
        return false;
    }

    let ensuredAssetId: string | undefined;
    let ensuredConfirmed = false;
    if (plan.needsAssetEnsure) {
        try {
            const ensured = await ensureAsset(plan.node);
            if (!isAlive()) return false;
            if (!ensured.assetId || !ensured.confirmed) {
                onAssetError?.("素材入库未完成，暂无法切换主图，请稍后重试");
                return false;
            }
            ensuredAssetId = ensured.assetId;
            ensuredConfirmed = ensured.confirmed;
        } catch (error) {
            if (!isAlive() || isAbortedError(error)) return false;
            onAssetError?.(error instanceof Error ? error.message : "素材同步失败，暂无法切换主图");
            return false;
        }
    }

    if (!isAlive()) return false;
    const latestNode = getNodes().find((node) => node.id === nodeId);
    const latestPlan = latestNode
        ? planPrimaryImageHistorySwitch(latestNode, targetItem, getAssets())
        : ({ ok: false, reason: "invalid" } as const);
    if (!latestPlan.ok) {
        onBlocked?.(latestPlan.reason);
        return false;
    }
    const committedNode = ensuredAssetId
        ? stampHistoryItemAssetId(latestPlan.node, latestPlan.item, ensuredAssetId)
        : latestPlan.node;
    if (latestPlan.needsAssetEnsure && !committedNode.metadata?.assetId) {
        onAssetError?.("素材入库未完成，暂无法切换主图，请稍后重试");
        return false;
    }

    commitNode(nodeId, committedNode);
    if (ensuredConfirmed) {
        await onAfterConfirmedAsset?.();
    }
    if (!silentSuccess) {
        onSuccess?.();
    }
    return true;
}
