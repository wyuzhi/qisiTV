import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";
import { buildCanvasSpatialIndex, canvasNodeBounds, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";

export const FRAME_HEADER_HEIGHT = 36;
export const FRAME_PADDING = 24;
export const FRAME_COLLAPSED_WIDTH = 240;
export const FRAME_COLLAPSED_HEIGHT = 144;
export const FOLDER_COLLAPSED_WIDTH = 360;
export const FOLDER_COLLAPSED_HEIGHT = 280;

export function isFrameNode(node?: CanvasNodeData | null): node is CanvasNodeData & { type: CanvasNodeType.Frame | CanvasNodeType.Workflow } {
    return node?.type === CanvasNodeType.Frame || node?.type === CanvasNodeType.Workflow;
}

export function isCanvasFolderNode(node?: CanvasNodeData | null) {
    return isFrameNode(node) && Boolean(node.metadata?.folder);
}

export function canFrameContain(node: CanvasNodeData) {
    if (node.metadata?.workflowSlot || node.metadata?.reusableWorkflow) return true;
    return node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Drawing || node.type === CanvasNodeType.Script || node.type === CanvasNodeType.Video;
}

export function canFolderContain(node: CanvasNodeData) {
    return !isFrameNode(node);
}

export function canLinkedFolderArchive(node: CanvasNodeData) {
    return (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || node.type === CanvasNodeType.Text) && Boolean(node.metadata?.assetId || node.metadata?.content?.trim());
}

export function getFrameChildren(frameId: string, nodes: CanvasNodeData[]) {
    return nodes.filter((node) => node.parentId === frameId);
}

export function getFrameChildIds(frameId: string, nodes: CanvasNodeData[]) {
    return new Set(getFrameChildren(frameId, nodes).map((node) => node.id));
}

export function getCollapsedParentFrame(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    if (!node.parentId) return null;
    const frame = nodes.find((item) => item.id === node.parentId && isFrameNode(item));
    return frame?.metadata?.frame?.collapsed ? frame : null;
}

export function isNodeHiddenByCollapsedFrame(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return Boolean(getCollapsedParentFrame(node, nodes));
}

export function findFrameDropTarget(nodes: CanvasNodeData[], draggedNodeIds: Set<string>) {
    const dragged = nodes.filter((node) => draggedNodeIds.has(node.id));
    if (!dragged.length) return null;

    return (
        [...nodes]
            .reverse()
            .find((frame) => isValidFrameDropTarget(frame, dragged, draggedNodeIds))?.id || null
    );
}

export type CanvasFrameDropIndex = CanvasSpatialIndex<CanvasNodeData>;

export function buildCanvasFrameDropIndex(nodes: CanvasNodeData[]): CanvasFrameDropIndex {
    return buildCanvasSpatialIndex(nodes.filter(isFrameNode).map((node) => ({ id: node.id, bounds: canvasNodeBounds(node), value: node })));
}

/** Finds a drop target using the drag preview offset without rebuilding all node positions. */
export function findFrameDropTargetFromIndex(index: CanvasFrameDropIndex, draggedNodes: CanvasNodeData[], draggedNodeIds: Set<string>, offset: Position) {
    if (!draggedNodes.length) return null;
    const left = Math.min(...draggedNodes.map((node) => node.position.x + offset.x)) - 0.01;
    const top = Math.min(...draggedNodes.map((node) => node.position.y + offset.y)) - 0.01;
    const right = Math.max(...draggedNodes.map((node) => node.position.x + offset.x + node.width)) + 0.01;
    const bottom = Math.max(...draggedNodes.map((node) => node.position.y + offset.y + node.height)) + 0.01;
    return [...index.query({ left, top, right, bottom })]
        .reverse()
        .find((frame) => isValidFrameDropTarget(frame, draggedNodes, draggedNodeIds, offset))?.id || null;
}

function isValidFrameDropTarget(frame: CanvasNodeData, dragged: CanvasNodeData[], draggedNodeIds: Set<string>, offset: Position = { x: 0, y: 0 }) {
    if (frame.type === CanvasNodeType.Workflow) return false;
    if (!isFrameNode(frame) || (frame.metadata?.frame?.collapsed && !isCanvasFolderNode(frame)) || draggedNodeIds.has(frame.id)) return false;
    const canContain = frame.metadata?.folder?.assetFolderId ? canLinkedFolderArchive : isCanvasFolderNode(frame) ? canFolderContain : canFrameContain;
    if (!dragged.every(canContain)) return false;
    const collapsedFolder = isCanvasFolderNode(frame) && Boolean(frame.metadata?.frame?.collapsed);
    const left = frame.position.x;
    const top = frame.position.y + (collapsedFolder ? 0 : FRAME_HEADER_HEIGHT);
    const right = frame.position.x + frame.width;
    const bottom = frame.position.y + frame.height;
    if (collapsedFolder) {
        return dragged.some((node) => {
            const nodeLeft = node.position.x + offset.x;
            const nodeTop = node.position.y + offset.y;
            const nodeRight = nodeLeft + node.width;
            const nodeBottom = nodeTop + node.height;
            const centerX = nodeLeft + node.width / 2;
            const centerY = nodeTop + node.height / 2;
            const overlapX = Math.max(0, Math.min(right, nodeRight) - Math.max(left, nodeLeft));
            const overlapY = Math.max(0, Math.min(bottom, nodeBottom) - Math.max(top, nodeTop));
            return (centerX >= left && centerX <= right && centerY >= top && centerY <= bottom)
                || (overlapX >= Math.min(node.width, frame.width) * 0.35 && overlapY >= Math.min(node.height, frame.height) * 0.35);
        });
    }
    return dragged.every((node) => {
        const centerX = node.position.x + offset.x + node.width / 2;
        const centerY = node.position.y + offset.y + node.height / 2;
        return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
    });
}

export function packNodesIntoCollapsedFolder(
    nodes: CanvasNodeData[],
    selectedNodeIds: ReadonlySet<string>,
    createFolderNode: (position: Position, count: number) => CanvasNodeData,
) {
    const candidates = nodes
        .filter((node) => selectedNodeIds.has(node.id) && !node.metadata?.locked && canFolderContain(node))
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    if (candidates.length < 2) return null;
    const left = Math.min(...candidates.map((node) => node.position.x));
    const top = Math.min(...candidates.map((node) => node.position.y));
    const folder = createFolderNode({ x: left, y: top }, candidates.length);
    const nextNodes = applyFrameDrop([...nodes, folder], new Set(candidates.map((node) => node.id)), folder.id);
    return { nodes: nextNodes, folderId: folder.id, count: candidates.length };
}

export function applyFrameDrop(nodes: CanvasNodeData[], draggedNodeIds: Set<string>, frameId: string | null) {
    const target = frameId ? nodes.find((node) => node.id === frameId && isFrameNode(node)) : null;
    const canContain = target?.metadata?.folder?.assetFolderId ? canLinkedFolderArchive : target && isCanvasFolderNode(target) ? canFolderContain : canFrameContain;
    const droppedIntoFrame: CanvasNodeData[] = [];
    const remaining: CanvasNodeData[] = [];
    for (const node of nodes) {
        if (!draggedNodeIds.has(node.id)) {
            remaining.push(node);
            continue;
        }
        if (!frameId) {
            remaining.push(node.parentId ? { ...node, parentId: undefined } : node);
            continue;
        }
        if (target && canContain(node)) {
            droppedIntoFrame.push({ ...node, parentId: frameId });
        } else {
            remaining.push(node);
        }
    }
    const next = [...remaining, ...droppedIntoFrame];
    if (!frameId) return next;

    const children = getFrameChildren(frameId, next);
    if (!children.length) return next;
    const frame = next.find((node) => node.id === frameId);
    if (!frame || !isFrameNode(frame)) return next;

    if (isCanvasFolderNode(frame) && frame.metadata?.frame?.collapsed) {
        return layoutCollapsedFolderChildren(next, frame);
    }

    const left = Math.min(frame.position.x, ...children.map((node) => node.position.x - FRAME_PADDING));
    const top = Math.min(frame.position.y, ...children.map((node) => node.position.y - FRAME_HEADER_HEIGHT - FRAME_PADDING));
    const right = Math.max(frame.position.x + frame.width, ...children.map((node) => node.position.x + node.width + FRAME_PADDING));
    const bottom = Math.max(frame.position.y + frame.height, ...children.map((node) => node.position.y + node.height + FRAME_PADDING));

    return next.map((node) =>
        node.id === frameId
            ? {
                  ...node,
                  position: { x: left, y: top },
                  width: right - left,
                  height: bottom - top,
                  metadata: {
                      ...node.metadata,
                      frame: {
                          collapsed: false,
                          expandedWidth: right - left,
                          expandedHeight: bottom - top,
                      },
                  },
              }
            : node,
    );
}

function layoutCollapsedFolderChildren(nodes: CanvasNodeData[], folder: CanvasNodeData) {
    const children = getFrameChildren(folder.id, nodes);
    if (!children.length) return nodes;
    const gap = 24;
    const padding = FRAME_PADDING;
    const columns = Math.min(8, Math.ceil(Math.sqrt(children.length)));
    const rows = Math.ceil(children.length / columns);
    const cellWidth = Math.max(...children.map((node) => node.width));
    const cellHeight = Math.max(...children.map((node) => node.height));
    const expandedWidth = padding * 2 + columns * cellWidth + Math.max(columns - 1, 0) * gap;
    const expandedHeight = FRAME_HEADER_HEIGHT + padding * 2 + rows * cellHeight + Math.max(rows - 1, 0) * gap;
    const indexById = new Map(children.map((node, index) => [node.id, index]));

    return nodes.map((node) => {
        if (node.id === folder.id) {
            return {
                ...node,
                metadata: {
                    ...node.metadata,
                    frame: { collapsed: true, expandedWidth, expandedHeight },
                },
            };
        }
        const index = indexById.get(node.id);
        if (index === undefined) return node;
        const column = index % columns;
        const row = Math.floor(index / columns);
        return {
            ...node,
            position: {
                x: folder.position.x + padding + column * (cellWidth + gap) + (cellWidth - node.width) / 2,
                y: folder.position.y + FRAME_HEADER_HEIGHT + padding + row * (cellHeight + gap) + (cellHeight - node.height) / 2,
            },
        };
    });
}

export function unpackCanvasFolder(nodes: CanvasNodeData[], folderId: string) {
    const folder = nodes.find((node) => node.id === folderId && isCanvasFolderNode(node));
    if (!folder || folder.metadata?.folder?.assetFolderId) return null;
    const children = getFrameChildren(folderId, nodes);
    if (!children.length) {
        return { nodes: nodes.filter((node) => node.id !== folderId), unpackedIds: [] as string[] };
    }
    const gap = 24;
    const columns = Math.min(8, Math.ceil(Math.sqrt(children.length)));
    const cellWidth = Math.max(...children.map((node) => node.width));
    const cellHeight = Math.max(...children.map((node) => node.height));
    const indexById = new Map(children.map((node, index) => [node.id, index]));
    const nextNodes = nodes
        .filter((node) => node.id !== folderId)
        .map((node) => {
            const index = indexById.get(node.id);
            if (index === undefined) return node;
            const column = index % columns;
            const row = Math.floor(index / columns);
            return {
                ...node,
                parentId: undefined,
                position: {
                    x: folder.position.x + column * (cellWidth + gap) + (cellWidth - node.width) / 2,
                    y: folder.position.y + row * (cellHeight + gap) + (cellHeight - node.height) / 2,
                },
            };
        });
    return { nodes: nextNodes, unpackedIds: children.map((node) => node.id) };
}

export function extractNodeFromCanvasFolder(nodes: CanvasNodeData[], nodeId: string) {
    const child = nodes.find((node) => node.id === nodeId);
    const folder = child?.parentId ? nodes.find((node) => node.id === child.parentId && isCanvasFolderNode(node)) : null;
    if (!child || !folder) return null;
    const nextPosition = {
        x: folder.position.x + folder.width + 36,
        y: folder.position.y + Math.max(0, (folder.height - child.height) / 2),
    };
    const detached = nodes.map((node) => (node.id === nodeId ? { ...node, parentId: undefined, position: nextPosition } : node));
    return {
        nodes: layoutCollapsedFolderChildren(detached, folder),
        folderId: folder.id,
        nodeId: child.id,
    };
}

export function resolveFrameConnection(connection: CanvasConnection, nodes: CanvasNodeData[]) {
    const from = nodes.find((node) => node.id === connection.fromNodeId);
    const to = nodes.find((node) => node.id === connection.toNodeId);
    if (!from || !to) return null;

    const displayFrom = getCollapsedParentFrame(from, nodes) || from;
    const displayTo = getCollapsedParentFrame(to, nodes) || to;
    if (displayFrom.id === displayTo.id) return null;
    return { from: displayFrom, to: displayTo };
}
