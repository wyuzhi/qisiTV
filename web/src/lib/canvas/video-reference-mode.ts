import { beefTVVideoContract } from "@/lib/beeftv-video-contracts";
import { CANVAS_IMAGE_SLOT_KIND_SOURCE } from "@/lib/canvas/canvas-resource-references";
import { isH3Model, isH3Style } from "@/lib/h3-video";
import { videoReferencesForOperation, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { isBeefTVModelRoute } from "@/lib/model-selection";
import type { CanvasNodeMetadata } from "@/types/canvas";

export { isBeefTVModelRoute };

export type VideoReferenceCandidate = {
    nodeId: string;
    kind: "text" | "image" | "video" | "audio" | "character" | "skill";
    label: string;
    title?: string;
    active?: boolean;
};

export type VideoReferenceModeState = {
    mode: "frames" | "all";
    canSelectFrames: boolean;
    canSelectAll: boolean;
    framesDisabledReason?: string;
    allDisabledReason?: string;
    endFrameSupported: boolean;
    startFrameNodeId?: string;
    endFrameNodeId?: string;
    promptFirstFrameNodeId?: string;
};

const IMAGE_SLOT_MENTION_SOURCE = `@(?:${CANVAS_IMAGE_SLOT_KIND_SOURCE})(\\d+)`;
const FIRST_FRAME_CLAUSE_BODY = `(?:以\\s*)?(?:@\\[node:([^\\]]+)\\]|${IMAGE_SLOT_MENTION_SOURCE})\\s*(?:[:：]?\\s*)?作为(?:本镜头(?:的)?|起始)?首帧(?:画面)?`;

const PROMPT_FIRST_FRAME_CLAUSE = new RegExp(`(?:^|[，,。；;\\n\\s])${FIRST_FRAME_CLAUSE_BODY}`, "u");

const GLOBAL_FIRST_FRAME_CLAUSE = new RegExp(`(?:^|[，,。；;\\s]+)${FIRST_FRAME_CLAUSE_BODY}[，,。；;\\s]*`, "gu");

export function findPromptFirstFrameNodeId(prompt: string, imageRefs: VideoReferenceCandidate[]): string | undefined {
    const activeImages = imageRefs.filter((ref) => ref.active !== false && ref.kind === "image");
    const match = PROMPT_FIRST_FRAME_CLAUSE.exec(prompt);
    if (!match) return undefined;
    const [, nodeId, imageIndex] = match;
    if (nodeId) {
        return activeImages.find((ref) => ref.nodeId === nodeId)?.nodeId;
    }
    if (imageIndex) {
        return activeImages.find((ref) => ref.label.trim() === `图片${imageIndex}`)?.nodeId;
    }
    return undefined;
}

export function stripPromptFirstFrameClauses(prompt: string): string {
    return prompt
        .replace(GLOBAL_FIRST_FRAME_CLAUSE, (fullMatch, _nodeId: string | undefined, _imageIndex: string | undefined, offset: number) => {
            if (offset === 0) return "";
            const leadingPunct = /^[，,。；;\s]+/u.exec(fullMatch)?.[0] || "";
            return leadingPunct.includes("\n") ? "\n" : "，";
        })
        .replace(/^[，,。；;\s]+/u, "")
        .replace(/[，,。；;\s]+$/u, (tail) => (tail.includes("\n") ? "\n" : ""));
}

export type VideoMiddleFrameSupport = "supported" | "unsupported" | "opaque";

export function resolveVideoMiddleFrameSupport(
    model: string,
    videoProfile?: VideoCapabilityConfig | null,
    hasDeclaredCapability = false,
    isBeefTVRoute = isBeefTVModelRoute(model),
): VideoMiddleFrameSupport {
    if (videoProfile?.middleFrame === true) return "supported";
    if (videoProfile?.middleFrame === false) return "unsupported";
    const modelName = model.split("::").at(-1) || "";
    if (isBeefTVRoute && beefTVVideoContract(modelName)?.middleFrame) return "supported";
    return hasDeclaredCapability ? "unsupported" : "opaque";
}

export function resolveVideoReferenceCapabilities(
    model: string,
    videoProfile?: VideoCapabilityConfig | null,
    hasDeclaredCapability = false,
    isBeefTVRoute = isBeefTVModelRoute(model),
): {
    maxFrameImages: number;
    endFrameSupported: boolean;
    referenceVideoSupported: boolean;
    maxFrameAudios: number;
    middleFrameSupport: VideoMiddleFrameSupport;
    middleFrameSupported: boolean;
} {
    const modelName = model.split("::").at(-1) || "";
    const contract = isBeefTVRoute ? beefTVVideoContract(modelName) : undefined;
    const middleFrameSupport = resolveVideoMiddleFrameSupport(model, videoProfile, hasDeclaredCapability, isBeefTVRoute);
    const middleFrameSupported = middleFrameSupport === "supported";
    const hasExplicitOpRefs = videoProfile?.operationReferences !== undefined;
    const frameRefs = videoProfile ? videoReferencesForOperation(videoProfile, "image_to_video") : undefined;

    if (isBeefTVRoute && isH3Style(model) && !hasExplicitOpRefs) {
        const styleMaxImages = hasDeclaredCapability && frameRefs ? Math.min(2, frameRefs.maxImages) : Math.min(2, contract?.maxReferences?.image ?? 1);
        const styleMaxAudios = hasDeclaredCapability && frameRefs ? frameRefs.maxAudios : (contract?.maxReferences?.audio ?? 0);
        return {
            maxFrameImages: styleMaxImages,
            endFrameSupported: styleMaxImages >= 2,
            referenceVideoSupported: hasDeclaredCapability ? Boolean(videoProfile?.operations.includes("reference_to_video")) : false,
            maxFrameAudios: styleMaxAudios,
            middleFrameSupport,
            middleFrameSupported,
        };
    }

    const h3 = isBeefTVRoute && isH3Model(model);
    const contractFrameMaxImages = contract?.operationReferences?.image_to_video?.maxImages;
    const maxFrameImages = hasExplicitOpRefs && frameRefs
        ? Math.min(2, frameRefs.maxImages)
        : contractFrameMaxImages !== undefined
          ? Math.min(2, hasDeclaredCapability && videoProfile ? Math.min(contractFrameMaxImages, videoProfile.references.maxImages) : contractFrameMaxImages)
          : (hasDeclaredCapability || Boolean(videoProfile?.operations.includes("reference_to_video"))) && frameRefs
            ? Math.min(2, frameRefs.maxImages)
            : Math.min(2, contract?.maxReferences?.image ?? 2);
    const endFrameSupported = maxFrameImages >= 2;
    const referenceVideoSupported = h3
        ? !hasDeclaredCapability || Boolean(videoProfile?.operations.includes("reference_to_video"))
        : Boolean(videoProfile?.operations.includes("reference_to_video"));
    const contractFrameMaxAudios = contract?.operationReferences?.image_to_video?.maxAudios;
    const maxFrameAudios = hasExplicitOpRefs && frameRefs
        ? frameRefs.maxAudios
        : !referenceVideoSupported && hasDeclaredCapability && frameRefs
          ? frameRefs.maxAudios
          : contractFrameMaxAudios !== undefined
            ? (hasDeclaredCapability && videoProfile ? Math.min(contractFrameMaxAudios, videoProfile.references.maxAudios) : contractFrameMaxAudios)
            : 0;

    return {
        maxFrameImages,
        endFrameSupported,
        referenceVideoSupported,
        maxFrameAudios,
        middleFrameSupport,
        middleFrameSupported,
    };
}

export function resolveVideoReferenceModeState({
    metadata,
    references,
    endFrameSupported = true,
    referenceVideoSupported = true,
    h3Model = false,
    h3Style = false,
    maxFrameAudios,
    prompt = "",
}: {
    metadata?: CanvasNodeMetadata;
    references: VideoReferenceCandidate[];
    endFrameSupported?: boolean;
    referenceVideoSupported?: boolean;
    h3Model?: boolean;
    h3Style?: boolean;
    maxFrameAudios?: number;
    prompt?: string;
}): VideoReferenceModeState {
    const active = references.filter((item) => item.active !== false && item.kind !== "skill");
    const imageRefs = active.filter((item) => item.kind === "image");
    const characterCount = active.filter((item) => item.kind === "character").length;
    const visualCount = imageRefs.length + characterCount;
    const videoCount = active.filter((item) => item.kind === "video").length;
    const audioCount = active.filter((item) => item.kind === "audio").length;
    const maxFrameImages = endFrameSupported ? 2 : 1;
    const allowedFrameAudios = maxFrameAudios ?? (h3Model ? 1 : 0);

    const canSelectFrames =
        imageRefs.length >= 1 &&
        characterCount === 0 &&
        visualCount <= maxFrameImages &&
        videoCount === 0 &&
        audioCount <= allowedFrameAudios;
    const canSelectAll = !h3Style && referenceVideoSupported && (visualCount > 0 || videoCount > 0 || audioCount > 0);

    let framesDisabledReason: string | undefined;
    if (!canSelectFrames) {
        if (videoCount > 0) {
            framesDisabledReason = "已连接参考视频，当前为全能参考模式。如需严格锁定开场首帧，请移除参考视频并只保留 1–2 张图";
        } else if (characterCount > 0) {
            framesDisabledReason = "已连接角色卡，当前为全能参考模式。如需严格锁定上段尾帧开场，请单独连接 1–2 张关键帧，或在提示词中用 @图片N 描述开场画面并保持同景构图";
        } else if (visualCount > maxFrameImages) {
            framesDisabledReason = "首尾帧锁定仅支持 1–2 张图；连接 3 张及以上图片时为全能参考（软引导）。如需严格接上段尾帧，请只连 1–2 张关键帧，或在提示词用 @图片N 写明开场并保持起幅同景";
        } else if (audioCount > 0) {
            framesDisabledReason = "当前模型连接参考音频时为全能参考模式。如需严格锁定首尾帧，请先移除参考音频并只保留 1–2 张图";
        } else {
            framesDisabledReason = "请先连接 1–2 张参考图";
        }
    }
    const allDisabledReason = !canSelectAll ? "当前模型仅支持首帧/首尾帧模式，不支持全能参考" : undefined;

    const mode: "frames" | "all" = !canSelectAll
        ? "frames"
        : !canSelectFrames || metadata?.videoEditOperation === "reference_to_video"
          ? "all"
          : "frames";

    if (mode === "all") {
        return {
            mode,
            canSelectFrames,
            canSelectAll,
            framesDisabledReason,
            allDisabledReason,
            endFrameSupported,
            promptFirstFrameNodeId: findPromptFirstFrameNodeId(prompt, imageRefs),
        };
    }

    const explicitStart = imageRefs.find((ref) => ref.nodeId === metadata?.videoStartFrameNodeId)?.nodeId;
    const explicitEnd = endFrameSupported
        ? imageRefs.find((ref) => ref.nodeId === metadata?.videoEndFrameNodeId)?.nodeId
        : undefined;
    const hasExplicitFrame = Boolean(explicitStart || explicitEnd);
    const startFrameNodeId = hasExplicitFrame ? explicitStart : imageRefs[0]?.nodeId;
    const endFrameNodeId = hasExplicitFrame
        ? explicitEnd && explicitEnd !== startFrameNodeId
            ? explicitEnd
            : undefined
        : endFrameSupported && imageRefs.length === 2
          ? imageRefs[1]?.nodeId
          : undefined;

    return {
        mode,
        canSelectFrames,
        canSelectAll,
        framesDisabledReason,
        allDisabledReason,
        endFrameSupported,
        startFrameNodeId,
        endFrameNodeId,
    };
}
