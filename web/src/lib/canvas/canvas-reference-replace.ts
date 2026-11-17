import { nanoid } from "nanoid";

import { writeCanvasNodePrompt } from "@/lib/canvas/canvas-node-prompt";
import { buildCanvasNodeMentionReferenceMap, replaceCanvasReferenceMentions } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasReferenceReplaceTarget = {
    id: string;
    nodeId?: string;
    label?: string;
    title?: string;
};

export type CanvasReferenceReplaceResult = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    /** 成功时给用户看的一句说明；没换成功则为空。 */
    notice: string | null;
};

export type ReplacedReferenceTargetMeta = {
    nextNodeId: string;
    isImage: boolean;
    isMediaOrCharacter: boolean;
};

/** Migrate explicit video frame / reference-order / shot asset metadata when a connected node is replaced or removed (`replacement = null`). */
export function migrateCanvasNodeReferenceMetadata(
    metadata: CanvasNodeData["metadata"] | undefined,
    oldNodeId: string | undefined,
    replacement: ReplacedReferenceTargetMeta | null,
    includeShotAssets: boolean,
): CanvasNodeData["metadata"] | undefined {
    if (!oldNodeId || !metadata) return metadata;
    const patch: Partial<NonNullable<CanvasNodeData["metadata"]>> = {};
    let changed = false;
    const remapOrDrop = (ids: string[] | undefined, keepReplacement: boolean): string[] | undefined => {
        if (!Array.isArray(ids) || !ids.includes(oldNodeId)) return undefined;
        changed = true;
        if (!replacement || !keepReplacement) return ids.filter((id) => id !== oldNodeId);
        const deduped = new Set<string>();
        for (const id of ids) deduped.add(id === oldNodeId ? replacement.nextNodeId : id);
        return [...deduped];
    };
    if (metadata.videoStartFrameNodeId === oldNodeId) {
        patch.videoStartFrameNodeId = replacement?.isImage ? replacement.nextNodeId : undefined;
        changed = true;
    }
    if (metadata.videoEndFrameNodeId === oldNodeId) {
        patch.videoEndFrameNodeId = replacement?.isImage ? replacement.nextNodeId : undefined;
        changed = true;
    }
    if (metadata.videoMiddleFrameNodeId === oldNodeId) {
        patch.videoMiddleFrameNodeId = replacement?.isImage ? replacement.nextNodeId : undefined;
        if (!replacement?.isImage) patch.videoMiddleFrameTime = undefined;
        changed = true;
    }
    const nextOrder = remapOrDrop(metadata.videoReferenceOrder, Boolean(replacement?.isMediaOrCharacter));
    if (nextOrder) patch.videoReferenceOrder = nextOrder;
    if (includeShotAssets && metadata.workflowKind === "shot") {
        const nextShotAssets = remapOrDrop(metadata.referenceAssetNodeIds, Boolean(replacement?.isMediaOrCharacter));
        if (nextShotAssets) patch.referenceAssetNodeIds = nextShotAssets;
    }
    return changed ? { ...metadata, ...patch } : metadata;
}

/**
 * 把目标节点上的一张参考图换成另一张已经在画布上的图：改连线，并同步提示词里的 @ 引用与视频关键帧/分镜引用绑定。
 * 来源不存在、或来源就是原来那张时，原样返回。
 */
export function replaceCanvasNodeReference(
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    targetNodeId: string,
    oldReference: CanvasReferenceReplaceTarget,
    sourceNodeId: string,
    createId: () => string = () => nanoid(),
): CanvasReferenceReplaceResult {
    const unchanged = { nodes, connections, notice: null };
    const sourceNode = nodes.find((node) => node.id === sourceNodeId);
    if (!sourceNode || sourceNode.id === oldReference.nodeId) return unchanged;

    const configNodeId = connections.find((connection) => connection.fromNodeId === targetNodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config)?.toNodeId;
    const receiverId = configNodeId || targetNodeId;

    let rewired = false;
    const nextConnections = connections.map((connection) => {
        if (!rewired && connection.fromNodeId === oldReference.nodeId && (connection.toNodeId === targetNodeId || connection.toNodeId === configNodeId)) {
            rewired = true;
            return { ...connection, fromNodeId: sourceNodeId };
        }
        return connection;
    });
    if (!rewired) nextConnections.push({ id: createId(), fromNodeId: sourceNodeId, toNodeId: receiverId });

    const nextReferences = buildCanvasNodeMentionReferenceMap(nodes, nextConnections, nodes).get(targetNodeId) || [];
    const newReference = nextReferences.find((reference) => reference.nodeId === sourceNodeId);
    const isImage = newReference
        ? newReference.kind === "image"
        : sourceNode.metadata?.workflowKind !== "character" &&
          (sourceNode.type === CanvasNodeType.Image || sourceNode.type === CanvasNodeType.Drawing || sourceNode.type === CanvasNodeType.ColorGrade);
    const isMediaOrCharacter = newReference
        ? newReference.kind !== "text" && newReference.kind !== "skill"
        : isImage || sourceNode.type === CanvasNodeType.Video || sourceNode.type === CanvasNodeType.Audio;
    const targetNode = nodes.find((node) => node.id === targetNodeId);
    const nextNodes = nodes.map((node) => {
        let updated = node;
        if (targetNode && newReference && node.id === targetNodeId) {
            const currentPrompt = targetNode.metadata?.composerContent ?? targetNode.metadata?.prompt ?? "";
            const replacementToken = `@${newReference.label}`;
            const updatedPrompt = replaceCanvasReferenceMentions(currentPrompt, oldReference, replacementToken, sourceNode.title ? sourceNode.title : newReference.label);
            updated = writeCanvasNodePrompt(updated, updatedPrompt);
        }
        if (node.id === targetNodeId || (configNodeId && node.id === configNodeId)) {
            const nextMetadata = migrateCanvasNodeReferenceMetadata(
                updated.metadata,
                oldReference.nodeId,
                { nextNodeId: sourceNodeId, isImage, isMediaOrCharacter },
                node.id === targetNodeId,
            );
            if (nextMetadata !== updated.metadata) updated = { ...updated, metadata: nextMetadata };
        }
        return updated;
    });

    const previousLabel = oldReference.label || "参考图";
    const nextLabel = sourceNode.title || "新图片";
    return {
        nodes: nextNodes,
        connections: nextConnections,
        notice: `已将参考图「${previousLabel}」替换为「${nextLabel}」，提示词已同步更新`,
    };
}
