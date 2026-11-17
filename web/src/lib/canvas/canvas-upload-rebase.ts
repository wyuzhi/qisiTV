import {
    clearReplacedGenerationTaskMetadata,
    equalSerializedValue,
    hasSettledNodeMedia,
    isFileUploadInProgress,
    isFileUploadOverlayActive,
    isNonEmptyMediaRef,
    stripStaleFileUploadMetadata,
    UPLOAD_REPLACEMENT_RESET_KEYS,
    UPLOAD_SETTLEMENT_METADATA_KEYS,
} from "@/lib/canvas/canvas-node-metadata-contract";
import { stripScriptDocumentExtension } from "@/lib/canvas/script-document-import";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const UPLOAD_OWNED_METADATA_KEY_SET = new Set<string>([
    ...UPLOAD_SETTLEMENT_METADATA_KEYS,
    ...UPLOAD_REPLACEMENT_RESET_KEYS,
]);

function hasDefinedValue(object: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined && object[key] !== null;
}

function hasUploadMediaPayload(node: CanvasNodeData | undefined): boolean {
    const meta = node?.metadata;
    return Boolean(meta && (isNonEmptyMediaRef(meta.content) || isNonEmptyMediaRef(meta.storageKey)));
}

function hasSettledUploadMedia(node: CanvasNodeData | undefined): boolean {
    return hasSettledNodeMedia(node?.metadata);
}

function sameUploadMediaPayload(left: CanvasNodeData | undefined, right: CanvasNodeData | undefined): boolean {
    return equalSerializedValue(left?.metadata?.content, right?.metadata?.content)
        && equalSerializedValue(left?.metadata?.storageKey, right?.metadata?.storageKey);
}

function sameNodeCenter(
    left: Pick<CanvasNodeData, "position" | "width" | "height"> | undefined,
    right: Pick<CanvasNodeData, "position" | "width" | "height"> | undefined,
): boolean {
    if (!left || !right) return false;
    const lx = left.position.x + left.width / 2;
    const ly = left.position.y + left.height / 2;
    const rx = right.position.x + right.width / 2;
    const ry = right.position.y + right.height / 2;
    return Math.abs(lx - rx) <= 1e-6 && Math.abs(ly - ry) <= 1e-6;
}

function hasExplicitManualSizeFlag(node: CanvasNodeData | undefined): boolean {
    return Boolean(node?.metadata?.manualSize || node?.metadata?.freeResize);
}

function uploadAttemptIdOf(node: CanvasNodeData | undefined): string {
    return node?.metadata?.fileUploadAttemptId?.trim() || "";
}

function isExplicitNonUploadNode(node: CanvasNodeData | undefined): boolean {
    const meta = node?.metadata;
    if (!meta) return false;
    if (meta.nodeRole === "generator" || Boolean(meta.taskId)) return true;
    return meta.resultOrigin === "generated"
        || meta.resultOrigin === "derived"
        || meta.resultOrigin === "library"
        || meta.resultOrigin === "imported";
}

function isSettledExplicitUploadNode(node: CanvasNodeData | undefined): boolean {
    const meta = node?.metadata;
    if (!meta || isFileUploadInProgress(meta)) return false;
    const isNonGenOrigin = meta.resultOrigin === "upload"
        || meta.resultOrigin === "imported"
        || meta.resultOrigin === "library"
        || Boolean(uploadAttemptIdOf(node));
    if (!isNonGenOrigin) return false;
    if (node?.type === CanvasNodeType.Script) {
        return meta.status === "success" && isNonEmptyMediaRef(meta.composerContent);
    }
    return hasSettledUploadMedia(node);
}

function sameNonGeneratedPayload(left: CanvasNodeData | undefined, right: CanvasNodeData | undefined): boolean {
    if (left?.type === CanvasNodeType.Script || right?.type === CanvasNodeType.Script) {
        return left?.type === right?.type
            && equalSerializedValue(left?.metadata?.composerContent, right?.metadata?.composerContent)
            && equalSerializedValue(left?.metadata?.storyboard, right?.metadata?.storyboard);
    }
    return sameUploadMediaPayload(left, right);
}

function hasGenerationTerminalFailure(meta: CanvasNodeData["metadata"] | undefined): boolean {
    if (!meta) return false;
    return meta.taskStatus === "failed"
        || meta.taskStatus === "cancelled"
        || meta.taskOutcome?.phase === "failed"
        || Boolean(meta.generationErrorCode);
}

