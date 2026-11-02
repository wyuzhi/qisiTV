import { buildSkillMentionReferences } from "@/services/skill-runtime";
import { canvasResourceMentionToken, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { Skill } from "@/services/api/skills";
import type { ModelCapabilityConfig } from "@/lib/model-capabilities";
import { creationAttachmentKind, type CreationAttachment, type CreationAttachmentKind, type CreationMode } from "./creation-assets";

export type CreationReference = CanvasResourceReference & {
    attachmentId?: string;
};

export function buildCreationMentionReferences(skills: Skill[], attachments: CreationAttachment[] = [], snapshots: CreationReference[] = []) {
    const counts = { image: 0, video: 0, audio: 0, file: 0 };
    const attachmentReferences = attachments.map((attachment) => {
        const kind = creationAttachmentKind(attachment);
        return attachmentReference(attachment, counts[kind]++);
    });
    const skillReferences = buildSkillMentionReferences(skills) as CreationReference[];
    const current = [...attachmentReferences, ...skillReferences];
    const currentIDs = new Set(current.map((reference) => reference.id));
    const restored = snapshots.filter((reference) => reference.kind === "skill" && !currentIDs.has(reference.id));
    return [...current, ...restored].map((reference) => ({ ...reference, active: true }));
}

export function selectedCreationReferences(prompt: string, references: CreationReference[]) {
    return references.filter((reference) => prompt.includes(canvasResourceMentionToken(reference)) || prompt.includes(`@${reference.label}`));
}

export type CreationReferenceLimits = Partial<Record<CreationAttachmentKind, number>>;

const referenceKindLabels: Record<CreationAttachmentKind, string> = {
    image: "参考图",
    video: "参考视频",
    audio: "参考音频",
    file: "参考文档",
};

const referenceKindUnits: Record<CreationAttachmentKind, string> = {
    image: "张",
    video: "个",
    audio: "段",
    file: "个",
};

export const creationReferenceKinds: CreationAttachmentKind[] = ["image", "video", "audio"];

export type CreationReferenceLimitOptions = {
    /** 所选模型是否显式配置过能力；未配置时拿到的是默认兜底值，不能当成“不支持附件”。 */
    textReferencesDeclared?: boolean;
    imageReferencesDeclared?: boolean;
    videoReferencesDeclared?: boolean;
};

// 官方文档对参考素材是按类型分别限制的（Seedance 2.0 为 9 张图 / 3 个视频 / 3 段音频，2.5 为 30/10/10），
// 所以这里直接跟随所选模型声明的 references，不再自己合成一个总数上限。
// 文字模式的参考素材是上下文附件：文字能力只声明图片、视频的引用上限，
// 音频和文档没有官方数量限制，因此不给它们编一个上限。
// 没有显式配置过能力的模型拿到的默认值不代表服务端不支持参考素材，
// 这里不设上限以免把用户已选好的附件和引用直接删掉。
export function creationReferenceLimitsFor(mode: CreationMode, capabilities: ModelCapabilityConfig, options: CreationReferenceLimitOptions = {}): CreationReferenceLimits {
    if (mode === "video") {
        if (options.videoReferencesDeclared === false) return {};
        const video = capabilities.video;
        if (!video || !video.operations.includes("image_to_video")) return { image: 0, video: 0, audio: 0 };
        return { image: video.references.maxImages, video: video.references.maxVideos, audio: video.references.maxAudios };
    }
    if (mode === "image") {
        if (options.imageReferencesDeclared === false) return { video: 0, audio: 0 };
        return { image: capabilities.image?.references.maxImages ?? 0, video: 0, audio: 0 };
    }
    if (!options.textReferencesDeclared) return {};
    return { image: capabilities.text?.references.maxImages ?? 0, video: capabilities.text?.references.maxVideos ?? 0 };
}

export function creationReferenceLimit(limits: CreationReferenceLimits, kind: CreationAttachmentKind) {
    const limit = limits[kind];
    if (limit === undefined || !Number.isFinite(limit)) return undefined;
    return Math.max(0, Math.floor(limit));
}

export function creationReferenceLimitMessage(limits: CreationReferenceLimits, kind: CreationAttachmentKind) {
    const limit = creationReferenceLimit(limits, kind);
    if (limit === undefined) return "";
    if (limit === 0) return `当前模型不支持${referenceKindLabels[kind]}`;
    return `${referenceKindLabels[kind]}最多 ${limit} ${referenceKindUnits[kind]}`;
}

export function creationReferenceLimitsLabel(limits: CreationReferenceLimits) {
    return creationReferenceKinds
        .filter((kind) => (creationReferenceLimit(limits, kind) ?? 0) > 0)
        .map((kind) => `${referenceKindLabels[kind]} ${creationReferenceLimit(limits, kind)} ${referenceKindUnits[kind]}`)
        .join("、");
}

export function creationReferenceCounts(attachments: CreationAttachment[]): Record<CreationAttachmentKind, number> {
    const counts: Record<CreationAttachmentKind, number> = { image: 0, video: 0, audio: 0, file: 0 };
    for (const attachment of attachments) counts[creationAttachmentKind(attachment)] += 1;
    return counts;
}

export function creationReferenceHasRoom(limits: CreationReferenceLimits, counts: Record<CreationAttachmentKind, number>, kind: CreationAttachmentKind) {
    const limit = creationReferenceLimit(limits, kind);
    return limit === undefined || counts[kind] < limit;
}

/** 只保留每类上限之内的素材，超出的按类型丢弃（返回被丢掉的那些用于提示）。 */
export function fitCreationAttachmentsToLimits(attachments: CreationAttachment[], limits: CreationReferenceLimits) {
    const counts: Record<CreationAttachmentKind, number> = { image: 0, video: 0, audio: 0, file: 0 };
    const kept: CreationAttachment[] = [];
    const dropped: CreationAttachment[] = [];
    for (const attachment of attachments) {
        const kind = creationAttachmentKind(attachment);
        const limit = creationReferenceLimit(limits, kind);
        if (limit !== undefined && counts[kind] >= limit) {
            dropped.push(attachment);
            continue;
        }
        counts[kind] += 1;
        kept.push(attachment);
    }
    return { attachments: kept, dropped };
}

/** 第一个超出官方上限的素材类型，用于提交前拦截（刚好用满是允许的）。 */
export function referenceOverflowKind(limits: CreationReferenceLimits, attachments: CreationAttachment[]) {
    const counts = creationReferenceCounts(attachments);
    return (Object.keys(counts) as CreationAttachmentKind[]).find((kind) => {
        const limit = creationReferenceLimit(limits, kind);
        return limit !== undefined && counts[kind] > limit;
    });
}

export function creationReferenceKindMessage(limits: CreationReferenceLimits, attachment: CreationAttachment) {
    return creationReferenceLimitMessage(limits, creationAttachmentKind(attachment));
}

/** 提交前的拦截提示，没有超出任何一类时返回空串。 */
export function reconcileCreationAttachmentLimit(attachments: CreationAttachment[], references: CreationReference[], limits: CreationReferenceLimits) {
    const { attachments: nextAttachments, dropped } = fitCreationAttachmentsToLimits(attachments, limits);
    if (dropped.length === 0) return { attachments, removedReferences: [] as CreationReference[] };

    const removedAttachmentIds = new Set(dropped.map((attachment) => attachment.id));
    const removedReferences = references.filter((reference) => reference.attachmentId && removedAttachmentIds.has(reference.attachmentId));
    return { attachments: nextAttachments, removedReferences };
}

export function removeCreationReferenceTokens(value: string, references: CreationReference[]) {
    return references.reduce((current, reference) => current.split(canvasResourceMentionToken(reference)).join("").split(`@${reference.label}`).join(""), value);
}

export function replaceCreationAttachmentReference(prompt: string, attachments: CreationAttachment[], targetAttachmentId: string, replacement: CreationAttachment) {
    const targetIndex = attachments.findIndex((attachment) => attachment.id === targetAttachmentId);
    if (targetIndex < 0) throw new Error("要替换的参考内容不存在");
    if (replacement.id === targetAttachmentId) return { prompt, attachments };

    const currentReferences = buildCreationMentionReferences([], attachments);
    const targetReference = currentReferences.find((reference) => reference.attachmentId === targetAttachmentId);
    if (!targetReference) throw new Error("要替换的提示词引用不存在");

    const remainingAttachments = attachments.filter((attachment) => attachment.id !== targetAttachmentId && attachment.id !== replacement.id);
    const insertionIndex = Math.min(targetIndex, remainingAttachments.length);
    const nextAttachments = [
        ...remainingAttachments.slice(0, insertionIndex),
        replacement,
        ...remainingAttachments.slice(insertionIndex),
    ];
    const replacementReference = buildCreationMentionReferences([], nextAttachments).find((reference) => reference.attachmentId === replacement.id);
    if (!replacementReference) throw new Error("替换后的提示词引用无效");

    const targetToken = canvasResourceMentionToken(targetReference);
    const replacementToken = canvasResourceMentionToken(replacementReference);
    const normalizedPrompt = replaceVisibleReferenceLabel(prompt, targetReference.label, replacementToken);
    return {
        prompt: normalizedPrompt.split(targetToken).join(replacementToken),
        attachments: nextAttachments,
    };
}

export function displayCreationPrompt(prompt: string, references: CreationReference[]) {
    return references.reduce((value, reference) => value.split(canvasResourceMentionToken(reference)).join(`@${reference.label}`), prompt);
}

export function expandCreationPrompt(prompt: string, references: CreationReference[], attachments: CreationAttachment[] = []) {
    const visiblePrompt = displayCreationPrompt(prompt, references).trim();
    if (!references.length) return visiblePrompt;

    const contexts: string[] = [];
    const mediaMappings: string[] = [];
    const attachmentPositions = new Map(attachments.map((attachment, index) => [attachment.id, index + 1]));
    references.forEach((reference) => {
        if (reference.attachmentId) {
            const position = attachmentPositions.get(reference.attachmentId);
            const kindLabel = reference.kind === "video" ? "视频" : reference.kind === "audio" ? "音频" : reference.kind === "text" ? "文件" : "图片";
            mediaMappings.push(`- @${reference.label}：参考${kindLabel} ${position || 1}`);
            return;
        }
    });

    if (mediaMappings.length) contexts.push(`【资源对应关系】\n${mediaMappings.join("\n")}`);
    return [...contexts, `【创作要求】\n${visiblePrompt}`].filter(Boolean).join("\n\n");
}

function attachmentReference(attachment: CreationAttachment, index: number): CreationReference {
    const kind = creationAttachmentKind(attachment);
    const label = kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "file" ? "文件" : "图片";
    return {
        id: `upload:${attachment.id}`,
        nodeId: `upload:${attachment.id}`,
        kind: kind === "file" ? "text" : kind,
        label: `${label}${index + 1}`,
        title: "当前参考内容",
        previewUrl: attachment.previewUrl || ("dataUrl" in attachment ? attachment.dataUrl : attachment.url),
        storageKey: attachment.storageKey,
        active: true,
        attachmentId: attachment.id,
        mentionToken: `@[attachment:${attachment.id}]`,
    };
}

function replaceVisibleReferenceLabel(value: string, label: string, replacementToken: string) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.replace(new RegExp(`@${escapedLabel}(?=$|\\s|[,.!?;:，。！？；：、)\\]}】）])`, "gu"), replacementToken);
}
