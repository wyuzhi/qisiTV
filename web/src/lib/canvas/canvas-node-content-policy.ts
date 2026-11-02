import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Only these nodes consume the page's custom content callback. */
export function usesCanvasCustomNodeContent(node: CanvasNodeData, isEditingContent = false) {
    return node.type === CanvasNodeType.Config
        || Boolean(node.metadata?.reusableWorkflow)
        || Boolean(node.metadata?.workflowSlot)
        || node.type === CanvasNodeType.Script
        || node.type === CanvasNodeType.BatchTable
        || node.type === CanvasNodeType.Director
        || Boolean(node.metadata?.directorSceneId)
        || (node.metadata?.workflowKind === "character" && Boolean(node.metadata.characterAssetId))
        || (node.metadata?.workflowKind === "story_input" && !isEditingContent)
        || (node.metadata?.workflowKind === "styleboard" && !node.metadata.content);
}
