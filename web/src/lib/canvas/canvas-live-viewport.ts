import type { CanvasNodeData, SelectionBox, ViewportTransform } from "@/types/canvas";

export const CANVAS_VIEWPORT_PREVIEW_EVENT = "canvas:viewport-preview";
export const CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT = "canvas:graphics-viewport-preview";
export const CANVAS_SELECTION_PREVIEW_EVENT = "canvas:selection-preview";
export const CANVAS_NODE_DRAG_PREVIEW_EVENT = "canvas:node-drag-preview";

export type CanvasNodeDragPreview = {
    x: number;
    y: number;
    nodeIds: ReadonlySet<string>;
    compact?: { nodeId: string; x: number; y: number; scale: number };
};

/** The geometry actually displayed by the transient DOM drag transform. */
export function canvasNodeDragGeometry(node: CanvasNodeData, preview: CanvasNodeDragPreview | null): CanvasNodeData {
    if (!preview?.nodeIds.has(node.id)) return node;
    if (preview.compact?.nodeId === node.id) {
        const { x, y, scale } = preview.compact;
        return { ...node, position: { x, y }, width: node.width * scale, height: node.height * scale };
    }
    return { ...node, position: { x: node.position.x + preview.x, y: node.position.y + preview.y } };
}

type NodeDragPreviewDomState = {
    elementsById: Map<string, HTMLElement>;
    previousIds: Set<string>;
    compactTransform?: { element: HTMLElement; transform: string; origin: string };
    selectionBounds: HTMLElement | null;
};

type NodeSelectionPreviewDomState = {
    elementsById: Map<string, HTMLElement>;
    previousStates: Map<string, "include" | "remove">;
};

export type CanvasNodeSelectionPreview = {
    includeNodeIds: ReadonlySet<string>;
    removeNodeIds: ReadonlySet<string>;
};

const nodeDragPreviewDomStates = new WeakMap<HTMLDivElement, NodeDragPreviewDomState>();
const nodeSelectionPreviewDomStates = new WeakMap<HTMLDivElement, NodeSelectionPreviewDomState>();
const liveViewportElements = new WeakMap<HTMLDivElement, { worldLayer: HTMLElement | null }>();
const scopedScaleStates = new WeakMap<HTMLDivElement, { elements: HTMLElement[]; pinnedElements: HTMLElement[]; dirty: boolean; lastScale: number }>();
const LIVE_SCALE_SELECTOR = "[data-canvas-live-scale], [data-canvas-selection-preview]";
const PINNED_LIVE_SCALE_SELECTOR = '[data-node-lod-pinned="true"] [data-canvas-live-scale], [data-node-lod-pinned="true"][data-canvas-live-scale], [data-canvas-selection-preview]';

function applyScopedElementScale(element: Element, scaleStr: string, inverseStr: string) {
    const style = (element as HTMLElement).style;
    if (!style) return;
    setLiveViewportProperty(style, "--canvas-live-scale", scaleStr);
    setLiveViewportProperty(style, "--canvas-live-inverse-scale", inverseStr);
}

function applyScopedCanvasScale(root: Element, scale: number) {
    const scaleStr = String(scale);
    const inverseStr = String(1 / Math.max(scale, 0.05));
    if (root.matches(LIVE_SCALE_SELECTOR)) applyScopedElementScale(root, scaleStr, inverseStr);
    root.querySelectorAll(LIVE_SCALE_SELECTOR).forEach((el) => applyScopedElementScale(el, scaleStr, inverseStr));
}

function syncScopedCanvasScale(container: HTMLDivElement, scale: number) {
    if (typeof MutationObserver === "undefined" || !(container instanceof Node)) {
        applyScopedCanvasScale(container, scale);
        return;
    }
    let state = scopedScaleStates.get(container);
    if (!state) {
        state = { elements: [], pinnedElements: [], dirty: true, lastScale: NaN };
        scopedScaleStates.set(container, state);
        // Controls can mount while the camera is stationary (e.g. an image error
        // or crop toolbar). Initialize them before paint, without restyling media.
        new MutationObserver((records) => {
            state!.dirty = true;
            const current = Number(container.style.getPropertyValue("--canvas-live-scale")) || 1;
            for (const record of records) {
                if (record.type === "attributes") applyScopedCanvasScale(record.target as Element, current);
                for (const node of record.addedNodes) {
                    if (node instanceof Element) applyScopedCanvasScale(node, current);
                }
            }
        }).observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-canvas-live-scale", "data-canvas-selection-preview", "data-node-lod-pinned"] });
    }
    if (!state.dirty && state.lastScale === scale) return;
    if (state.dirty) {
        state.elements = Array.from(container.querySelectorAll<HTMLElement>(LIVE_SCALE_SELECTOR));
        state.pinnedElements = Array.from(container.querySelectorAll<HTMLElement>(PINNED_LIVE_SCALE_SELECTOR));
        state.dirty = false;
    }
    const scaleStr = String(scale);
    const inverseStr = String(1 / Math.max(scale, 0.05));
    if (container.matches(LIVE_SCALE_SELECTOR)) applyScopedElementScale(container, scaleStr, inverseStr);
    if (container.dataset.canvasLodDomHidden === "true") {
        state.lastScale = NaN;
        for (const element of state.pinnedElements) applyScopedElementScale(element, scaleStr, inverseStr);
        return;
    }
    state.lastScale = scale;
    for (const element of state.elements) applyScopedElementScale(element, scaleStr, inverseStr);
}

