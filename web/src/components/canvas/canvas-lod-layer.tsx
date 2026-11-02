import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import { canvasLodContainRect, canvasLodHitTest, type CanvasLodDragOffset } from "@/lib/canvas/canvas-lod";
import { getCanvasLodThumbnail, setCanvasLodRedrawListener } from "@/lib/canvas/canvas-lod-thumbnails";
import { subscribeCanvasGraphicsViewportPreview, subscribeCanvasNodeDragPreview } from "@/lib/canvas/canvas-live-viewport";
import { sortCanvasNodesByStackOrder, type CanvasNodeStackOrder } from "@/lib/canvas/canvas-node-stack-order";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

type CanvasLodLayerProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    active: boolean;
    interactive?: boolean;
    viewport: ViewportTransform;
    /** Every displayed regular node; interactive ones are also mounted as DOM cards on top. */
    nodes: CanvasNodeData[];
    nodeStackOrder: CanvasNodeStackOrder;
    selectedNodeIds: ReadonlySet<string>;
    theme: CanvasTheme;
    onNodePointerDown: (event: PointerEvent, nodeId: string) => void;
    onNodeContextMenu: (event: MouseEvent, nodeId: string) => void;
    onNodeDoubleClick: (node: CanvasNodeData) => void;
    onHoverNodeChange: (nodeId: string | null) => void;
};

// Mirrors InfiniteCanvas: floating UI and explicit no-zoom controls keep their events.
const POINTER_IGNORE_SELECTOR = "[data-canvas-no-zoom],[data-connection-create-menu],[data-connection-id],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown";
const NODE_RADIUS = 12;
const LOD_BACKING_RELEASE_MS = 30_000;

function lodPixelRatio() {
    return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
}

/**
 * Overview renderer: one screen-space canvas below the DOM world layer. It
 * is redrawn in the same animation frame as the world transform, so it never
 * lags the DOM cards that remain mounted for interaction.
 */