function hasGenerationOrDerivedOwnership(node: CanvasNodeData | undefined): boolean {
    const meta = node?.metadata;
    if (!meta) return false;
    return meta.nodeRole === "generator"
        || Boolean(meta.taskId)
        || meta.resultOrigin === "generated"
        || meta.resultOrigin === "derived"
        || hasGenerationTerminalFailure(meta);
}

function isRemoteActiveGeneration(node: CanvasNodeData): boolean {
    const meta = node.metadata;
    if (!meta || isFileUploadOverlayActive(meta)) return false;
    return meta.status === "loading"
        || meta.generationSubmissionState === "submitting"
        || meta.generationSubmissionState === "unknown"
        || meta.taskStatus === "queued"
        || meta.taskStatus === "running"
        || meta.taskOutcome?.phase === "running"
        || meta.taskOutcome?.phase === "fetching"
        || meta.agentGenerationContinuation?.status === "pending";
}

function canUploadNodeGenerateInPlace(node: CanvasNodeData | undefined): boolean {
    if (!node) return false;
    if (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Script) return true;
    if (node.metadata?.generationResultPlacement) return node.metadata.generationResultPlacement === "replace-node";
    return Boolean(node.metadata?.copiedFromNodeId || node.metadata?.versionOfNodeId);
}

function sanitizeRemoteForUploadOwnedLocal(
    local: CanvasNodeData,
    remote: CanvasNodeData,
): CanvasNodeData {
    const cleaned = clearReplacedGenerationTaskMetadata(remote.metadata);
    const nextMeta: Record<string, unknown> = { ...(cleaned as Record<string, unknown>) };
    for (const key of UPLOAD_REPLACEMENT_RESET_KEYS) {
        delete nextMeta[key];
    }
    delete nextMeta.manualSize;
    delete nextMeta.freeResize;

    const localMeta = (local.metadata || {}) as Record<string, unknown>;
    const ownedKeys = local.type === CanvasNodeType.Script
        ? ([...UPLOAD_SETTLEMENT_METADATA_KEYS, "manualSize", "freeResize", "composerContent", "prompt", "storyboard"] as const)
        : ([...UPLOAD_SETTLEMENT_METADATA_KEYS, "manualSize", "freeResize"] as const);
    for (const key of ownedKeys) {
        if (hasDefinedValue(localMeta, key)) {
            nextMeta[key] = localMeta[key];
        } else {
            delete nextMeta[key];
        }
    }
    const localAttemptId = uploadAttemptIdOf(local);
    if (localAttemptId) {
        nextMeta.fileUploadAttemptId = localAttemptId;
    } else {
        delete nextMeta.fileUploadAttemptId;
    }
    nextMeta.status = "success";
    return {
        ...remote,
        ...(local.type === CanvasNodeType.Script ? { title: local.title } : {}),
        width: local.width,
        height: local.height,
        metadata: nextMeta as CanvasNodeData["metadata"],
    };
}

function withAttemptId(node: CanvasNodeData, attemptId: string): CanvasNodeData {
    return {
        ...node,
        metadata: {
            ...node.metadata,
            fileUploadAttemptId: attemptId,
        },
    };
}