export function applyCanvasLiveViewport(container: HTMLDivElement | null, viewport: ViewportTransform, notify = true) {
    if (!container) return;
    const committedScale = Number(container.style.getPropertyValue("--canvas-committed-scale")) || viewport.k;
    let elements = liveViewportElements.get(container);
    if (!elements) {
        elements = {
            worldLayer: container.querySelector<HTMLElement>("[data-canvas-world-layer]"),
        };
        liveViewportElements.set(container, elements);
    }
    const worldLayer = elements.worldLayer;
    if (worldLayer) {
        // 平移期间直接更新合成层，避免修改容器继承变量导致所有节点重新计算样式。
        if (worldLayer.style.transformOrigin !== "0px 0px") worldLayer.style.transformOrigin = "0px 0px";
        worldLayer.style.transform = `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k / committedScale})`;
    }
    // Keep the live camera coordinates observable to overlays and automation
    // while the world layer is moved through a compositor transform.
    setLiveViewportProperty(container.style, "--canvas-live-x", String(viewport.x));
    setLiveViewportProperty(container.style, "--canvas-live-y", String(viewport.y));
    setLiveViewportProperty(container.style, "--canvas-live-scale", String(viewport.k));
    // 外置节点标题用同一帧逆倍率抵消世界层缩放，避免等待 React 提交后再校正尺寸。
    setLiveViewportProperty(container.style, "--canvas-live-inverse-scale", String(1 / Math.max(viewport.k, 0.05)));
    // Registered camera properties do not inherit into thousands of unrelated
    // media descendants. Only controls that use screen-space sizing receive it.
    syncScopedCanvasScale(container, viewport.k);
    // 图形层必须逐帧跟随 DOM 世界层；浮层和滚动通知仍可按原频率节流。
    container.dispatchEvent(new CustomEvent<ViewportTransform>(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, { detail: viewport }));
    if (notify) {
        container.dispatchEvent(new CustomEvent<ViewportTransform>(CANVAS_VIEWPORT_PREVIEW_EVENT, { detail: viewport }));
        // Ant Design overlays watch scrollable ancestors, but CSS transforms do not emit layout events.
        container.dispatchEvent(new Event("scroll"));
    }
}

function setLiveViewportProperty(style: CSSStyleDeclaration, name: string, value: string) {
    if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
}

export function subscribeCanvasGraphicsViewportPreview(container: HTMLDivElement, listener: (viewport: ViewportTransform) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<ViewportTransform>).detail);
    container.addEventListener(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, handlePreview);
}

export function subscribeCanvasViewportPreview(container: HTMLDivElement, listener: (viewport: ViewportTransform) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<ViewportTransform>).detail);
    container.addEventListener(CANVAS_VIEWPORT_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_VIEWPORT_PREVIEW_EVENT, handlePreview);
}

/**
 * Applies transient node movement without changing React state. Only nodes
 * currently mounted in the virtualized world are touched; the committed
 * positions are still written by the drag-end path.
 */
