import type { CanvasNodeData, Position } from "@/types/canvas";

/**
 * Overview level-of-detail.
 *
 * When cards are only a few dozen screen pixels wide, every node is still
 * displayed, but as a thumbnail drawn into one screen-space canvas instead of
 * a full DOM card. WebKit then commits one layer instead of hundreds of card,
 * title and control layers. Interactive nodes (hovered, selected, playing,
 * being edited) stay as DOM cards on top.
 *
 * Enter and exit thresholds differ so a zoom that hovers around the boundary
 * does not repeatedly mount and unmount the whole visible set.
 */
export const CANVAS_LOD_ENTER_SCREEN_PX = 140;
export const CANVAS_LOD_EXIT_SCREEN_PX = 172;

/** Median of each node's larger side, in world units. */
export function canvasLodTypicalNodeExtent(nodes: readonly Pick<CanvasNodeData, "width" | "height">[]) {
    if (!nodes.length) return 0;
    const extents = nodes.map((node) => Math.max(node.width, node.height)).sort((a, b) => a - b);
    return extents[Math.floor(extents.length / 2)];
}

export function resolveCanvasLodActive({ previous, typicalExtent, scale, deferExit }: { previous: boolean; typicalExtent: number; scale: number; deferExit: boolean }) {
    if (!(typicalExtent > 0) || !(scale > 0)) return false;
    const screenExtent = typicalExtent * scale;
    if (previous) {
        // Leaving overview mounts many cards at once; do it after the gesture.
        if (deferExit) return true;
        return screenExtent < CANVAS_LOD_EXIT_SCREEN_PX;
    }
    return screenExtent < CANVAS_LOD_ENTER_SCREEN_PX;
}

export type CanvasLodDragOffset = { x: number; y: number; nodeIds: ReadonlySet<string> } | null;

/** Topmost node under a world point. `nodes` must be in paint order. */
export function canvasLodHitTest<T extends Pick<CanvasNodeData, "id" | "position" | "width" | "height">>(nodes: readonly T[], point: Position, drag: CanvasLodDragOffset = null): T | null {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        const dx = drag?.nodeIds.has(node.id) ? drag.x : 0;
        const dy = drag?.nodeIds.has(node.id) ? drag.y : 0;
        const left = node.position.x + dx;
        const top = node.position.y + dy;
        if (point.x >= left && point.x <= left + node.width && point.y >= top && point.y <= top + node.height) return node;
    }
    return null;
}

/** object-fit: contain inside a node box. */
export function canvasLodContainRect(box: { x: number; y: number; width: number; height: number }, sourceWidth: number, sourceHeight: number, fill = false) {
    if (fill || !(sourceWidth > 0) || !(sourceHeight > 0)) return box;
    const ratio = Math.min(box.width / sourceWidth, box.height / sourceHeight);
    const width = sourceWidth * ratio;
    const height = sourceHeight * ratio;
    return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}
