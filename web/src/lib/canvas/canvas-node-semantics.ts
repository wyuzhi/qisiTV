import {
    CanvasNodeType,
    type CanvasMediaNodeRole,
    type CanvasMediaResultOrigin,
    type CanvasNodeData,
    type CanvasNodeMetadata,
} from "@/types/canvas";
import {
    hasConfirmedGeneratedMediaEvidence,
    hasSettledFileUploadMedia,
    hasStaleSettledFileUploadFlag,
    isFileUploadOverlayActive,
    stripStaleFileUploadMetadata,
} from "@/lib/canvas/canvas-node-metadata-contract";
import { normalizeVideoBoolean } from "@/lib/video-generation-options";

function normalizeAudioSetting(metadata: CanvasNodeMetadata): CanvasNodeMetadata {
    const generateAudio = normalizeVideoBoolean(metadata.generateAudio);
    return metadata.generateAudio === generateAudio ? metadata : { ...metadata, generateAudio };
}

export function isCanvasMediaNode(node: CanvasNodeData | null | undefined): boolean {
    return node?.type === CanvasNodeType.Image || node?.type === CanvasNodeType.Video || node?.type === CanvasNodeType.Audio;
}

export function hasMediaResource(node: CanvasNodeData): boolean {
    return Boolean(node.metadata?.content || node.metadata?.storageKey || node.metadata?.previewContent || isFileUploadOverlayActive(node.metadata));
}

/** 媒体卡片已有可用资源（含归档仅存 storageKey / previewContent 的卡片）时允许一键引用生成。 */
export function canQuickReferenceCanvasMediaNode(node: CanvasNodeData | null | undefined): boolean {
    if (!node || !isCanvasMediaNode(node) || node.metadata?.reusableWorkflow) return false;
    return Boolean(node.metadata?.content || node.metadata?.storageKey || node.metadata?.previewContent);
}

/** Reads explicit semantics first and falls back to legacy persisted data. */
export function canvasMediaNodeRole(node: CanvasNodeData | null | undefined): CanvasMediaNodeRole | null {
    if (!node || !isCanvasMediaNode(node)) return null;
    return node.metadata?.nodeRole || (hasMediaResource(node) ? "result" : "generator");
}

export function isCanvasMediaResultNode(node: CanvasNodeData | null | undefined): boolean {
    return canvasMediaNodeRole(node) === "result" || Boolean(node && isCanvasMediaNode(node) && hasMediaResource(node));
}

export function mediaGeneratorMetadata(metadata: CanvasNodeMetadata = {}): CanvasNodeMetadata {
    const normalized = normalizeAudioSetting(metadata);
    if ("fileUploadAttemptId" in normalized) {
        const { fileUploadAttemptId: _attempt, ...rest } = normalized;
        return { ...rest, nodeRole: "generator", resultOrigin: undefined };
    }
    return { ...normalized, nodeRole: "generator", resultOrigin: undefined };
}

export function mediaResultMetadata(origin: CanvasMediaResultOrigin, metadata: CanvasNodeMetadata = {}): CanvasNodeMetadata {
    const normalized = normalizeAudioSetting(metadata);
    if (origin !== "upload" && origin !== "imported" && "fileUploadAttemptId" in normalized) {
        const { fileUploadAttemptId: _attempt, ...rest } = normalized;
        return { ...rest, nodeRole: "result", resultOrigin: origin };
    }
    return { ...normalized, nodeRole: "result", resultOrigin: origin };
}

function isDerivedMediaResult(node: CanvasNodeData): boolean {
    const metadata = node.metadata;
    return Boolean(
        metadata?.audioExtractSourceNodeId
        || metadata?.videoTrimSourceNodeId
        || metadata?.videoCropSourceNodeId
        || metadata?.videoSegmentSourceNodeId
        || metadata?.videoAudioSourceNodeId
        || metadata?.videoFrameSourceNodeId
        || metadata?.videoRetakeSourceNodeId
        || metadata?.videoMergeSourceNodeIds?.length,
    );
}

/** Reads explicit provenance first and conservatively recovers legacy results. */
export function canvasMediaNodeOrigin(node: CanvasNodeData | null | undefined): CanvasMediaResultOrigin | null {
    if (!node || (canvasMediaNodeRole(node) !== "result" && !hasMediaResource(node))) return null;
    if (node.metadata?.resultOrigin) return node.metadata.resultOrigin;
    if (isDerivedMediaResult(node)) return "derived";
    if (node.metadata?.importSource) return "imported";
    if (
        node.metadata?.fileUploadAttemptId
        || isFileUploadOverlayActive(node.metadata)
        || hasStaleSettledFileUploadFlag(node.metadata)
    ) {
        return "upload";
    }
    if (node.metadata?.taskId) {
        if (hasSettledFileUploadMedia(node.metadata) && !hasConfirmedGeneratedMediaEvidence(node.metadata)) {
            return "unknown";
        }
        return "generated";
    }
    if (node.metadata?.assetId) return "library";
    return "unknown";
}

export function canvasMediaNodeSemanticLabel(node: CanvasNodeData | null | undefined): string | null {
    const role = canvasMediaNodeRole(node);
    if (!role) return null;
    if (role === "generator") return "生成节点";
    const origin = canvasMediaNodeOrigin(node);
    if (origin === "upload") return "已上传";
    if (origin === "library") return "素材库";
    if (origin === "generated") return "AI 生成";
    if (origin === "derived") return "处理结果";
    if (origin === "imported") return "已导入";
    return "结果";
}

export function canOpenCanvasNodePromptPanel(node: CanvasNodeData | null | undefined): boolean {
    if (!node || node.metadata?.reusableWorkflow || node.metadata?.workflowSlot) return false;
    if (isCanvasMediaNode(node)) {
        return canvasMediaNodeRole(node) === "generator" || canvasMediaNodeOrigin(node) === "generated";
    }
    // Generation is opt-in; viewers and containers never inherit a composer.
    return node.type === CanvasNodeType.Config || node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Skill;
}

/** Adds durable semantics to legacy media nodes without mutating the loaded snapshot. */
export function normalizeCanvasMediaNodeSemantics(node: CanvasNodeData): CanvasNodeData {
    const hadStaleUploadOrigin = Boolean(
        node.metadata
        && hasStaleSettledFileUploadFlag(node.metadata)
        && (!node.metadata.resultOrigin || node.metadata.resultOrigin === "upload"),
    );
    const cleaned = stripStaleFileUploadMetadata(node);
    if (!isCanvasMediaNode(cleaned)) return cleaned;
    const metadata = normalizeAudioSetting(cleaned.metadata || {});
    const nodeRole = canvasMediaNodeRole(cleaned);
    const inferredOrigin = canvasMediaNodeOrigin(cleaned);
    const resultOrigin = hadStaleUploadOrigin && (!inferredOrigin || inferredOrigin === "unknown")
        ? "upload"
        : inferredOrigin;
    if (cleaned === node && metadata === cleaned.metadata && metadata.nodeRole === nodeRole && metadata.resultOrigin === resultOrigin) return node;
    return {
        ...cleaned,
        metadata: {
            ...metadata,
            nodeRole: nodeRole || undefined,
            resultOrigin: resultOrigin || undefined,
        },
    };
}

export function normalizeCanvasMediaNodeSemanticsList(nodes: CanvasNodeData[]): CanvasNodeData[] {
    let changed = false;
    const normalized = nodes.map((node) => {
        const next = normalizeCanvasMediaNodeSemantics(node);
        changed ||= next !== node;
        return next;
    });
    return changed ? normalized : nodes;
}