export function applyCanvasNodeDragPreview(container: HTMLDivElement | null, preview: CanvasNodeDragPreview | null) {
    if (!container) return;
    if (preview) container.dataset.canvasNodeDragging = "true";
    else delete container.dataset.canvasNodeDragging;

    let state = nodeDragPreviewDomStates.get(container);
    if (!state) {
        state = { elementsById: new Map(), previousIds: new Set(), selectionBounds: null };
        nodeDragPreviewDomStates.set(container, state);
    }

    if (state.compactTransform) {
        const { element, transform, origin } = state.compactTransform;
        element.style.transform = transform;
        element.style.transformOrigin = origin;
        delete element.dataset.canvasCompactDrag;
        state.compactTransform = undefined;
    }
    for (const nodeId of state.previousIds) {
        state.elementsById.get(nodeId)?.style.removeProperty("translate");
    }
    state.selectionBounds?.style.removeProperty("translate");
    state.selectionBounds?.style.removeProperty("visibility");

    state.previousIds.clear();
    if (preview) {
        // Build the lookup once per drag session. A single DOM scan is much
        // cheaper than one selector query per selected node on every frame.
        if (state.elementsById.size === 0) {
            container.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
                const nodeId = element.dataset.nodeId;
                if (nodeId) state?.elementsById.set(nodeId, element);
            });
            state.selectionBounds = container.querySelector<HTMLElement>("[data-canvas-selection-bounds]");
        }
        for (const nodeId of preview.nodeIds) {
            const element = state.elementsById.get(nodeId);
            if (!element || !element.isConnected) continue;
            if (preview.compact?.nodeId === nodeId) {
                state.compactTransform = { element, transform: element.style.transform, origin: element.style.transformOrigin };
                element.style.transformOrigin = "left top";
                element.style.transform = `translate(${preview.compact.x}px, ${preview.compact.y}px) scale(${preview.compact.scale})`;
                element.dataset.canvasCompactDrag = "true";
            } else element.style.setProperty("translate", `${preview.x}px ${preview.y}px`);
            state.previousIds.add(nodeId);
        }
        if (!state.selectionBounds?.isConnected) {
            state.selectionBounds = container.querySelector<HTMLElement>("[data-canvas-selection-bounds]");
        }
        state.selectionBounds?.style.setProperty("translate", `${preview.x}px ${preview.y}px`);
        if (preview.compact) state.selectionBounds?.style.setProperty("visibility", "hidden");
    } else {
        state.elementsById.clear();
        state.selectionBounds = null;
    }

    container.dispatchEvent(new CustomEvent<CanvasNodeDragPreview | null>(CANVAS_NODE_DRAG_PREVIEW_EVENT, { detail: preview }));
}

export function subscribeCanvasNodeDragPreview(container: HTMLDivElement, listener: (preview: CanvasNodeDragPreview | null) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<CanvasNodeDragPreview | null>).detail);
    container.addEventListener(CANVAS_NODE_DRAG_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_NODE_DRAG_PREVIEW_EVENT, handlePreview);
}

/**
 * Shows the selection delta on mounted nodes without changing React state.
 * The controller commits the final Set once on pointer-up.
 */
export function applyCanvasNodeSelectionPreview(container: HTMLDivElement | null, preview: CanvasNodeSelectionPreview | null) {
    if (!container) return;

    let state = nodeSelectionPreviewDomStates.get(container);
    if (!state) {
        state = { elementsById: new Map(), previousStates: new Map() };
        nodeSelectionPreviewDomStates.set(container, state);
    }

    const nextStates = new Map<string, "include" | "remove">();
    if (preview) {
        for (const nodeId of preview.includeNodeIds) nextStates.set(nodeId, "include");
        for (const nodeId of preview.removeNodeIds) nextStates.set(nodeId, "remove");
    }

    if (state.elementsById.size === 0 && nextStates.size > 0) {
        container.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
            const nodeId = element.dataset.nodeId;
            if (nodeId) state?.elementsById.set(nodeId, element);
        });
    }

    for (const [nodeId, previousState] of state.previousStates) {
        if (nextStates.get(nodeId) === previousState) continue;
        state.elementsById.get(nodeId)?.removeAttribute("data-canvas-selection-preview");
    }
    for (const [nodeId, nextState] of nextStates) {
        if (state.previousStates.get(nodeId) === nextState) continue;
        const element = state.elementsById.get(nodeId);
        if (!element || !element.isConnected) continue;
        element.dataset.canvasSelectionPreview = nextState;
        applyScopedCanvasScale(element, Number(container.style.getPropertyValue("--canvas-live-scale")) || 1);
    }

    state.previousStates = nextStates;
    if (!preview) state.elementsById.clear();
}

export function applyCanvasSelectionPreview(container: HTMLDivElement | null, selection: SelectionBox) {
    container?.dispatchEvent(new CustomEvent<SelectionBox>(CANVAS_SELECTION_PREVIEW_EVENT, { detail: selection }));
}

export function subscribeCanvasSelectionPreview(container: HTMLDivElement, listener: (selection: SelectionBox) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<SelectionBox>).detail);
    container.addEventListener(CANVAS_SELECTION_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_SELECTION_PREVIEW_EVENT, handlePreview);
}
