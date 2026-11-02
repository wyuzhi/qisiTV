import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasImportSnapshot = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

/** 把导入的节点和连线接在当前画布后面；保存失败时调用方仍持有原来的快照，可以整页撤回去。 */
export function appendCanvasImport(current: CanvasImportSnapshot, importedNodes: CanvasNodeData[], importedConnections: CanvasConnection[]): CanvasImportSnapshot {
    return {
        nodes: [...current.nodes, ...importedNodes],
        connections: [...current.connections, ...importedConnections],
    };
}