function reconcileSettledUploadOwnership(
    base: CanvasNodeData | undefined,
    local: CanvasNodeData,
    remote: CanvasNodeData,
    conflict: { value: boolean },
): { local: CanvasNodeData; remote: CanvasNodeData } {
    if (isFileUploadInProgress(local.metadata) || isFileUploadInProgress(remote.metadata)) {
        return { local, remote };
    }
    const localAttemptId = uploadAttemptIdOf(local);
    const remoteAttemptId = uploadAttemptIdOf(remote);

    if (isSettledExplicitUploadNode(local)) {
        const baseMatchesLocalUpload = Boolean(
            base
            && isSettledExplicitUploadNode(base)
            && sameNonGeneratedPayload(local, base)
            && localAttemptId === uploadAttemptIdOf(base),
        );
        const remoteHasSettledGeneratedPayload = local.type === CanvasNodeType.Script
            ? remote.metadata?.status === "success" && !sameNonGeneratedPayload(remote, base)
            : hasSettledUploadMedia(remote) && !sameUploadMediaPayload(remote, base!);
        const remoteLegitimatelyGeneratedOverBase = baseMatchesLocalUpload
            && canUploadNodeGenerateInPlace(base)
            && (
                isRemoteActiveGeneration(remote)
                || (
                    remoteHasSettledGeneratedPayload
                    && remote.metadata?.resultOrigin !== "derived"
                    && !hasGenerationTerminalFailure(remote.metadata)
                    && !remoteAttemptId
                )
            );
        if (remoteLegitimatelyGeneratedOverBase) {
            return { local, remote };
        }
        const remoteReplacedUnchangedLocalWithNonTaskMedia = Boolean(
            base
            && (hasSettledUploadMedia(base) || isSettledExplicitUploadNode(base))
            && (hasSettledUploadMedia(remote) || isSettledExplicitUploadNode(remote))
            && !hasGenerationOrDerivedOwnership(remote)
            && sameNonGeneratedPayload(local, base)
            && !sameNonGeneratedPayload(remote, base),
        );
        if (remoteReplacedUnchangedLocalWithNonTaskMedia) {
            return { local, remote };
        }
        if (hasGenerationOrDerivedOwnership(remote)) {
            const sameMedia = local.type === CanvasNodeType.Script
                ? remote.metadata?.status === "success" && sameNonGeneratedPayload(local, remote)
                : hasSettledUploadMedia(remote) && sameUploadMediaPayload(local, remote);
            const remoteMatchesPreReplacementBase = Boolean(
                base
                && !isSettledExplicitUploadNode(base)
                && sameNonGeneratedPayload(remote, base)
                && equalSerializedValue(remote.metadata?.taskId, base.metadata?.taskId)
                && equalSerializedValue(remote.metadata?.taskStatus, base.metadata?.taskStatus),
            );
            if (!sameMedia && !remoteMatchesPreReplacementBase) {
                conflict.value = true;
            }
            return {
                local,
                remote: sanitizeRemoteForUploadOwnedLocal(local, remote),
            };
        }
    }

    if (
        !hasSettledUploadMedia(local)
        || !hasSettledUploadMedia(remote)
        || isExplicitNonUploadNode(local)
        || isExplicitNonUploadNode(remote)
    ) {
        return { local, remote };
    }
    if (!localAttemptId && !remoteAttemptId) {
        return { local, remote };
    }
    const remoteReplacedUnchangedLocal = Boolean(
        base
        && hasSettledUploadMedia(base)
        && sameUploadMediaPayload(local, base)
        && !sameUploadMediaPayload(remote, base),
    );
    if (remoteReplacedUnchangedLocal) {
        return { local, remote };
    }
    if (localAttemptId) {
        if (!remoteAttemptId) {
            return { local, remote: withAttemptId(remote, localAttemptId) };
        }
        if (remoteAttemptId !== localAttemptId) {
            conflict.value = true;
            return { local, remote: withAttemptId(remote, localAttemptId) };
        }
        return { local, remote };
    }
    if (remoteAttemptId && sameUploadMediaPayload(local, remote)) {
        return { local: withAttemptId(local, remoteAttemptId), remote };
    }
    return { local, remote };
}

function sameUploadingLineage(left: CanvasNodeData, right: CanvasNodeData): boolean {
    if (left.type !== right.type) return false;
    const leftAttemptId = uploadAttemptIdOf(left);
    const rightAttemptId = uploadAttemptIdOf(right);
    if (leftAttemptId || rightAttemptId) {
        return Boolean(leftAttemptId) && leftAttemptId === rightAttemptId;
    }
    const leftHasMedia = hasUploadMediaPayload(left);
    const rightHasMedia = hasUploadMediaPayload(right);
    if (!leftHasMedia && !rightHasMedia) return true;
    return leftHasMedia && rightHasMedia && sameUploadMediaPayload(left, right);
}

function restorePersistedUploadingManualGeometry(
    baseItem: CanvasNodeData | undefined,
    node: CanvasNodeData,
): CanvasNodeData {
    if (
        !baseItem
        || hasSettledUploadMedia(baseItem)
        || !hasExplicitManualSizeFlag(baseItem)
        || !isFileUploadInProgress(node.metadata)
        || !sameUploadingLineage(baseItem, node)
        || hasExplicitManualSizeFlag(node)
        || node.metadata?.manualSize === false
        || node.metadata?.freeResize === false
    ) {
        return node;
    }
    const nextMeta: Record<string, unknown> = { ...((node.metadata || {}) as Record<string, unknown>) };
    if (baseItem.metadata?.manualSize !== undefined) nextMeta.manualSize = baseItem.metadata.manualSize;
    if (baseItem.metadata?.freeResize !== undefined) nextMeta.freeResize = baseItem.metadata.freeResize;
    return {
        ...node,
        width: baseItem.width,
        height: baseItem.height,
        position: baseItem.position,
        metadata: nextMeta as CanvasNodeData["metadata"],
    };
}

