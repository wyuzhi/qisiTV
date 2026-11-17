import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { canvasNodeVideoPreviewUrl, canvasVideoAssetPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import { writeCanvasNodePrompt } from "@/lib/canvas/canvas-node-prompt";
import { getNodeResourceKind } from "@/lib/canvas/node-registry";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { Skill } from "@/services/api/skills";
import type { Asset, AssetCategory } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";

export type CanvasResourceKind = "image" | "video" | "audio" | "text" | "skill" | "character";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    /** 仅素材库视频在没有静态封面时使用的首帧回退源。 */
    mediaUrl?: string;
    storageKey?: string;
    /** 视频首帧是独立的图片资源，不能用视频 storageKey 解析。 */
    previewStorageKey?: string;
    /** Share display-only poster leases with canvas video nodes. */
    videoPreviewSource?: Pick<CanvasNodeData, "metadata">;
    /** 绘图预览保存在按项目隔离的本地绘图仓库，不复用普通图片 storageKey。 */
    drawingId?: string;
    drawingRevision?: number;
    text?: string;
    active: boolean;
    sourceType?: CanvasNodeTypeId;
    skill?: Skill;
    assetId?: string;
    category?: AssetCategory;
    mentionToken?: string;
};

/** Keep memoized nodes independent of unrelated reference-map rebuilds. */
export function reuseCanvasResourceReferences(previous: CanvasResourceReference[] | undefined, next: CanvasResourceReference[]) {
    if (!previous) return next;
    if (!previous.length && !next.length) return previous;
    const previousById = new Map(previous.map(reference => [reference.id, reference]));
    const shared = next.map(reference => {
        const old = previousById.get(reference.id);
        if (!old) return reference;
        const keys = Object.keys(reference) as Array<keyof CanvasResourceReference>;
        const equal = keys.length === Object.keys(old).length && keys.every(key => key === "videoPreviewSource"
            ? Boolean(old.videoPreviewSource) === Boolean(reference.videoPreviewSource) && old.videoPreviewSource?.metadata === reference.videoPreviewSource?.metadata
            : old[key] === reference[key]);
        return equal ? old : reference;
    });
    return shared.length === previous.length && shared.every((reference, index) => reference === previous[index]) ? previous : shared;
}

export function canvasSkillMentionToken(skillId: string) {
    return `@[skill:${skillId}]`;
}

/** Display the source name while keeping numbered labels stable for model prompts. */
export function canvasResourceDisplayName(reference: CanvasResourceReference) {
    return reference.title.trim() || reference.label;
}

export function canvasNodeMentionToken(nodeId: string) {
    return `@[node:${nodeId}]`;
}

export function canvasResourceMentionToken(reference: CanvasResourceReference) {
    if (reference.mentionToken) return reference.mentionToken;
    if (reference.kind === "skill" && reference.skill?.skillId) return canvasSkillMentionToken(reference.skill.skillId);
    if (reference.assetId) return `@[asset:${reference.assetId}]`;
    if (reference.nodeId) return canvasNodeMentionToken(reference.nodeId);
    return `@${reference.label}`;
}

/**
 * 消息里显式插入的素材库 token。素材菜单自己加载库数据，不在画布节点列表里。
 *
 * 后端只把这里列出的素材授予内置助手只读权限，所以必须由界面按用户原文推导，
 * 不能让模型自己声明「我要读哪些素材」。
 */
export function referencedAssetIdsInPrompt(prompt: string): string[] {
    return [...new Set(Array.from(prompt.matchAll(/@\[asset:([^\]\s]+)\]/g), (match) => match[1]))];
}

export function canonicalizeCanvasMediaSlotKind(rawKind: string): string {
    const lower = rawKind.toLowerCase();
    if (rawKind === "图" || lower === "image") return "图片";
    if (lower === "video") return "视频";
    if (lower === "audio") return "音频";
    return rawKind;
}

