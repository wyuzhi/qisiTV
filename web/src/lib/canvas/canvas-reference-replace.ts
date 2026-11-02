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

/**
 * 把目标节点上的一张参考图换成另一张已经在画布上的图：改连线，并同步提示词里的 @ 引用。
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
    const targetNode = nodes.find((node) => node.id === targetNodeId);
    let nextNodes = nodes;
    if (targetNode && newReference) {
        const currentPrompt = targetNode.metadata?.composerContent ?? targetNode.metadata?.prompt ?? "";
        const replacementToken = `@${newReference.label}`;
        const updatedPrompt = replaceCanvasReferenceMentions(currentPrompt, oldReference, replacementToken, sourceNode.title ? sourceNode.title : newReference.label);
        nextNodes = nodes.map((node) => (node.id === targetNodeId ? writeCanvasNodePrompt(node, updatedPrompt) : node));
    }

    const previousLabel = oldReference.label || "参考图";
    const nextLabel = sourceNode.title || "新图片";
    return {
        nodes: nextNodes,
        connections: nextConnections,
        notice: `已将参考图「${previousLabel}」替换为「${nextLabel}」，提示词已同步更新`,
    };
}
