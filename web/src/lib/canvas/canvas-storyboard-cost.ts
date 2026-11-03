import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-config";
import { storyboardRowReferenceNodeIds } from "@/lib/canvas/canvas-storyboard-materializer";
import type { CostEstimateTarget } from "@/services/api/cost-estimate";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";

/** 分镜批量生成的四条路径；每条路径提交的节点和参考素材不同。 */
export type StoryboardCostFlow = "image" | "action_board" | "text_to_video" | "image_to_video";

function submittedNode(flow: StoryboardCostFlow, row: StoryboardRow, nodes: CanvasNodeData[]) {
    if (flow === "action_board") return nodes.find((node) => node.type === CanvasNodeType.Image && node.metadata?.workflowKind === "action_board" && node.metadata.shotIndex === row.shotNumber);
    const id = flow === "image" ? row.imageNodeId : row.videoNodeId;
    const type = flow === "image" ? CanvasNodeType.Image : CanvasNodeType.Video;
    return id ? nodes.find((node) => node.id === id && node.type === type) : undefined;
}

/**
 * 分镜批量生成前的估算目标：按批量队列实际提交的节点取参数。已有节点保留它自己的尺寸、画质、
 * 分辨率和模型；视频镜头先写入所选视频模型与镜头时长，与提交前的节点写回一致。
 */
export function storyboardCostTargets(
    config: AiConfig,
    flow: StoryboardCostFlow,
    scriptNode: CanvasNodeData,
    rows: StoryboardRow[],
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    videoModel = "",
): CostEstimateTarget[] {
    const kind = flow === "image" || flow === "action_board" ? "image" : "video";
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return rows.map((row) => {
        const existing = submittedNode(flow, row, nodes);
        const node = kind === "video"
            ? { ...existing, type: CanvasNodeType.Video, metadata: { ...existing?.metadata, model: videoModel, seconds: String(row.durationSeconds) } } as CanvasNodeData
            : existing;
        const generation = buildGenerationConfig(config, node, kind);
        // 动作板只从分镜脚本连入，不带镜头参考；其余路径按提交前写回的参考连线计。
        const references = flow === "action_board"
            ? connections.filter((connection) => existing && connection.toNodeId === existing.id).map((connection) => connection.fromNodeId)
            : storyboardRowReferenceNodeIds(scriptNode, row, nodes, connections, flow === "image_to_video", existing?.id);
        const types = references.map((id) => byId.get(id)?.type);
        const parameters = kind === "image"
            ? { size: generation.size, quality: generation.quality, count: generation.count, seedreamMode: generation.seedreamMode, seedreamMaxImages: generation.seedreamMaxImages }
            : { vquality: generation.vquality, seconds: generation.videoSeconds, count: "1" };
        return {
            modelKey: generation.model,
            kind,
            parameters: Object.fromEntries(Object.entries(parameters).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")),
            referenceImages: types.filter((type) => type === CanvasNodeType.Image).length,
            referenceVideos: types.filter((type) => type === CanvasNodeType.Video).length,
        };
    });
}