export const CANVAS_IMAGE_SLOT_KIND_SOURCE = String.raw`图片|图|[Ii][Mm][Aa][Gg][Ee]`;
export const CANVAS_VIDEO_SLOT_KIND_SOURCE = String.raw`视频|[Vv][Ii][Dd][Ee][Oo]`;
export const CANVAS_AUDIO_SLOT_KIND_SOURCE = String.raw`音频|[Aa][Uu][Dd][Ii][Oo]`;
export const CANVAS_SLOT_MENTION_SOURCE = `@(${CANVAS_IMAGE_SLOT_KIND_SOURCE}|${CANVAS_VIDEO_SLOT_KIND_SOURCE}|${CANVAS_AUDIO_SLOT_KIND_SOURCE}|文本|角色|绘图)(\\d+)`;

const CANVAS_SLOT_MENTION_EXACT = new RegExp(`^${CANVAS_SLOT_MENTION_SOURCE}$`, "u");
const BARE_MEDIA_SLOT_NAME_SOURCE = String.raw`(?:(?:图|图片|视频|音频|[Ii][Mm][Aa][Gg][Ee]|[Vv][Ii][Dd][Ee][Oo]|[Aa][Uu][Dd][Ii][Oo])\d+|(?:image|video|audio) \d+)`;
const BARE_MEDIA_SLOT_NAME_EXACT = new RegExp(`^(${CANVAS_IMAGE_SLOT_KIND_SOURCE}|${CANVAS_VIDEO_SLOT_KIND_SOURCE}|${CANVAS_AUDIO_SLOT_KIND_SOURCE}) ?(\\d+)$`, "u");

/** 将任意大小写或中英文缩写槽位引用（如 @iMaGe1、@图1、图片1）规整为标准标签（如 图片1）。 */
export function canonicalizeCanvasSlotLabel(rawTokenOrLabel: string): string | null {
    const trimmed = rawTokenOrLabel.trim();
    if (!trimmed) return null;
    const withAt = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    const match = CANVAS_SLOT_MENTION_EXACT.exec(withAt);
    return match ? `${canonicalizeCanvasMediaSlotKind(match[1])}${match[2]}` : null;
}

function canonicalizeBareSlotName(rawName: string): string | null {
    const match = BARE_MEDIA_SLOT_NAME_EXACT.exec(rawName.trim());
    return match ? `${canonicalizeCanvasMediaSlotKind(match[1])}${match[2]}` : null;
}

function canvasSlotMentionPatternSource(label: string): string | null {
    const trimmed = label.trim().replace(/^@/u, "");
    const imageMatch = /^图片(\d+)$/u.exec(trimmed);
    if (imageMatch) return `@(?:${CANVAS_IMAGE_SLOT_KIND_SOURCE})${imageMatch[1]}(?![A-Za-z0-9_])`;
    const videoMatch = /^视频(\d+)$/u.exec(trimmed);
    if (videoMatch) return `@(?:${CANVAS_VIDEO_SLOT_KIND_SOURCE})${videoMatch[1]}(?![A-Za-z0-9_])`;
    const audioMatch = /^音频(\d+)$/u.exec(trimmed);
    if (audioMatch) return `@(?:${CANVAS_AUDIO_SLOT_KIND_SOURCE})${audioMatch[1]}(?![A-Za-z0-9_])`;
    return null;
}