function canSettleUploadingAgainstSettled(
    baseItem: CanvasNodeData | undefined,
    uploadingItem: CanvasNodeData,
    settledItem: CanvasNodeData,
    settledSide: "local" | "remote",
): boolean {
    if (!isFileUploadInProgress(uploadingItem.metadata) || !hasSettledUploadMedia(settledItem)) {
        return false;
    }
    const uploadingAttemptId = uploadAttemptIdOf(uploadingItem);
    const settledAttemptId = uploadAttemptIdOf(settledItem);
    if (uploadingAttemptId || settledAttemptId) {
        if (uploadingAttemptId && uploadingAttemptId === settledAttemptId) {
            return true;
        }
        // 本地与 base 已是同一完成媒体，而远端仍停留在更早的占位快照时，允许将滞后远端还原回完成态。
        if (
            settledSide === "local"
            && hasSettledUploadMedia(baseItem)
            && sameUploadMediaPayload(baseItem, settledItem)
            && (!hasUploadMediaPayload(uploadingItem) || sameUploadMediaPayload(uploadingItem, settledItem))
        ) {
            return true;
        }
        return false;
    }
    if (!hasUploadMediaPayload(uploadingItem)) {
        return true;
    }
    // 缺少 fileUploadAttemptId 的历史快照：本地已结算时保护本地完成态；
    // 远端同媒体快照无法区分“已完成本轮上传”与“占位保留的旧媒体”，一律不提前把在途替换结算为 success。
    if (sameUploadMediaPayload(uploadingItem, settledItem)) {
        return settledSide === "local";
    }
    // 若对侧在 base(B) 之后已完成一次替换 B->C 并紧接着发起二次替换 C->D（此时 uploadingItem 保留上一版媒体 C、
    // status=undefined、fileUpload="uploading"），而当前 settledItem 仍停留在 base(B)，不能把 C->D 的在途替换误结算回旧的 B；
    // 若 settledItem 已推进到另一版完成媒体 D（与 base(B)、uploading(C) 均不同），也属于双端并发分叉而非同一轮上传的完成态。
    if (hasSettledUploadMedia(baseItem) && sameUploadMediaPayload(baseItem, settledItem)) {
        return false;
    }
    return Boolean(
        baseItem
        && (hasSettledUploadMedia(baseItem) || isFileUploadInProgress(baseItem.metadata))
        && hasUploadMediaPayload(baseItem)
        && sameUploadMediaPayload(baseItem, uploadingItem),
    );
}

