import type { ViewportTransform } from "@/types/canvas";

export const CANVAS_VIRTUALIZATION_REFRESH_INTERVAL_MS = 64;
/** Largest screen-space pre-render margin a pan or zoom gesture grows to. */
export const CANVAS_GESTURE_RENDER_PADDING_PX = 320;
/** Each gesture refresh widens the margin by this much, so no single refresh mounts a wide ring of cards. */
const CANVAS_GESTURE_PADDING_STEP_PX = 64;
/** Nodes mounted earlier in a gesture stay mounted until it ends, up to this many. */
export const CANVAS_GESTURE_RETAIN_LIMIT = 240;
/** Base enter padding in screen pixels (see canvasNodeRenderPadding). */
const CANVAS_MIN_ENTER_PADDING_PX = 128;
/** Movement budget for one refresh interval inside the pre-rendered margin. */
const CANVAS_REFRESH_SAFETY_PX = 128;

type ViewportSize = { width: number; height: number };

/**
 * The window the controller asks the render model to mount during a gesture.
 * The margin travels with the camera so both sides use the same number.
 */
export type CanvasVirtualizationViewport = ViewportTransform & { renderPaddingPx?: number };

/** Pre-render margin after `refreshCount` refreshes of the current gesture. */
export function canvasGestureRenderPadding(refreshCount: number) {
    if (refreshCount <= 0) return CANVAS_MIN_ENTER_PADDING_PX;
    return Math.min(CANVAS_GESTURE_RENDER_PADDING_PX, CANVAS_MIN_ENTER_PADDING_PX + CANVAS_GESTURE_PADDING_STEP_PX * refreshCount);
}

/**
 * A page-level refresh mounts nodes for a new camera window. It is only needed
 * once the live view gets close to the edge of what the last refresh already
 * mounted; until then the compositor transform alone moves the world.
 *
 * `renderedPaddingPx` is the screen-space margin `rendered` was mounted with.
 */
export function shouldRefreshCanvasVirtualization(rendered: ViewportTransform, next: ViewportTransform, lastRefreshAt: number, now: number, size?: ViewportSize, renderedPaddingPx = CANVAS_MIN_ENTER_PADDING_PX) {
    if (rendered.x === next.x && rendered.y === next.y && rendered.k === next.k) return false;
    if (now - lastRefreshAt < CANVAS_VIRTUALIZATION_REFRESH_INTERVAL_MS) return false;
    if (!size) return true;
    const safetyPx = next.k < rendered.k ? 0 : CANVAS_REFRESH_SAFETY_PX;
    const margin = Math.max(0, renderedPaddingPx - safetyPx) / rendered.k;
    const coveredLeft = -rendered.x / rendered.k - margin;
    const coveredTop = -rendered.y / rendered.k - margin;
    const coveredRight = (size.width - rendered.x) / rendered.k + margin;
    const coveredBottom = (size.height - rendered.y) / rendered.k + margin;
    const liveLeft = -next.x / next.k;
    const liveTop = -next.y / next.k;
    const liveRight = (size.width - next.x) / next.k;
    const liveBottom = (size.height - next.y) / next.k;
    return liveLeft < coveredLeft || liveTop < coveredTop || liveRight > coveredRight || liveBottom > coveredBottom;
}

const GESTURE_DOM_REBASE_MIN_RATIO = 0.625;
const GESTURE_DOM_REBASE_MAX_RATIO = 1.6;

/**
 * Mid-gesture, DOM cards are scaled by the world-layer transform alone. Their
 * React scale props are re-committed only once that stretch is large enough to
 * soften text and controls visibly; the final camera commits on gesture end.
 */
export function shouldCommitCanvasScaleDuringGesture(next: ViewportTransform, committed: ViewportTransform) {
    const ratio = next.k / Math.max(committed.k, 0.05);
    return ratio < GESTURE_DOM_REBASE_MIN_RATIO || ratio > GESTURE_DOM_REBASE_MAX_RATIO;
}
