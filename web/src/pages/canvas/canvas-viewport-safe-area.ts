import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type ConnectedNodeVisibleViewportInput = {
    node: CanvasNodeData;
    sourceNodeId?: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    viewport?: ViewportTransform;
    current?: ViewportTransform;
    canvasWidth: number;
    canvasHeight: number;
};

/**
 * Pan (and only zoom out when required) the viewport so a newly connected node
 * stays inside the visible canvas safe area without auto-zooming in or jumping
 * when the node is already visible. Node world positions stay unchanged.
 */
export function connectedNodeVisibleViewport(input: ConnectedNodeVisibleViewportInput): ViewportTransform | null {
    if (input.canvasWidth <= 0 || input.canvasHeight <= 0) return null;
    const current = input.viewport ?? input.current;
    if (!current) return null;
    const scale = Math.max(current.k, 0.05);

    const safeLeft = 24;
    const safeRight = Math.max(safeLeft + 1, input.canvasWidth - 24);
    const safeTop = 64;
    const safeBottom = Math.max(safeTop + 1, input.canvasHeight - 72);
    const availableWidth = Math.max(1, safeRight - safeLeft);
    const availableHeight = Math.max(1, safeBottom - safeTop);

    const nodeLeft = current.x + input.node.position.x * scale;
    const nodeTop = current.y + input.node.position.y * scale;
    const nodeRight = nodeLeft + input.node.width * scale;
    const nodeBottom = nodeTop + input.node.height * scale;

    if (nodeLeft >= safeLeft && nodeRight <= safeRight && nodeTop >= safeTop && nodeBottom <= safeBottom) {
        return null;
    }

    const source = input.nodes.find((candidate) => candidate.id === input.sourceNodeId && candidate.id !== input.node.id)
        || input.nodes
            .filter((candidate) => candidate.id !== input.node.id && candidate.position.x + candidate.width <= input.node.position.x + 180)
            .sort((a, b) => Math.abs((a.position.y + a.height / 2) - (input.node.position.y + input.node.height / 2)) - Math.abs((b.position.y + b.height / 2) - (input.node.position.y + input.node.height / 2)))[0];
    const visibleNodes = source ? [input.node, source] : [input.node];
    const leftWorld = Math.min(...visibleNodes.map((item) => item.position.x));
    const rightWorld = Math.max(...visibleNodes.map((item) => item.position.x + item.width));
    const topWorld = Math.min(...visibleNodes.map((item) => item.position.y));
    const bottomWorld = Math.max(...visibleNodes.map((item) => item.position.y + item.height));
    const worldWidth = Math.max(1, rightWorld - leftWorld);
    const worldHeight = Math.max(1, bottomWorld - topWorld);

    const fitScale = Math.max(0.1, Math.min(availableWidth / worldWidth, availableHeight / worldHeight));
    const nextScale = Math.min(scale, fitScale);

    let next: ViewportTransform;
    if (Math.abs(nextScale - scale) < 1e-6) {
        const dx = nodeLeft < safeLeft
            ? safeLeft - nodeLeft
            : nodeRight > safeRight
                ? safeRight - nodeRight
                : 0;
        const dy = nodeTop < safeTop
            ? safeTop - nodeTop
            : nodeBottom > safeBottom
                ? safeBottom - nodeBottom
                : 0;
        next = {
            x: current.x + dx,
            y: current.y + dy,
            k: scale,
        };
    } else {
        const centerX = (safeLeft + safeRight) / 2;
        const centerY = (safeTop + safeBottom) / 2;
        next = {
            x: centerX - ((leftWorld + rightWorld) / 2) * nextScale,
            y: centerY - ((topWorld + bottomWorld) / 2) * nextScale,
            k: nextScale,
        };
    }

    if (Math.abs(next.x - current.x) < 1 && Math.abs(next.y - current.y) < 1 && Math.abs(next.k - current.k) < 0.01) return null;
    return next;
}
