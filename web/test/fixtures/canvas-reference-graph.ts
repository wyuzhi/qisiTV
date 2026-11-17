import type { CanvasResourceReference } from "../../src/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../src/types/canvas";

export function buildReferenceGraph(targetNode: CanvasNodeData, references: CanvasResourceReference[]): {
    referenceNodes: CanvasNodeData[];
    referenceConnections: CanvasConnection[];
} {
    const upstreamNodes = references
        .filter((item) => item.active && !item.assetId && item.kind !== "skill" && item.nodeId && item.nodeId !== targetNode.id)
        .map((item, index): CanvasNodeData => ({
            id: item.nodeId,
            type: item.drawingId
                ? CanvasNodeType.Drawing
                : item.kind === "video"
                  ? CanvasNodeType.Video
                  : item.kind === "audio"
                    ? CanvasNodeType.Audio
                    : item.kind === "text"
                      ? CanvasNodeType.Text
                      : CanvasNodeType.Image,
            title: item.title || item.label,
            position: { x: index * 120, y: 0 },
            width: 120,
            height: 80,
            metadata:
                item.kind === "character"
                    ? { workflowKind: "character", characterAssetId: item.id || item.nodeId, characterPrompt: item.text, characterCoverUrl: item.previewUrl }
                    : item.drawingId
                      ? { drawingId: item.drawingId, drawingRevision: item.drawingRevision }
                      : item.kind === "text"
                        ? { content: item.text || item.title || "text" }
                        : {
                              content:
                                  item.mediaUrl ||
                                  item.previewUrl ||
                                  `https://example.com/${item.nodeId}.${item.kind === "video" ? "mp4" : item.kind === "audio" ? "mp3" : "png"}`,
                              storageKey: item.storageKey,
                          },
        }));
    return {
        referenceNodes: [targetNode, ...upstreamNodes],
        referenceConnections: upstreamNodes.map((item) => ({
            id: `edge:${item.id}->${targetNode.id}`,
            fromNodeId: item.id,
            toNodeId: targetNode.id,
        })),
    };
}
