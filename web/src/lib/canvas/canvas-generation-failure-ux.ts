import { canvasNodeVideoPreviewUrl } from "./canvas-media-preview";
import { canOpenCanvasNodePromptPanel } from "./canvas-node-semantics";
import { findRetrySourceNode } from "./canvas-project-generation-recovery";
import type { CanvasResourceReference } from "./canvas-resource-references";
import {
    generationInputFingerprint,
    generationPromptFingerprint,
    type GenerationErrorCategory,
    type GenerationFailureExplanation,
} from "@/lib/generation-error";
import { shouldConfirmUnchangedModerationRetry, type FailureReferenceTarget } from "@/lib/generation-failure-ux";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

type ReferenceMatchInput = {
    explanation: GenerationFailureExplanation;
    upstreamDetail?: string;
    mentionReferences?: CanvasResourceReference[];
    upstreamNodes?: CanvasNodeData[];
};

const REFERENCE_FALLBACK_CATEGORIES: ReadonlySet<GenerationErrorCategory> = new Set([
    "moderation_reference",
    "invalid_params",
    "input_inaccessible",
    "input_too_large",
]);

export function resolveCanvasGenerationInputSource(
    node: CanvasNodeData,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
) {
    const batchRoot = node.metadata?.batchRootId ? nodes.find((item) => item.id === node.metadata?.batchRootId) : undefined;
    const originalSourceId = node.metadata?.generatedFromNodeId || batchRoot?.metadata?.generatedFromNodeId;
    const originalSource = originalSourceId ? nodes.find((item) => item.id === originalSourceId) : undefined;
    const hasOwnMediaGenerationSetup = Boolean(
        node.type !== CanvasNodeType.Config &&
            !batchRoot &&
            (node.metadata?.composerContent || node.metadata?.prompt || connections.some((connection) => connection.toNodeId === node.id)),
    );
    const sourceNode =
        (originalSource?.type === CanvasNodeType.Config || !hasOwnMediaGenerationSetup ? originalSource : undefined) ||
        findRetrySourceNode(node.id, nodes, connections) ||
        batchRoot ||
        node;
    return { batchRoot, originalSourceId, originalSource, hasOwnMediaGenerationSetup, sourceNode };
}

function isNodeInsideLinkedAssetFolder(node: CanvasNodeData | undefined, nodes: CanvasNodeData[]): boolean {
    if (!node?.parentId) return false;
    const parent = nodes.find((item) => item.id === node.parentId);
    return Boolean(parent?.metadata?.folder?.assetFolderId);
}

export function resolveCanvasPromptEditTarget(
    node: CanvasNodeData,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
): CanvasNodeData | undefined {
    const { batchRoot, sourceNode } = resolveCanvasGenerationInputSource(node, nodes, connections);
    const candidate = sourceNode || batchRoot || node;
    if (isNodeInsideLinkedAssetFolder(candidate, nodes)) return undefined;
    if (canOpenCanvasNodePromptPanel(candidate)) return candidate;
    if (!isNodeInsideLinkedAssetFolder(node, nodes) && canOpenCanvasNodePromptPanel(node)) return node;
    return undefined;
}

type CanvasRevealHandlers = {
    nodes: CanvasNodeData[];
    readOnly?: boolean;
    focusCanvasNode: (nodeId: string, options?: { openPromptPanel?: boolean; openToolbar?: boolean }) => void;
    toggleFrameCollapsed: (frameId: string) => void;
    handleFrameToggle: (frameId: string) => void;
    toggleBatchExpanded: (batchRootId: string) => void;
};

