import { nanoid } from "nanoid";

import { writeCanvasNodePrompt } from "@/lib/canvas/canvas-node-prompt";
import { storyboardAssetRoleForNode } from "@/lib/canvas/canvas-storyboard-assets";
import { buildOrderedCanvasResourceReferences, canvasResourceMentionToken } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardAssetBinding, type StoryboardRow } from "@/types/canvas";

export function storyboardRowReferenceNodeIds(
    scriptNode: CanvasNodeData,
    row: StoryboardRow,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    includeFirstFrame: boolean,
    targetNodeId?: string,
) {
    const characterAssetIds = new Set((row.characters || []).map((character) => character.characterAssetId).filter((assetId): assetId is string => Boolean(assetId)));
    const characterNodeIds = nodes
        .filter((node) => node.metadata?.workflowKind === "character" && Boolean(node.metadata.characterAssetId) && characterAssetIds.has(node.metadata.characterAssetId!))
        .map((node) => node.id);
    const referenceIds = new Set([
        ...(scriptNode.metadata?.storyboard?.referenceNodeIds || []),
        ...(row.assetBindings || []).map((binding) => binding.nodeId),
        ...characterNodeIds,
        ...connections.filter((connection) => connection.toNodeId === scriptNode.id && connection.toHandleId === `row:${row.id}`).map((connection) => connection.fromNodeId),
        ...(targetNodeId ? connections.filter((connection) => !connection.relation && connection.toNodeId === targetNodeId).map((connection) => connection.fromNodeId) : []),
        ...(includeFirstFrame && row.imageNodeId ? [row.imageNodeId] : []),
    ]);
    if (!includeFirstFrame && row.imageNodeId) referenceIds.delete(row.imageNodeId);
    referenceIds.delete(scriptNode.id);
    return Array.from(referenceIds).filter((nodeId) => nodes.some((node) => node.id === nodeId));
}

export function storyboardComposerContent(prompt: string, referenceNodeIds: string[], nodes: CanvasNodeData[]) {
    const referenceIds = Array.from(new Set(referenceNodeIds));
    const referenceNodes = referenceIds.flatMap((nodeId) => {
        const node = nodes.find((candidate) => candidate.id === nodeId);
        return node ? [node] : [];
    });
    const mentions = buildOrderedCanvasResourceReferences(referenceNodes).map(canvasResourceMentionToken);
    return mentions.length ? [`参考资产：${mentions.join(" ")}`, prompt.trim()].filter(Boolean).join("\n") : prompt.trim();
}