function settleUploadingPair(
    baseItem: CanvasNodeData | undefined,
    uploadingItem: CanvasNodeData,
    settledItem: CanvasNodeData,
    settledSide: "local" | "remote",
): { uploading: CanvasNodeData; settled: CanvasNodeData } {
    // base 已是完成媒体，而对侧仍是旧的上传占位（无媒体的初始占位，或本地已结算同媒体后滞后的远端同媒体占位）：
    // 直接将旧占位还原到 base，防止旧占位的标题、位置、尺寸或备注倒推覆盖已完成编辑。
    if (
        baseItem
        && hasSettledUploadMedia(baseItem)
        && (
            !hasUploadMediaPayload(uploadingItem)
            || (
                settledSide === "local"
                && sameUploadMediaPayload(baseItem, settledItem)
                && sameUploadMediaPayload(uploadingItem, settledItem)
            )
        )
    ) {
        return {
            uploading: {
                ...baseItem,
                ...(uploadingItem.createdAt ? { createdAt: uploadingItem.createdAt } : {}),
                ...(uploadingItem.updatedAt ? { updatedAt: uploadingItem.updatedAt } : {}),
            },
            settled: settledItem,
        };
    }

    const isReplacement = hasUploadMediaPayload(uploadingItem) || hasUploadMediaPayload(baseItem);
    const baseMeta = (baseItem?.metadata || {}) as Record<string, unknown>;
    const settledMeta = (settledItem.metadata || {}) as Record<string, unknown>;
    const uploadingMeta: Record<string, unknown> = { ...((uploadingItem.metadata || {}) as Record<string, unknown>) };
    const keysToCopy: readonly string[] = isReplacement
        ? [...UPLOAD_SETTLEMENT_METADATA_KEYS, ...UPLOAD_REPLACEMENT_RESET_KEYS]
        : UPLOAD_SETTLEMENT_METADATA_KEYS;
    for (const key of keysToCopy) {
        if (hasDefinedValue(settledMeta, key)) {
            uploadingMeta[key] = settledMeta[key];
        } else {
            delete uploadingMeta[key];
        }
    }
    if (baseItem) {
        for (const key of Object.keys(baseMeta)) {
            if ((key === "manualSize" || key === "freeResize") && hasExplicitManualSizeFlag(uploadingItem)) {
                continue;
            }
            if (!UPLOAD_OWNED_METADATA_KEY_SET.has(key) && !hasDefinedValue(uploadingMeta, key) && hasDefinedValue(settledMeta, key)) {
                uploadingMeta[key] = baseMeta[key];
            }
        }
    }
    if (
        settledItem.type === "text"
        && !hasDefinedValue(uploadingMeta, "prompt")
        && hasDefinedValue(settledMeta, "prompt")
        && settledMeta.prompt === settledMeta.content
    ) {
        uploadingMeta.prompt = settledMeta.prompt;
    }

    let settledNext = settledItem;
    let resolvedUploadingTitle = uploadingItem.title;
    if (!baseItem && settledItem.type === "text" && stripScriptDocumentExtension(uploadingItem.title) === settledItem.title) {
        resolvedUploadingTitle = settledItem.title;
    }

    const resizedDuringActiveUpload = Boolean(
        baseItem
        && isFileUploadInProgress(baseItem.metadata)
        && (uploadingItem.width !== baseItem.width || uploadingItem.height !== baseItem.height),
    );
    const manualResizeOverSettledBase = Boolean(
        hasSettledUploadMedia(baseItem)
        && hasExplicitManualSizeFlag(uploadingItem)
        && (
            !hasExplicitManualSizeFlag(baseItem)
            || uploadingItem.width !== baseItem!.width
            || uploadingItem.height !== baseItem!.height
        ),
    );
    const keepUploadingManualResize = (
        (!hasSettledUploadMedia(baseItem) && hasExplicitManualSizeFlag(uploadingItem))
        || resizedDuringActiveUpload
        || manualResizeOverSettledBase
    );
    const resolvedUploadingSize = keepUploadingManualResize
        ? { width: uploadingItem.width, height: uploadingItem.height }
        : { width: settledItem.width, height: settledItem.height };
    const uploadingCenteredPos = {
        x: uploadingItem.position.x + (uploadingItem.width - resolvedUploadingSize.width) / 2,
        y: uploadingItem.position.y + (uploadingItem.height - resolvedUploadingSize.height) / 2,
    };

    let resolvedUploadingPos = uploadingItem.position;
    if (keepUploadingManualResize) {
        if (uploadingItem.metadata?.manualSize !== undefined) {
            uploadingMeta.manualSize = uploadingItem.metadata.manualSize;
        }
        if (uploadingItem.metadata?.freeResize !== undefined) {
            uploadingMeta.freeResize = uploadingItem.metadata.freeResize;
        }
        const settledLacksManualSize = !hasExplicitManualSizeFlag(settledItem);
        const settledVideoAutoFitOverManual = settledItem.type === "video"
            && (sameNodeCenter(settledItem, baseItem) || sameNodeCenter(settledItem, uploadingItem));
        if (settledLacksManualSize || settledVideoAutoFitOverManual) {
            const nextSettledMeta: Record<string, unknown> = { ...(settledNext.metadata as Record<string, unknown>) };
            if (uploadingMeta.manualSize !== undefined) nextSettledMeta.manualSize = uploadingMeta.manualSize;
            if (uploadingMeta.freeResize !== undefined) nextSettledMeta.freeResize = uploadingMeta.freeResize;
            settledNext = {
                ...settledNext,
                ...resolvedUploadingSize,
                position: uploadingItem.position,
                metadata: nextSettledMeta as CanvasNodeData["metadata"],
            };
        }
    } else if (!baseItem) {
        resolvedUploadingPos = sameNodeCenter(uploadingItem, settledItem)
            ? settledItem.position
            : uploadingCenteredPos;
    } else {
        const uploadingDragged = !equalSerializedValue(uploadingItem.position, baseItem.position)
            && !sameNodeCenter(uploadingItem, baseItem);
        const settledAutoCenteredFromBase = equalSerializedValue(settledItem.position, baseItem.position)
            || sameNodeCenter(settledItem, baseItem)
            || sameNodeCenter(settledItem, { position: baseItem.position, width: uploadingItem.width, height: uploadingItem.height });
        if (!uploadingDragged || sameNodeCenter(uploadingItem, settledItem)) {
            resolvedUploadingPos = settledItem.position;
        } else if (settledAutoCenteredFromBase) {
            resolvedUploadingPos = uploadingCenteredPos;
            settledNext = { ...settledNext, position: uploadingCenteredPos };
        } else {
            resolvedUploadingPos = uploadingCenteredPos;
        }
    }

    const uploadingNext: CanvasNodeData = {
        ...uploadingItem,
        type: settledItem.type,
        title: resolvedUploadingTitle,
        ...resolvedUploadingSize,
        position: resolvedUploadingPos,
        metadata: uploadingMeta as CanvasNodeData["metadata"],
    };
    return { uploading: uploadingNext, settled: settledNext };
}