export function revealCanvasTargetNode(
    nodeId: string,
    {
        nodes,
        readOnly = false,
        focusCanvasNode,
        toggleFrameCollapsed,
        handleFrameToggle,
        toggleBatchExpanded,
    }: CanvasRevealHandlers,
    focusOptions?: { openPromptPanel?: boolean; openToolbar?: boolean },
) {
    const target = nodes.find((item) => item.id === nodeId);
    if (!target) return;
    const parent = target.parentId ? nodes.find((item) => item.id === target.parentId) : undefined;
    const batchRoot = target.metadata?.batchRootId ? nodes.find((item) => item.id === target.metadata?.batchRootId) : undefined;
    if (readOnly) {
        if (parent?.metadata?.frame?.collapsed) {
            focusCanvasNode(parent.id, { openPromptPanel: false, openToolbar: false });
            return;
        }
        if (batchRoot && !batchRoot.metadata?.imageBatchExpanded) {
            focusCanvasNode(batchRoot.id, { openPromptPanel: false, openToolbar: false });
            return;
        }
        focusCanvasNode(nodeId, { openPromptPanel: false, openToolbar: false });
        return;
    }
    if (parent?.metadata?.frame?.collapsed) {
        if (parent.metadata.folder?.assetFolderId) {
            handleFrameToggle(parent.id);
            focusCanvasNode(parent.id, { openPromptPanel: false, openToolbar: false });
            return;
        }
        toggleFrameCollapsed(parent.id);
    }
    if (batchRoot && !batchRoot.metadata?.imageBatchExpanded) {
        toggleBatchExpanded(batchRoot.id);
    }
    focusCanvasNode(nodeId, focusOptions);
}

export function openCanvasGenerationInputEditor(
    node: CanvasNodeData,
    {
        connections,
        setDialogNodeId,
        ...revealHandlers
    }: CanvasRevealHandlers & {
        connections: CanvasConnection[];
        setDialogNodeId: (nodeId: string | null) => void;
    },
) {
    if (revealHandlers.readOnly) return;
    const promptTarget = resolveCanvasPromptEditTarget(node, revealHandlers.nodes, connections);
    if (!promptTarget) {
        const fallback = resolveCanvasGenerationInputSource(node, revealHandlers.nodes, connections).sourceNode || node;
        revealCanvasTargetNode(fallback.id, revealHandlers, { openPromptPanel: false, openToolbar: false });
        return;
    }
    revealCanvasTargetNode(promptTarget.id, revealHandlers, { openPromptPanel: true });
    setDialogNodeId(promptTarget.id);
}

type RetryReferenceItem = string | { id?: string; storageKey?: string; url?: string; dataUrl?: string };

function referenceItemKey(item: RetryReferenceItem): string {
    if (typeof item === "string") return item.trim();
    return (item.storageKey || item.url || item.dataUrl || item.id || "").trim();
}

function orderedRefsMatchStoredList(submittedRefs: RetryReferenceItem[], storedUrls?: string[]): boolean {
    if (!Array.isArray(storedUrls) || storedUrls.length !== submittedRefs.length) return false;
    return submittedRefs.every((item, index) => referenceItemKey(item) === (storedUrls[index] || "").trim());
}

export function evaluateCreativeRetryBaseline(
    metadata: Pick<CanvasNodeMetadata, "prompt" | "references" | "failedPromptFingerprint" | "failedInputFingerprint"> | undefined,
    category: GenerationErrorCategory,
    prompt: string,
    submittedRefs: RetryReferenceItem[],
): { canReplayStoredTask: boolean; unchangedModeration: boolean } {
    const hasInputFingerprint = Boolean(metadata?.failedInputFingerprint);
    const hasPromptFingerprint = Boolean(metadata?.failedPromptFingerprint);
    const storedRefs = metadata?.references;
    let canReplayStoredTask = false;
    if (hasInputFingerprint) {
        canReplayStoredTask = generationInputFingerprint(prompt, submittedRefs) === metadata?.failedInputFingerprint;
    } else if (hasPromptFingerprint) {
        const promptMatches = generationPromptFingerprint(prompt) === metadata?.failedPromptFingerprint;
        const refsMatch =
            (submittedRefs.length === 0 && !storedRefs?.length) ||
            (Boolean(storedRefs?.length) && orderedRefsMatchStoredList(submittedRefs, storedRefs));
        canReplayStoredTask = promptMatches && refsMatch;
    }

    let unchangedModeration = false;
    if (shouldConfirmUnchangedModerationRetry(category)) {
        if (hasInputFingerprint) {
            unchangedModeration = generationInputFingerprint(prompt, submittedRefs) === metadata?.failedInputFingerprint;
        } else if (hasPromptFingerprint) {
            const promptMatches = generationPromptFingerprint(prompt) === metadata?.failedPromptFingerprint;
            unchangedModeration =
                promptMatches && (!storedRefs?.length || orderedRefsMatchStoredList(submittedRefs, storedRefs));
        } else {
            const promptMatches = !metadata?.prompt?.trim() || prompt.trim() === metadata.prompt.trim();
            unchangedModeration =
                promptMatches && (!storedRefs?.length || orderedRefsMatchStoredList(submittedRefs, storedRefs));
        }
    }

    return { canReplayStoredTask, unchangedModeration };
}