export function CanvasLodLayer(props: CanvasLodLayerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const viewportRef = useRef(props.viewport);
    const dragRef = useRef<CanvasLodDragOffset>(null);
    const sizeRef = useRef({ width: 0, height: 0, dpr: 1, left: 0, top: 0 });
    const frameRef = useRef<number | null>(null);
    const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverRef = useRef<string | null>(null);
    // Child layout effects run before the viewport's own ref is attached.
    const resolveContainer = useCallback(() => props.containerRef.current || canvasRef.current?.closest<HTMLDivElement>("[data-canvas-viewport]") || null, [props.containerRef]);

    const ensureCanvasBackingSize = useCallback((canvas: HTMLCanvasElement) => {
        const { width, height, dpr } = sizeRef.current;
        const pixelWidth = width > 0 ? Math.max(1, Math.round(width * dpr)) : 0;
        const pixelHeight = height > 0 ? Math.max(1, Math.round(height * dpr)) : 0;
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    }, []);

    const orderedNodes = useMemo(() => {
        const sorted = sortCanvasNodesByStackOrder(props.nodes, props.nodeStackOrder);
        if (!props.selectedNodeIds.size) return sorted;
        // Selected DOM cards are raised above their peers; keep the same order.
        return [...sorted.filter((node) => !props.selectedNodeIds.has(node.id)), ...sorted.filter((node) => props.selectedNodeIds.has(node.id))];
    }, [props.nodeStackOrder, props.nodes, props.selectedNodeIds]);
    const orderedRef = useRef(orderedNodes);
    orderedRef.current = orderedNodes;

    const draw = useCallback(() => {
        const { active, theme, selectedNodeIds } = propsRef.current;
        const { width, height, dpr } = sizeRef.current;
        if (!active || !width || !height) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        const viewport = viewportRef.current;
        const k = viewport.k;
        context.setTransform(dpr * k, 0, 0, dpr * k, dpr * viewport.x, dpr * viewport.y);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "medium";
        const viewLeft = -viewport.x / k;
        const viewTop = -viewport.y / k;
        const viewRight = viewLeft + width / k;
        const viewBottom = viewTop + height / k;
        const pixel = 1 / k;
        const radius = NODE_RADIUS * k >= 1.5 ? NODE_RADIUS : 0;
        const drag = dragRef.current;
        const requestRedraw = scheduleDrawRef.current;
        const container = propsRef.current.containerRef.current;
        const allowQueue = container?.dataset.canvasViewportInteracting !== "true" && container?.dataset.canvasNodeDragging !== "true";
        for (const node of orderedRef.current) {
            const moved = drag?.nodeIds.has(node.id);
            const x = node.position.x + (moved ? drag!.x : 0);
            const y = node.position.y + (moved ? drag!.y : 0);
            const w = node.width;
            const h = node.height;
            if (x > viewRight || y > viewBottom || x + w < viewLeft || y + h < viewTop) continue;
            const box = { x, y, width: w, height: h };
            const isMedia = (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content || node.metadata?.previewContent);
            if (node.metadata?.isBatchRoot && (node.metadata.batchChildIds?.length || 0) > 1) {
                context.fillStyle = theme.node.panel;
                context.strokeStyle = theme.node.stroke;
                context.lineWidth = pixel;
                for (const offset of [2, 1]) {
                    fillBox(context, { x: x + 18 * offset, y: y + 10 * offset, width: w, height: h }, radius);
                    context.stroke();
                }
            }
            if (isMedia) {
                const thumbnail = getCanvasLodThumbnail(node, requestRedraw, allowQueue);
                if (thumbnail && thumbnail !== "failed") {
                    const rect = canvasLodContainRect(box, thumbnail.width, thumbnail.height, Boolean(node.metadata?.freeResize));
                    context.drawImage(thumbnail.source, rect.x, rect.y, rect.width, rect.height);
                } else {
                    context.fillStyle = theme.node.stroke;
                    fillBox(context, box, radius);
                }
                if (node.type === CanvasNodeType.Video) drawPlayBadge(context, box, k);
            } else {
                context.fillStyle = theme.node.fill;
                fillBox(context, box, radius);
                drawTextHint(context, box, k, theme.node.faint);
            }
            if (node.metadata?.status === "error") {
                context.strokeStyle = theme.accent.danger;
                context.lineWidth = 2 * pixel;
                strokeBox(context, box, radius);
            }
            if (selectedNodeIds.has(node.id)) {
                context.strokeStyle = theme.node.activeStroke;
                context.lineWidth = 2 * pixel;
                strokeBox(context, { x: x - 2 * pixel, y: y - 2 * pixel, width: w + 4 * pixel, height: h + 4 * pixel }, radius);
            }
        }
    }, []);

    const scheduleDraw = useCallback(() => {
        if (frameRef.current !== null) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            draw();
        });
    }, [draw]);
    const scheduleDrawRef = useRef(scheduleDraw);
    scheduleDrawRef.current = scheduleDraw;

    useEffect(() => {
        if (!props.active) return;
        setCanvasLodRedrawListener(scheduleDraw);
        return () => setCanvasLodRedrawListener(null);
    }, [props.active, scheduleDraw]);

    useEffect(() => () => {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        if (releaseTimerRef.current !== null) clearTimeout(releaseTimerRef.current);
    }, []);

    // Size the backing store from observer callbacks only; never read layout
    // while drawing a gesture frame.
    useLayoutEffect(() => {
        const container = resolveContainer();
        const canvas = canvasRef.current;
        if (!container || !canvas) return;
        const resize = () => {
            const rect = container.getBoundingClientRect();
            const dpr = lodPixelRatio();
            sizeRef.current = { width: rect.width, height: rect.height, dpr, left: rect.left, top: rect.top };
            if (propsRef.current.active || canvas.width > 0 || canvas.height > 0) {
                ensureCanvasBackingSize(canvas);
            }
            draw();
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(container);
        window.addEventListener("resize", resize);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", resize);
        };
    }, [draw, ensureCanvasBackingSize, resolveContainer]);

    useLayoutEffect(() => {
        viewportRef.current = props.viewport;
    }, [props.viewport]);

    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        if (!props.active) {
            if (canvas && canvas.width && canvas.height) {
                canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
                if (releaseTimerRef.current === null) {
                    releaseTimerRef.current = setTimeout(() => {
                        releaseTimerRef.current = null;
                        if (!propsRef.current.active && canvasRef.current) {
                            canvasRef.current.width = 0;
                            canvasRef.current.height = 0;
                        }
                    }, LOD_BACKING_RELEASE_MS);
                }
            }
            return;
        }
        if (releaseTimerRef.current !== null) {
            clearTimeout(releaseTimerRef.current);
            releaseTimerRef.current = null;
        }
        if (canvas) {
            if (!sizeRef.current.width || !sizeRef.current.height) {
                const container = resolveContainer();
                if (container) {
                    const rect = container.getBoundingClientRect();
                    sizeRef.current = { width: rect.width, height: rect.height, dpr: lodPixelRatio(), left: rect.left, top: rect.top };
                }
            }
            ensureCanvasBackingSize(canvas);
        }
        draw();
    }, [draw, ensureCanvasBackingSize, orderedNodes, props.active, props.selectedNodeIds, props.theme, resolveContainer]);

    useLayoutEffect(() => {
        const container = resolveContainer();
        if (!container) return;
        const stopViewport = subscribeCanvasGraphicsViewportPreview(container, (next) => {
            viewportRef.current = next;
            if (propsRef.current.active) draw();
        });
        const stopDrag = subscribeCanvasNodeDragPreview(container, (preview) => {
            dragRef.current = preview ? { x: preview.x, y: preview.y, nodeIds: preview.nodeIds } : null;
            if (propsRef.current.active) draw();
        });
        return () => {
            stopViewport();
            stopDrag();
        };
    }, [draw, resolveContainer]);

    useEffect(() => {
        const container = resolveContainer();
        if (!container || !props.active || props.interactive === false) return;
        const worldPoint = (event: MouseEvent) => {
            const viewport = viewportRef.current;
            const { left, top } = sizeRef.current;
            return { x: (event.clientX - left - viewport.x) / viewport.k, y: (event.clientY - top - viewport.y) / viewport.k };
        };
        const hitNode = (event: MouseEvent) => {
            if (!isOverviewTarget(event.target)) return null;
            return canvasLodHitTest(orderedRef.current, worldPoint(event), dragRef.current);
        };
        const setHover = (nodeId: string | null) => {
            if (hoverRef.current === nodeId) return;
            hoverRef.current = nodeId;
            propsRef.current.onHoverNodeChange(nodeId);
        };
        const handlePointerDown = (event: PointerEvent) => {
            if (event.button !== 0 || event.pointerType === "touch") return;
            // InfiniteCanvas owns Space + drag even when the press hits an
            // overview node. Its normal node path also leaves pointerdown free.
            if (container.dataset.canvasSpacePressed === "true") return;
            const node = hitNode(event);
            if (!node) return;
            // The node owns this press; the canvas must not start a pan or box select.
            event.stopPropagation();
            setHover(node.id);
            propsRef.current.onNodePointerDown(event, node.id);
        };
        const handleContextMenu = (event: MouseEvent) => {
            const node = hitNode(event);
            if (!node) return;
            propsRef.current.onNodeContextMenu(event, node.id);
        };
        const handleDoubleClick = (event: MouseEvent) => {
            const node = hitNode(event);
            if (!node) return;
            event.stopPropagation();
            propsRef.current.onNodeDoubleClick(node);
        };
        let pendingMove: PointerEvent | null = null;
        let moveFrame: number | null = null;
        const handlePointerMove = (event: PointerEvent) => {
            pendingMove = event;
            if (moveFrame !== null) return;
            moveFrame = requestAnimationFrame(() => {
                moveFrame = null;
                const move = pendingMove;
                pendingMove = null;
                if (!move || move.buttons !== 0) return;
                if (container.dataset.canvasViewportInteracting === "true" || container.dataset.canvasNodeDragging === "true") return;
                const target = move.target instanceof Element ? move.target : null;
                // The promoted DOM card handles its own hover state.
                const domNode = target?.closest("[data-node-id]");
                if (domNode && domNode.getAttribute("data-canvas-node-type") !== CanvasNodeType.Frame) return;
                setHover(hitNode(move)?.id ?? null);
            });
        };
        const handlePointerLeave = () => setHover(null);
        container.addEventListener("pointerdown", handlePointerDown, { capture: true });
        container.addEventListener("contextmenu", handleContextMenu, { capture: true });
        container.addEventListener("dblclick", handleDoubleClick, { capture: true });
        container.addEventListener("pointermove", handlePointerMove, { passive: true });
        container.addEventListener("pointerleave", handlePointerLeave);
        return () => {
            container.removeEventListener("pointerdown", handlePointerDown, { capture: true });
            container.removeEventListener("contextmenu", handleContextMenu, { capture: true });
            container.removeEventListener("dblclick", handleDoubleClick, { capture: true });
            container.removeEventListener("pointermove", handlePointerMove);
            container.removeEventListener("pointerleave", handlePointerLeave);
            if (moveFrame !== null) cancelAnimationFrame(moveFrame);
            setHover(null);
        };
    }, [props.active, props.interactive, resolveContainer]);

    return (
        <canvas
            ref={canvasRef}
            aria-hidden
            data-canvas-lod-layer={props.active ? "active" : "idle"}
            className="pointer-events-none absolute inset-0"
            style={{ width: "100%", height: "100%", visibility: props.active ? "visible" : "hidden" }}
        />
    );
}

function isOverviewTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return false;
    if (target.closest(POINTER_IGNORE_SELECTOR)) return false;
    const domNode = target.closest("[data-node-id]");
    // Frames paint beneath regular nodes, so an overview node over a frame wins.
    return !domNode || domNode.getAttribute("data-canvas-node-type") === CanvasNodeType.Frame;
}

function fillBox(context: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number }, radius: number) {
    if (!radius || typeof context.roundRect !== "function") {
        context.beginPath();
        context.rect(box.x, box.y, box.width, box.height);
        context.fill();
        return;
    }
    context.beginPath();
    context.roundRect(box.x, box.y, box.width, box.height, radius);
    context.fill();
}

function strokeBox(context: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number }, radius: number) {
    context.beginPath();
    if (radius && typeof context.roundRect === "function") context.roundRect(box.x, box.y, box.width, box.height, radius);
    else context.rect(box.x, box.y, box.width, box.height);
    context.stroke();
}

function drawPlayBadge(context: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number }, k: number) {
    // Matches the DOM card's 44px play button, which scales with the card.
    const radius = 22;
    if (radius * k < 3) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    context.fillStyle = "rgba(0,0,0,0.62)";
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.moveTo(cx - 6, cy - 9);
    context.lineTo(cx + 10, cy);
    context.lineTo(cx - 6, cy + 9);
    context.closePath();
    context.fill();
}

function drawTextHint(context: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number }, k: number, color: string) {
    // Unreadable text is summarized as lines, like other overview renderers.
    if (box.height * k < 24 || box.width * k < 24) return;
    const inset = Math.min(24, box.width * 0.1);
    const lineHeight = Math.max(14, box.height / 9);
    context.fillStyle = color;
    context.globalAlpha = 0.45;
    for (let index = 0; index < 4; index += 1) {
        const y = box.y + inset + index * lineHeight * 1.6;
        if (y + lineHeight > box.y + box.height - inset) break;
        const width = (box.width - inset * 2) * (index === 3 ? 0.55 : 1);
        context.fillRect(box.x + inset, y, width, lineHeight * 0.6);
    }
    context.globalAlpha = 1;
}