export function reconcileCanvasUploadNode(
    baseItem: CanvasNodeData | undefined,
    localItem: CanvasNodeData,
    remoteItem: CanvasNodeData,
    conflict: { value: boolean },
): { base: CanvasNodeData | undefined; local: CanvasNodeData; remote: CanvasNodeData } {
    const base = stripStaleFileUploadMetadata(baseItem);
    let local = restorePersistedUploadingManualGeometry(base, stripStaleFileUploadMetadata(localItem));
    let remote = restorePersistedUploadingManualGeometry(base, stripStaleFileUploadMetadata(remoteItem));

    if (canSettleUploadingAgainstSettled(base, remote, local, "local")) {
        const settled = settleUploadingPair(base, remote, local, "local");
        remote = settled.uploading;
        local = settled.settled;
        return { base, local, remote };
    }
    if (canSettleUploadingAgainstSettled(base, local, remote, "remote")) {
        const settled = settleUploadingPair(base, local, remote, "remote");
        local = settled.uploading;
        remote = settled.settled;
        return { base, local, remote };
    }

    const localSettledVsRemoteUploading = hasSettledUploadMedia(local) && isFileUploadInProgress(remote.metadata);
    const remoteSettledVsLocalUploading = hasSettledUploadMedia(remote) && isFileUploadInProgress(local.metadata);
    if (localSettledVsRemoteUploading || remoteSettledVsLocalUploading) {
        const settledSide = localSettledVsRemoteUploading ? local : remote;
        const activeReplacementOverUnchangedBase = hasSettledUploadMedia(base) && sameUploadMediaPayload(base, settledSide);
        const activeLocalReplacementOverAutosavedPlaceholder = remoteSettledVsLocalUploading
            && Boolean(base && isFileUploadInProgress(base.metadata) && sameUploadingLineage(base, local))
            && sameUploadMediaPayload(local, remote);
        if (activeLocalReplacementOverAutosavedPlaceholder) {
            remote = local;
        } else if (!activeReplacementOverUnchangedBase) {
            conflict.value = true;
            remote = local;
        }
        return { base, local, remote };
    }

    if (
        isFileUploadInProgress(local.metadata)
        && isFileUploadInProgress(remote.metadata)
        && sameUploadingLineage(local, remote)
    ) {
        const baseProgress = base?.metadata?.fileUploadProgress;
        const localProgress = local.metadata?.fileUploadProgress;
        const remoteProgress = remote.metadata?.fileUploadProgress;
        if (
            !equalSerializedValue(localProgress, remoteProgress)
            && !equalSerializedValue(localProgress, baseProgress)
            && !equalSerializedValue(remoteProgress, baseProgress)
        ) {
            const alignedMeta: Record<string, unknown> = { ...(remote.metadata as Record<string, unknown>) };
            if (localProgress !== undefined) {
                alignedMeta.fileUploadProgress = localProgress;
            } else {
                delete alignedMeta.fileUploadProgress;
            }
            remote = { ...remote, metadata: alignedMeta as CanvasNodeData["metadata"] };
        }
        return { base, local, remote };
    }

    const reconciledOwnership = reconcileSettledUploadOwnership(base, local, remote, conflict);
    return { base, local: reconciledOwnership.local, remote: reconciledOwnership.remote };
}