type MediaCandidate = FailureReferenceTarget & {
    slotIndex: number;
};

function collectMediaCandidates(
    mentionReferences: CanvasResourceReference[] = [],
    upstreamNodes: CanvasNodeData[] = [],
): MediaCandidate[] {
    const byKindCount: Record<"image" | "video" | "audio", number> = { image: 0, video: 0, audio: 0 };
    const candidates: MediaCandidate[] = [];
    const seenNodeIds = new Set<string>();

    for (const reference of mentionReferences) {
        if (!reference.nodeId || (reference.kind !== "image" && reference.kind !== "video" && reference.kind !== "audio")) {
            continue;
        }
        if (seenNodeIds.has(reference.nodeId)) continue;
        seenNodeIds.add(reference.nodeId);
        byKindCount[reference.kind] += 1;
        const explicitIndex = reference.label.match(/(\d+)$/)?.[1];
        const slotIndex = explicitIndex ? Number(explicitIndex) : byKindCount[reference.kind];
        const prefix = reference.kind === "image" ? "图片" : reference.kind === "video" ? "视频" : "音频";
        candidates.push({
            nodeId: reference.nodeId,
            kind: reference.kind,
            slotIndex,
            badgeLabel: reference.label?.trim() || `${prefix}${slotIndex}`,
            title: reference.title?.trim() || reference.label?.trim() || `${prefix}${slotIndex}`,
            previewUrl: reference.previewUrl || undefined,
            storageKey: (reference.kind === "video" ? reference.previewStorageKey : reference.storageKey) || undefined,
        });
    }

    if (candidates.length > 0) return candidates;

    for (const node of upstreamNodes) {
        const kind: "image" | "video" | "audio" | null =
            node.type === CanvasNodeType.Image
                ? "image"
                : node.type === CanvasNodeType.Video
                  ? "video"
                  : node.type === CanvasNodeType.Audio
                    ? "audio"
                    : null;
        if (!kind || seenNodeIds.has(node.id)) continue;
        seenNodeIds.add(node.id);
        byKindCount[kind] += 1;
        const slotIndex = byKindCount[kind];
        const prefix = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
        candidates.push({
            nodeId: node.id,
            kind,
            slotIndex,
            badgeLabel: `${prefix}${slotIndex}`,
            title: node.title?.trim() || `${prefix}${slotIndex}`,
            previewUrl: (kind === "video" ? canvasNodeVideoPreviewUrl(node) : node.metadata?.previewContent || node.metadata?.content) || undefined,
            storageKey: (kind === "video" ? node.metadata?.videoPreview?.storageKey : kind === "image" ? node.metadata?.storageKey : undefined) || undefined,
        });
    }
    return candidates;
}

const CHINESE_ORDINAL_MAP: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseSlotToken(token: string): number {
    const trimmed = token.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    return CHINESE_ORDINAL_MAP[trimmed] || 0;
}

function collectNumberedIndices(text: string, patterns: RegExp[], zeroBased = false): number[] {
    const indices: number[] = [];
    for (const pattern of patterns) {
        const copy = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
        for (const match of text.matchAll(copy)) {
            const raw = parseSlotToken(match[1] || "");
            const parsed = zeroBased ? (/^\d+$/.test((match[1] || "").trim()) ? raw + 1 : 0) : raw;
            if (Number.isInteger(parsed) && parsed > 0 && !indices.includes(parsed)) {
                indices.push(parsed);
            }
        }
    }
    return indices;
}