export function reconcileStoryboardTargetConnections(
    connections: CanvasConnection[],
    scriptNode: CanvasNodeData,
    row: StoryboardRow,
    targetNodeId: string,
    referenceNodeIds: string[],
) {
    const desired = new Set(referenceNodeIds.filter((nodeId) => nodeId !== targetNodeId && nodeId !== scriptNode.id));
    const next = connections.filter((connection) => {
        if (connection.storyboardRowId !== row.id || connection.toNodeId !== targetNodeId) return true;
        if (connection.relation === "storyboard-output") return connection.fromNodeId === scriptNode.id;
        if (connection.relation === "storyboard-asset-reference") return desired.has(connection.fromNodeId);
        return true;
    });
    if (!next.some((connection) => connection.fromNodeId === scriptNode.id && connection.toNodeId === targetNodeId && connection.fromHandleId === `row:${row.id}`)) {
        next.push({ id: nanoid(), fromNodeId: scriptNode.id, toNodeId: targetNodeId, fromHandleId: `row:${row.id}`, relation: "storyboard-output", storyboardRowId: row.id });
    }
    desired.forEach((fromNodeId) => {
        if (!next.some((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === targetNodeId)) {
            next.push({ id: nanoid(), fromNodeId, toNodeId: targetNodeId, relation: "storyboard-asset-reference", storyboardRowId: row.id });
        }
    });
    return next;
}

export function bindingForConnectedNode(node: CanvasNodeData): StoryboardAssetBinding | null {
    const role = storyboardAssetRoleForNode(node);
    return role ? { nodeId: node.id, role, priority: defaultRolePriority(role) } : null;
}

export function isStoryboardPreviewAsset(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Drawing || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || node.metadata?.workflowKind === "character";
}

function defaultRolePriority(role: StoryboardAssetBinding["role"]) {
    if (role === "character") return 100;
    if (role === "environment") return 90;
    if (role === "prop" || role === "weapon" || role === "wardrobe") return 80;
    if (role === "motion" || role === "audio") return 70;
    return 60;
}

export function syncBoundStoryboardNodesForRows(
    scriptNode: CanvasNodeData,
    prevRows: StoryboardRow[],
    nextRows: StoryboardRow[],
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
) {
    const prevById = new Map(prevRows.map((row) => [row.id, row]));
    const syncTargets = new Map<string, { expectedType: CanvasNodeData["type"]; allowedOldDrafts: Set<string>; nextComposer: string }>();
    for (const nextRow of nextRows) {
        const prevRow = prevById.get(nextRow.id);
        if (!prevRow) continue;
        if (nextRow.imageNodeId && (nextRow.imageGenerationPrompt || "") !== (prevRow.imageGenerationPrompt || "")) {
            const refIds = storyboardRowReferenceNodeIds(scriptNode, nextRow, nodes, connections, false, nextRow.imageNodeId);
            const oldRaw = (prevRow.imageGenerationPrompt || prevRow.plotDescription || "").trim();
            const nextRaw = (nextRow.imageGenerationPrompt || nextRow.plotDescription || "").trim();
            syncTargets.set(nextRow.imageNodeId, {
                expectedType: CanvasNodeType.Image,
                allowedOldDrafts: new Set([
                    "",
                    prevRow.imageGenerationPrompt || "",
                    oldRaw,
                    storyboardComposerContent(oldRaw, refIds, nodes),
                    nextRow.imageGenerationPrompt || "",
                    nextRaw,
                    storyboardComposerContent(nextRaw, refIds, nodes),
                ]),
                nextComposer: storyboardComposerContent(nextRaw, refIds, nodes),
            });
        }
        if (nextRow.videoNodeId && (nextRow.videoMotionPrompt || "") !== (prevRow.videoMotionPrompt || "")) {
            const videoNode = nodes.find((node) => node.id === nextRow.videoNodeId);
            const includeFirstFrame = Boolean(videoNode?.metadata?.videoStartFrameNodeId || videoNode?.metadata?.videoEditOperation === "image_to_video");
            const refIdsNoFrame = storyboardRowReferenceNodeIds(scriptNode, nextRow, nodes, connections, false, nextRow.videoNodeId);
            const refIdsWithFrame = storyboardRowReferenceNodeIds(scriptNode, nextRow, nodes, connections, true, nextRow.videoNodeId);
            const activeRefIds = includeFirstFrame ? refIdsWithFrame : refIdsNoFrame;
            const oldRaw = (prevRow.videoMotionPrompt || prevRow.plotDescription || "").trim();
            const nextRaw = (nextRow.videoMotionPrompt || nextRow.plotDescription || "").trim();
            syncTargets.set(nextRow.videoNodeId, {
                expectedType: CanvasNodeType.Video,
                allowedOldDrafts: new Set([
                    "",
                    prevRow.videoMotionPrompt || "",
                    oldRaw,
                    storyboardComposerContent(oldRaw, refIdsNoFrame, nodes),
                    storyboardComposerContent(oldRaw, refIdsWithFrame, nodes),
                    nextRow.videoMotionPrompt || "",
                    nextRaw,
                    storyboardComposerContent(nextRaw, refIdsNoFrame, nodes),
                    storyboardComposerContent(nextRaw, refIdsWithFrame, nodes),
                ]),
                nextComposer: storyboardComposerContent(nextRaw, activeRefIds, nodes),
            });
        }
    }
    return nodes.map((node) => {
        if (node.id === scriptNode.id) {
            return {
                ...node,
                metadata: {
                    ...node.metadata,
                    storyboard: {
                        rows: nextRows,
                        visibleColumns: node.metadata?.storyboard?.visibleColumns || ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
                        referenceNodeIds: node.metadata?.storyboard?.referenceNodeIds || [],
                    },
                },
            };
        }
        const sync = syncTargets.get(node.id);
        if (!sync || node.type !== sync.expectedType) return node;
        const rawDraft = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
        const currentDraft = rawDraft.trim();
        if (sync.allowedOldDrafts.has(currentDraft) || sync.allowedOldDrafts.has(rawDraft)) {
            return writeCanvasNodePrompt(node, sync.nextComposer, { clearPromptTemplate: true });
        }
        return node;
    });
}