const CANVAS_MENTION_BOUNDARY_CHAR = /[\s,.!?;:，。！？；：、()[\]{}【】（）`"'|]/;

/** The editor and submission checks recognize the same explicit reference syntax. */
export function canvasGenerationMentionMatches(prompt: string) {
    return [...prompt.matchAll(new RegExp(`@\\[(node|asset):([^\\]]+)\\]|${CANVAS_SLOT_MENTION_SOURCE}`, "gu"))]
        .filter((match) => !match[3] || hasCanvasMentionBoundary(prompt, (match.index || 0) + match[0].length));
}

export function hasCanvasMentionBoundary(value: string, index: number) {
    const next = value[index];
    return !next || CANVAS_MENTION_BOUNDARY_CHAR.test(next);
}

const MARKDOWN_IMAGE_TABLE_SLOT_PREFIX = /^\s*\|\s*image\s+\d*(?:\s*\|)?$/iu;

function isInsideMarkdownImageTableSlot(prompt: string, matchStart: number, matchEnd: number) {
    const lineStart = prompt.lastIndexOf("\n", matchStart - 1) + 1;
    return MARKDOWN_IMAGE_TABLE_SLOT_PREFIX.test(prompt.slice(lineStart, matchEnd));
}

/** 将提示词内已连接素材的名称替换为对应引用；同名的每处指代都会保留为独立引用。 */
export function autoMentionCanvasResourceReferences(prompt: string, references: CanvasResourceReference[]) {
    const { exact, bySlot } = buildCanvasAutoMentionIndex(references, false);
    const exactNames = [...exact]
        .filter(([, reference]) => Boolean(reference))
        .map(([name]) => name)
        .sort((left, right) => right.length - left.length);
    const hasSlotAliases = [...bySlot.values()].some(Boolean);
    const patterns = [...exactNames.map(escapeRegExp), ...(hasSlotAliases ? [BARE_MEDIA_SLOT_NAME_SOURCE] : [])];
    if (!patterns.length) return prompt;

    const matcher = new RegExp(`(^|[^A-Za-z0-9_@])(${patterns.join("|")})(?![A-Za-z0-9_])`, "gu");
    // 分段替换，跳过已经是 @ 引用的片段；另记每段在原文里的起点，用来判断名字后面是否已有同一引用。
    let partOffset = 0;
    return prompt
        .split(/(@\[[^\]]+\]|@[^\s@,.;:!?，。；：！？、)\]}】）]+)/gu)
        .map((part) => {
            const startOfPart = partOffset;
            partOffset += part.length;
            if (part.startsWith("@")) return part;
            return part.replace(matcher, (match, prefix: string, name: string, offset: number, source: string) => {
                const absoluteStart = startOfPart + offset + prefix.length;
                if (isInsideMarkdownImageTableSlot(prompt, absoluteStart, absoluteStart + name.length)) return match;
                const canonicalSlot = exact.has(name) ? null : canonicalizeBareSlotName(name);
                const reference = exact.has(name) ? exact.get(name) : canonicalSlot ? bySlot.get(canonicalSlot) : undefined;
                if (!reference) return match;
                const token = canvasResourceMentionToken(reference);
                const nextCharacter = source[offset + match.length];
                const separator = needsAutoMentionSeparator(nextCharacter) ? " " : "";
                if (!keepsTypedResourceName(reference, name)) return `${prefix}${token}${separator}`;
                // 用户自己写的名字（角色名、素材标题）是提示词的语义，保留原文并把引用追加在后面。
                if (prompt.slice(startOfPart + offset + match.length).trimStart().startsWith(token)) return match;
                return `${prefix}${name} ${token}${separator}`;
            });
        })
        .join("");
}

export type CanvasResourceAutoLinkMatch = {
    reference: CanvasResourceReference;
    start: number;
    end: number;
    query: string;
};

export function findCanvasResourceAutoLinkMatch(prompt: string, cursor: number, references: CanvasResourceReference[]): CanvasResourceAutoLinkMatch | null {
    if (cursor <= 0 || cursor > prompt.length) return null;
    const prefix = prompt.slice(0, cursor);
    if (/@(?:\[[^\]]*|[^\s@,.;:!?，。；：！？、)\]}】）]*)$/u.test(prefix)) return null;
    const { exact, bySlot } = buildCanvasAutoMentionIndex(references, true);
    const seenNames = new Set<string>();
    const candidates: Array<{ name: string; reference: CanvasResourceReference; isBareOrder: boolean }> = [];
    for (const [name, reference] of exact) {
        if (!reference) continue;
        seenNames.add(name);
        candidates.push({ name, reference, isBareOrder: /^\d+$/u.test(name) });
    }
    const bareSlotMatch = new RegExp(`(${BARE_MEDIA_SLOT_NAME_SOURCE})$`, "u").exec(prefix);
    const bareCanonical = bareSlotMatch ? canonicalizeBareSlotName(bareSlotMatch[1]) : null;
    const bareReference = bareCanonical ? bySlot.get(bareCanonical) : null;
    if (bareSlotMatch && bareReference && !seenNames.has(bareSlotMatch[1])) {
        candidates.push({ name: bareSlotMatch[1], reference: bareReference, isBareOrder: false });
    }
    candidates.sort((left, right) => right.name.length - left.name.length);
    for (const candidate of candidates) {
        if (!prefix.endsWith(candidate.name)) continue;
        const start = cursor - candidate.name.length;
        const previous = prompt[start - 1];
        const next = prompt[cursor];
        if (previous === "@") continue;
        if (next && /[A-Za-z0-9_]/u.test(next)) continue;
        if (isInsideMarkdownImageTableSlot(prompt, start, cursor)) continue;
        if (candidate.isBareOrder && previous && !/[\s,.!?;:，。！？；：、)\]}】）]/u.test(previous)) continue;
        if (candidate.isBareOrder && next && !/[\s,.!?;:，。！？；：、)\]}】）]/u.test(next)) continue;
        if (/^[A-Za-z0-9_]/u.test(candidate.name) && previous && /[A-Za-z0-9_]/u.test(previous)) continue;
        // 名字后面已经跟着同一个引用（保留名字时插入的），不再重复提示。
        if (prompt.slice(cursor).trimStart().startsWith(canvasResourceMentionToken(candidate.reference))) continue;
        return { reference: candidate.reference, start, end: cursor, query: candidate.name };
    }
    return null;
}

function registerUniqueReference(map: Map<string, CanvasResourceReference | null>, key: string, reference: CanvasResourceReference) {
    if (!key) return;
    if (!map.has(key)) {
        map.set(key, reference);
        return;
    }
    if (map.get(key)?.id !== reference.id) map.set(key, null);
}

function buildCanvasAutoMentionIndex(references: CanvasResourceReference[], includeBareNumber: boolean) {
    const exact = new Map<string, CanvasResourceReference | null>();
    const bySlot = new Map<string, CanvasResourceReference | null>();
    references
        .filter((reference) => reference.active && !reference.assetId && reference.kind !== "skill")
        .forEach((reference, index) => {
            [reference.label.trim(), reference.title.trim()]
                .filter((name) => name && (includeBareNumber || !/^\d+$/u.test(name)))
                .forEach((name) => registerUniqueReference(exact, name, reference));
            if (includeBareNumber) registerUniqueReference(exact, String(index + 1), reference);
            // Media labels are numbered per kind; the mixed shelf position is not an image slot.
            const trimmedLabel = reference.label.trim();
            if (/^图片(\d+)$/u.test(trimmedLabel) && reference.kind === "image") {
                registerUniqueReference(exact, `图${trimmedLabel.slice(2)}`, reference);
                registerUniqueReference(bySlot, trimmedLabel, reference);
            } else if (/^视频(\d+)$/u.test(trimmedLabel) && reference.kind === "video") {
                registerUniqueReference(bySlot, trimmedLabel, reference);
            } else if (/^音频(\d+)$/u.test(trimmedLabel) && reference.kind === "audio") {
                registerUniqueReference(bySlot, trimmedLabel, reference);
            }
        });
    return { exact, bySlot };
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function needsAutoMentionSeparator(nextCharacter: string | undefined) {
    return Boolean(nextCharacter && !/[\s,.!?;:，。！？；：、)\]}】）]/u.test(nextCharacter));
}

const AUTO_RESOURCE_LABEL = /^(角色|图片|图|视频|音频|绘图|文本|技能)\s*\d+$/u;

/**
 * 用户自己起的名字（角色名、素材标题）要保留原文，把引用追加在后面；
 * 自动编号「图片1 / 角色1」保留下来只会变成「图片1 @图片1」，仍然直接替换。
 */
function keepsTypedResourceName(reference: CanvasResourceReference, name: string) {
    return name === reference.title.trim() && !AUTO_RESOURCE_LABEL.test(name);
}

/**
 * @ 菜单选中和 Tab 补全时替换输入文字的内容：用户打出的是完整的角色名/素材标题，就保留名字再追加引用；
 * 只是搜索片段或自动编号时，仍只插入引用。
 */
export function canvasResourceReferenceInsertText(reference: CanvasResourceReference, typedName: string) {
    const token = canvasResourceMentionToken(reference);
    const name = typedName.trim();
    return keepsTypedResourceName(reference, name) ? `${name} ${token} ` : `${token} `;
}

const CANVAS_RESOURCE_MENTION_BOUNDARY = new RegExp(`(?:$|${CANVAS_MENTION_BOUNDARY_CHAR.source})`);

function replaceCanvasReferenceSlotOrToken(value: string, label: string, replacement: string) {
    const patternSource = canvasSlotMentionPatternSource(label);
    return patternSource
        ? value.replace(new RegExp(patternSource, "gu"), replacement)
        : replaceCanvasMentionToken(value, label.startsWith("@") ? label : `@${label}`, replacement);
}

function removeCanvasResourceReferenceTokens(prompt: string, references: CanvasResourceReference[]) {
    return compactRemovedCanvasMentionPrompt(references.reduce((value, reference) => {
        let next = removeCanvasMentionToken(value, canvasResourceMentionToken(reference));
        next = replaceCanvasReferenceSlotOrToken(next, reference.label, "");
        if (reference.nodeId && !reference.assetId && reference.kind !== "skill") {
            next = removeCanvasMentionToken(next, canvasNodeMentionToken(reference.nodeId));
        }
        return next;
    }, prompt));
}

function rewriteCanvasPromptAfterReferenceChange(prompt: string, previousReferences: CanvasResourceReference[], nextReferences: CanvasResourceReference[]) {
    const previousCanvasReferences = canvasNodeBoundReferences(previousReferences);
    const nextCanvasReferences = canvasNodeBoundReferences(nextReferences);
    if (!previousCanvasReferences.length || !canvasReferenceIdentityChanged(previousCanvasReferences, nextCanvasReferences)) return prompt;

    const nextByNodeId = new Map(nextCanvasReferences.map((reference) => [reference.nodeId, reference]));
    let value = prompt;
    previousCanvasReferences.forEach((reference) => {
        value = replaceCanvasReferenceSlotOrToken(value, reference.label, `@[legacy-slot:${reference.nodeId}]`);
    });
    previousCanvasReferences.filter((reference) => !nextByNodeId.has(reference.nodeId)).forEach((reference) => {
        value = removeCanvasMentionToken(value, canvasNodeMentionToken(reference.nodeId));
        value = removeCanvasMentionToken(value, `@[legacy-slot:${reference.nodeId}]`);
    });
    nextCanvasReferences.forEach((reference) => {
        value = replaceCanvasMentionToken(value, `@[legacy-slot:${reference.nodeId}]`, `@${reference.label}`);
    });
    return value === prompt ? prompt : compactRemovedCanvasMentionPrompt(value);
}

export function applyCanvasConnectionPromptSync(previousNodes: CanvasNodeData[], previousConnections: CanvasConnection[], nextNodes: CanvasNodeData[], nextConnections: CanvasConnection[]) {
    const previousMap = buildCanvasNodeMentionReferenceMap(previousNodes, previousConnections, nextNodes);
    const nextMap = buildCanvasNodeMentionReferenceMap(nextNodes, nextConnections, nextNodes);
    let changed = false;
    const mapped = nextNodes.map((node) => {
        const previousPrompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
        const nextPrompt = rewriteCanvasPromptAfterReferenceChange(previousPrompt, previousMap.get(node.id) || [], nextMap.get(node.id) || []);
        if (nextPrompt === previousPrompt) return node;
        changed = true;
        return writeCanvasNodePrompt(node, nextPrompt);
    });
    return changed ? mapped : nextNodes;
}

function canvasNodeBoundReferences(references: CanvasResourceReference[]) {
    return references.filter((reference) => reference.nodeId && !reference.assetId && reference.kind !== "skill");
}

function canvasReferenceIdentityChanged(previousReferences: CanvasResourceReference[], nextReferences: CanvasResourceReference[]) {
    if (previousReferences.length !== nextReferences.length) return true;
    const nextLabelByNodeId = new Map(nextReferences.map((reference) => [reference.nodeId, reference.label]));
    return previousReferences.some((reference) => nextLabelByNodeId.get(reference.nodeId) !== reference.label);
}

function removeCanvasMentionToken(value: string, token: string) {
    return replaceCanvasMentionToken(value, token, "");
}

export function replaceCanvasMentionToken(value: string, token: string, replacement: string) {
    if (!token) return value;
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Numbered media mentions can touch Chinese prose or another mention, but not a longer number or identifier.
    const boundary = CANVAS_SLOT_MENTION_EXACT.test(token)
        ? "(?![A-Za-z0-9_])"
        : token.startsWith("@[node:") || token.startsWith("@[legacy-slot:") ? "" : `(?=${CANVAS_RESOURCE_MENTION_BOUNDARY.source})`;
    return value.replace(new RegExp(`${escapedToken}${boundary}`, "gu"), replacement);
}

/**
 * 替换提示词中针对某参考对象的所有引用（包含 @图片1、@Image1 等大小写别名、@原标题、@[node:xxx]）。
 * 只要提示词中存在指向该对象的标记，同步全部替换为新标记。
 */
export function replaceCanvasReferenceMentions(
    prompt: string,
    oldReference: { label?: string; title?: string; nodeId?: string },
    replacementToken: string,
    replacementTitle?: string,
): string {
    let result = prompt;
    const cleanToken = replacementToken.startsWith("@") ? replacementToken : `@${replacementToken}`;
    const cleanOldLabel = oldReference.label?.replace(/^@/, "");
    if (cleanOldLabel) {
        result = replaceCanvasReferenceSlotOrToken(result, cleanOldLabel, cleanToken);
    }
    const cleanOldTitle = oldReference.title?.replace(/^@/, "");
    if (cleanOldTitle && cleanOldTitle !== cleanOldLabel) {
        const cleanRepTitle = replacementTitle?.replace(/^@/, "");
        const targetTitleToken = cleanRepTitle ? `@${cleanRepTitle}` : cleanToken;
        result = replaceCanvasMentionToken(result, `@${cleanOldTitle}`, targetTitleToken);
    }
    if (oldReference.nodeId) {
        result = replaceCanvasMentionToken(result, canvasNodeMentionToken(oldReference.nodeId), cleanToken);
    }
    return result;
}

function compactRemovedCanvasMentionPrompt(value: string) {
    return value
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[ \t]+|[ \t]+$/g, "")
        .replace(/^\n+|\n+$/g, "");
}

export function buildAssetMentionReferences(assets: Asset[]): CanvasResourceReference[] {
    return assets.flatMap((asset): CanvasResourceReference[] => {
        if (asset.kind === "model") return [];
        const kind: CanvasResourceKind = asset.kind === "entity" ? "character" : asset.kind;
        const previewUrl = asset.kind === "image" ? asset.data.dataUrl : asset.kind === "video" ? canvasVideoAssetPreviewUrl(asset.data.url, asset.coverUrl) : asset.coverUrl;
        const text = asset.kind === "text" ? asset.data.content : undefined;
        return [{
            id: `asset:${asset.id}`,
            nodeId: "",
            assetId: asset.id,
            kind,
            label: asset.title,
            title: asset.title,
            previewUrl,
            mediaUrl: asset.kind === "video" && !previewUrl ? asset.data.url : undefined,
            videoPreviewSource: asset.kind === "video" ? { metadata: { content: asset.data.url, storageKey: asset.data.storageKey } } : undefined,
            storageKey: "storageKey" in asset.data ? asset.data.storageKey : undefined,
            text,
            active: false,
            category: asset.category || "other",
        }];
    });
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], contextNodeId?: string | null, targetNodes?: CanvasNodeData[]) {
    const contextNodes = contextNodeId ? getMentionResourceNodes(contextNodeId, nodes, connections) : [];
    const sourceNodes = targetNodes ? uniqueCanvasNodes([...targetNodes, ...contextNodes]) : nodes;
    const globalReferences = labelResourceNodes(sourceNodes.filter(isResourceNode), false);
    const activeByNodeId = new Map(labelResourceNodes(contextNodes, true).map((reference) => [reference.nodeId, reference]));
    return globalReferences.map((reference) => activeByNodeId.get(reference.nodeId) || reference);
}

/** Agent 的 @ 菜单覆盖整个画布，而不是只覆盖可作为生成输入的资源节点。 */
export function buildCanvasAgentMentionReferences(nodes: CanvasNodeData[]): CanvasResourceReference[] {
    return nodes.map((node, index) => {
        const kind = resourceKind(node) || "text";
        const fallbackTitle = `节点 ${index + 1}`;
        return {
            id: node.id,
            nodeId: node.id,
            kind,
            label: node.title?.trim() || fallbackTitle,
            title: node.title?.trim() || fallbackTitle,
            previewUrl: node.metadata?.workflowKind === "character"
                ? node.metadata.characterCoverUrl
                : node.type === CanvasNodeType.Drawing
                  ? node.metadata?.drawingPreviewUrl
                  : node.type === CanvasNodeType.Video
                    ? canvasNodeVideoPreviewUrl(node)
                    : node.metadata?.previewContent || node.metadata?.content,
            storageKey: node.metadata?.storageKey,
            previewStorageKey: node.type === CanvasNodeType.Video ? node.metadata?.videoPreview?.storageKey : undefined,
            videoPreviewSource: node.type === CanvasNodeType.Video ? { metadata: node.metadata } : undefined,
            drawingId: node.type === CanvasNodeType.Drawing ? node.metadata?.drawingId : undefined,
            drawingRevision: node.type === CanvasNodeType.Drawing ? node.metadata?.drawingRevision : undefined,
            text: node.metadata?.content || node.metadata?.composerContent || node.metadata?.prompt || node.title,
            active: true,
            sourceType: node.type,
            mentionToken: canvasNodeMentionToken(node.id),
        };
    });
}

function uniqueCanvasNodes(nodes: CanvasNodeData[]) {
    const seen = new Set<string>();
    return nodes.filter((node) => {
        if (seen.has(node.id)) return false;
        seen.add(node.id);
        return true;
    });
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true);
}

export function buildCanvasNodeMentionReferenceMap(nodes: CanvasNodeData[], connections: CanvasConnection[], targetNodes: CanvasNodeData[] = nodes) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const resourceInputsByTargetId = new Map<string, CanvasNodeData[]>();
    const configTargetBySourceId = new Map<string, string>();
    for (const connection of connections) {
        const source = nodeById.get(connection.fromNodeId);
        const target = nodeById.get(connection.toNodeId);
        if (!source || !target) continue;
        if (isResourceNode(source)) {
            const inputs = resourceInputsByTargetId.get(target.id) || [];
            inputs.push(source);
            resourceInputsByTargetId.set(target.id, inputs);
        }
        if (target.type === CanvasNodeType.Config && !configTargetBySourceId.has(source.id)) {
            configTargetBySourceId.set(source.id, target.id);
        }
    }

    const referencesByNodeId = new Map<string, CanvasResourceReference[]>();
    for (const node of targetNodes) {
        const configTargetId = configTargetBySourceId.get(node.id);
        const configInputs = configTargetId ? (resourceInputsByTargetId.get(configTargetId) || []).filter((input) => input.id !== node.id) : [];
        const ownInputs = resourceInputsByTargetId.get(node.id) || [];
        const inputs = configInputs.length ? configInputs : ownInputs.filter((input) => input.id !== node.id);
        referencesByNodeId.set(node.id, labelResourceNodes(inputs, true));
    }
    return referencesByNodeId;
}

export function buildOrderedCanvasResourceReferences(nodes: CanvasNodeData[], active = true) {
    return labelResourceNodes(nodes.filter(isResourceNode), active);
}

export function imageGenerationReferenceConnections(sourceNodeId: string, targetNodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], createId: () => string): CanvasConnection[] {
    if (!sourceNodeId || sourceNodeId === targetNodeId) return [];
    const existing = new Set(connections.filter((connection) => connection.toNodeId === targetNodeId).map((connection) => connection.fromNodeId));
    return getMentionResourceNodes(sourceNodeId, nodes, connections)
        .filter((node) => node.id !== sourceNodeId && node.id !== targetNodeId && !existing.has(node.id))
        .map((node) => ({ id: createId(), fromNodeId: node.id, toNodeId: targetNodeId }));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    // 没有入边时，资源节点可以把自身当作 @图片1 / @视频1，用于图生图、视频再编辑。
    // 有入边时仍只暴露上游，避免自身把槽位序号挤掉。
    const self = nodes.find((node) => node.id === nodeId);
    return self && isResourceNode(self) ? [self] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    return [];
}

/** 收集节点自身及其上游链路中的视频节点，用于时间线片段导入定位真正的视频源。 */
export function collectUpstreamVideoNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    const queue = [nodeId];
    const visited = new Set<string>();
    const result: CanvasNodeData[] = [];
    while (queue.length) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) continue;
        visited.add(currentId);
        const node = nodes.find((item) => item.id === currentId);
        if (node?.type === CanvasNodeType.Video && Boolean(node.metadata?.content || node.metadata?.storageKey)) result.push(node);
        connections.filter((connection) => connection.toNodeId === currentId).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return result;
}

/**
 * 该节点的直接上游素材节点（按连线取 fromNodeId，只保留构成素材的）。
 * 扩展节点经 CanvasNodeGraphContext 复用它，不要另写一份取上游的逻辑。
 */
export function getContextResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return connections
        .filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && isResourceNode(node)));
}

/**
 * 调整目标节点的素材输入边顺序。连接数组是引用编号的唯一顺序源；只替换相关
 * 输入边所在槽位，避免改变主链和其他节点的连线顺序。
 */
export function reorderCanvasResourceConnections(targetNodeId: string, orderedNodeIds: string[], nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const uniqueOrder = [...new Set(orderedNodeIds.filter(Boolean))];
    if (uniqueOrder.length < 2) return connections;
    const configNodeId = connections.find((connection) => connection.fromNodeId === targetNodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config)?.toNodeId;
    const configInputs = configNodeId ? getContextResourceNodes(configNodeId, nodes, connections).filter((node) => node.id !== targetNodeId) : [];
    const receiverId = configInputs.length ? configNodeId! : targetNodeId;
    const orderSet = new Set(uniqueOrder);
    const slots = connections
        .map((connection, index) => ({ connection, index }))
        .filter(({ connection }) => connection.toNodeId === receiverId && orderSet.has(connection.fromNodeId));
    if (slots.length !== uniqueOrder.length) return connections;
    const connectionBySource = new Map(slots.map(({ connection }) => [connection.fromNodeId, connection]));
    if (uniqueOrder.some((nodeId) => !connectionBySource.has(nodeId))) return connections;
    const reordered = uniqueOrder.map((nodeId) => connectionBySource.get(nodeId)!);
    if (slots.every(({ connection }, index) => connection === reordered[index])) return connections;
    const next = [...connections];
    slots.forEach(({ index }, orderIndex) => {
        next[index] = reordered[orderIndex];
    });
    return next;
}

function getConnectedConfigResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextResourceNodes(configConnection.toNodeId, nodes, connections).filter((node) => node.id !== nodeId);
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0, skill: 0, character: 0 };
    let drawingCount = 0;
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const index = node.type === CanvasNodeType.Drawing ? drawingCount++ : counts[kind]++;
        const label = node.type === CanvasNodeType.Drawing ? `绘图${index + 1}` : labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                previewUrl: node.metadata?.workflowKind === "character"
                    ? node.metadata.characterCoverUrl
                    : node.type === CanvasNodeType.Drawing
                      ? node.metadata?.drawingPreviewUrl
                      : node.type === CanvasNodeType.Video
                        ? canvasNodeVideoPreviewUrl(node)
                        : node.metadata?.previewContent || node.metadata?.content,
                storageKey: node.metadata?.storageKey,
                previewStorageKey: node.type === CanvasNodeType.Video ? node.metadata?.videoPreview?.storageKey : undefined,
                videoPreviewSource: node.type === CanvasNodeType.Video ? { metadata: node.metadata } : undefined,
                drawingId: node.type === CanvasNodeType.Drawing ? node.metadata?.drawingId : undefined,
                drawingRevision: node.type === CanvasNodeType.Drawing ? node.metadata?.drawingRevision : undefined,
                text: node.metadata?.workflowKind === "character" ? node.metadata.characterPrompt : node.type === CanvasNodeType.Text ? node.metadata?.content || node.metadata?.prompt : node.type === CanvasNodeType.Skill ? skillResourceText(node) : undefined,
                active,
                sourceType: node.type,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "character") return `角色${index + 1}`;
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return seedanceReferenceLabel("video", index);
    if (kind === "audio") return seedanceReferenceLabel("audio", index);
    if (kind === "skill") return `技能${index + 1}`;
    return `文本${index + 1}`;
}

export function isCanvasTextResourceNode(node: CanvasNodeData) {
    return resourceKind(node) === "text";
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    // 角色卡是跨类型覆盖：任何节点带上角色元数据都按角色处理，故先于按类型判定。
    if (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId) return "character";
    return getNodeResourceKind(node);
}

function skillResourceText(node: CanvasNodeData) {
    const skill = node.metadata?.skillSnapshot;
    if (!skill) return node.metadata?.content || "";
    return [skill.name, skill.description, skill.template, skill.outputContract].filter(Boolean).join("\n\n");
}