export function matchFailureReferenceTargets({
    explanation,
    upstreamDetail,
    mentionReferences,
    upstreamNodes,
}: ReferenceMatchInput): FailureReferenceTarget[] {
    const candidates = collectMediaCandidates(mentionReferences, upstreamNodes);
    if (!candidates.length) return [];
    const haystack = [explanation.reason, explanation.action, upstreamDetail].filter(Boolean).join(" ");
    if (!haystack.trim()) return [];

    const imageSlots = [
        ...collectNumberedIndices(haystack, [
            /@图(?:片)?\s*(\d+)/gu,
            /第\s*(\d+|[一二三四五六七八九十]+)\s*(?:张|幅)?\s*(?:参考)?图(?:片)?/gu,
            /参考图(?:片)?\s*#?\s*(\d+)/gu,
            /\b(?:reference\s+)?images?\s*#?\s*([1-9]\d*)(?!\s*(?:px|p|x|%))\b/gi,
        ]),
        ...collectNumberedIndices(haystack, [/\b(?:input|reference)_images\[(\d+)\]/gi], true),
    ];
    const videoSlots = [
        ...collectNumberedIndices(haystack, [
            /@视频\s*(\d+)/gu,
            /第\s*(\d+|[一二三四五六七八九十]+)\s*(?:段|个)?\s*(?:参考)?视频/gu,
            /参考视频\s*#?\s*(\d+)/gu,
            /\b(?:reference\s+)?videos?\s*#?\s*([1-9]\d*)(?!\s*(?:px|p|x|%))\b/gi,
        ]),
        ...collectNumberedIndices(haystack, [/\b(?:input|reference)_videos\[(\d+)\]/gi], true),
    ];
    const audioSlots = [
        ...collectNumberedIndices(haystack, [
            /@音频\s*(\d+)/gu,
            /第\s*(\d+|[一二三四五六七八九十]+)\s*(?:段|个|条)?\s*(?:参考)?音频/gu,
            /参考音频\s*#?\s*(\d+)/gu,
            /\b(?:reference\s+)?audios?\s*#?\s*([1-9]\d*)\b/gi,
        ]),
        ...collectNumberedIndices(haystack, [/\b(?:input|reference)_audios\[(\d+)\]/gi], true),
    ];

    const matched: Array<MediaCandidate & { exact: boolean }> = [];
    const addCandidate = (candidate: MediaCandidate | undefined, exact: boolean) => {
        if (!candidate || matched.some((item) => item.nodeId === candidate.nodeId)) return;
        matched.push({ ...candidate, exact });
    };

    for (const idx of imageSlots) {
        addCandidate(candidates.find((item) => item.kind === "image" && item.slotIndex === idx), true);
    }
    for (const idx of videoSlots) {
        addCandidate(candidates.find((item) => item.kind === "video" && item.slotIndex === idx), true);
    }
    for (const idx of audioSlots) {
        addCandidate(candidates.find((item) => item.kind === "audio" && item.slotIndex === idx), true);
    }

    const contentImageUrl = /\bcontent\[\d+\]\.image_url\b/i.test(haystack);
    const contentVideoUrl = /\bcontent\[\d+\]\.video_url\b/i.test(haystack);
    const contentAudioUrl = /\bcontent\[\d+\]\.audio_url\b/i.test(haystack);
    if (!matched.length) {
        const imageCandidates = candidates.filter((item) => item.kind === "image");
        const videoCandidates = candidates.filter((item) => item.kind === "video");
        const audioCandidates = candidates.filter((item) => item.kind === "audio");
        if (contentImageUrl && imageCandidates.length === 1) addCandidate(imageCandidates[0], true);
        if (contentVideoUrl && videoCandidates.length === 1) addCandidate(videoCandidates[0], true);
        if (contentAudioUrl && audioCandidates.length === 1) addCandidate(audioCandidates[0], true);
    }

    if (!matched.length && REFERENCE_FALLBACK_CATEGORIES.has(explanation.category)) {
        const mentionsImage = contentImageUrl || /参考图|图片|首帧|尾帧|\binput_images\b/i.test(haystack);
        const mentionsVideo = contentVideoUrl || (/参考视频|视频|\binput_videos\b/i.test(haystack) && !/生成视频/.test(haystack));
        const mentionsAudio = contentAudioUrl || (/参考音频|音频|\binput_audios\b/i.test(haystack) && !/生成音频/.test(haystack));
        if (mentionsImage) candidates.filter((item) => item.kind === "image").forEach((item) => addCandidate(item, false));
        if (mentionsVideo) candidates.filter((item) => item.kind === "video").forEach((item) => addCandidate(item, false));
        if (mentionsAudio) candidates.filter((item) => item.kind === "audio").forEach((item) => addCandidate(item, false));
    }

    return matched.slice(0, 6).map(({ nodeId, kind, badgeLabel, title, previewUrl, storageKey, exact }) => ({
        nodeId,
        kind,
        badgeLabel,
        title,
        previewUrl,
        storageKey,
        exact,
    }));
}
