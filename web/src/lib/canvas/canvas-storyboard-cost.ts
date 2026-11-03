import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-config";
import { storyboardRowReferenceNodeIds } from "@/lib/canvas/canvas-storyboard-materializer";
import type { CostEstimateTarget } from "@/services/api/cost-estimate";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";

/** 分镜批量生成前的估算目标：参数取镜头节点生成时的有效配置，参考素材按镜头已连接的节点计数。 */
export function storyboardCostTargets(
    config: AiConfig,
    modelKey: string,
    kind: "image" | "video",
    scriptNode: CanvasNodeData,
    rows: StoryboardRow[],
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
): CostEstimateTarget[] {
    const generation = buildGenerationConfig(config, undefined, kind);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return rows.map((row) => {
        const references = storyboardRowReferenceNodeIds(scriptNode, row, nodes, connections, kind === "video");
        const referenceVideos = references.filter((id) => byId.get(id)?.type === CanvasNodeType.Video).length;
        const parameters = kind === "image"
            ? { size: generation.size, quality: generation.quality, count: generation.count, seedreamMode: generation.seedreamMode, seedreamMaxImages: generation.seedreamMaxImages }
            : { vquality: generation.vquality, seconds: String(row.durationSeconds), count: "1" };
        return {
            modelKey,
            kind,
            parameters: Object.fromEntries(Object.entries(parameters).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")),
            referenceImages: references.length - referenceVideos,
            referenceVideos,
        };
    });
}
