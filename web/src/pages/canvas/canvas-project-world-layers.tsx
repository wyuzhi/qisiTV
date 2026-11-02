import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Link2 } from "lucide-react";

import { ConnectionPath, canvasConnectionPath } from "@/components/canvas/canvas-connections";
import { canvasNodeDragGeometry, subscribeCanvasNodeDragPreview, type CanvasNodeDragPreview } from "@/lib/canvas/canvas-live-viewport";
import { CanvasFrameNode } from "@/components/canvas/canvas-frame-node";
import { CanvasNode } from "@/components/canvas/canvas-node";
import type { CanvasVideoCropRect } from "@/components/canvas/canvas-video-crop-dialog";
import type { CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import type { CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasConnectionApproach } from "@/lib/canvas/canvas-connection-tilt";
import type { CanvasBatchConnectionPreview } from "@/lib/canvas/canvas-batch-connection";
import { sortCanvasNodesByStackOrder, type CanvasNodeStackOrder } from "@/lib/canvas/canvas-node-stack-order";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { isFrameNode } from "@/lib/canvas/canvas-frame";
import type { CanvasDisplayConnection, CanvasFolderStyle, CanvasFolderTheme, CanvasNodeData, ConnectionHandle, Position, SelectionBox } from "@/types/canvas";

type DragPreview = { x: number; y: number; nodeIds: Set<string> } | null;
type NodeBounds = { left: number; top: number; width: number; height: number; count: number } | null;

type CanvasProjectWorldLayersProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    projectId: string;
    viewportScale: number;
    displayConnections: CanvasDisplayConnection[];
    selectedConnectionId: string | null;
    relatedConnectionIds: Set<string>;
    scriptScrollTopById: Record<string, number>;
    connectingParams: ConnectionHandle | null;
    mouseWorld: Position;
    connectionTargetNodeId: string | null;
    connectionApproach: CanvasConnectionApproach;
    nodeById: Map<string, CanvasNodeData>;
    visibleNodes: CanvasNodeData[];
    nodeStackOrder: CanvasNodeStackOrder;
    frameChildrenById: Map<string, CanvasNodeData[]>;
    linkedFolderPreviewNodesById: Map<string, CanvasNodeData[]>;
    dragPreview: DragPreview;
    selectedNodeIds: Set<string>;
    lodPinnedNodeIds?: ReadonlySet<string>;
    /** Playing media node; owned by the page so the overview keeps it mounted. */
    activeMediaNodeId: string | null;
    onActiveMediaNodeChange: (nodeId: string | null) => void;
    frameDropTargetId: string | null;
    relatedNodeIds: Set<string>;
    activeNodeId: string | null;
    selectionBox: SelectionBox | null;
    batchChildCountById: Map<string, number>;
    collapsingBatchIds: Set<string>;
    openingBatchIds: Set<string>;
    batchMotionById: Map<string, { x: number; y: number; index: number }>;
    showImageInfo: boolean;
    reduceMediaEffects: boolean;
    resourceReferenceByNodeId: Map<string, CanvasResourceReference>;
    mentionReferencesByNodeId: Map<string, CanvasResourceReference[]>;
    mediaEffectsDisabledNodeId?: string | null;
    selectedNodeBounds: NodeBounds;
    batchSourceNodeIds: string[];
    batchConnectionPreview: CanvasBatchConnectionPreview | null;
    selectionBoundsElementRef: RefObject<HTMLDivElement | null>;
    renderCanvasNodeContent: (node: CanvasNodeData) => ReactNode;
    onConnectionSelect: (connectionId: string) => void;
    onConnectionContextMenu: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
    onNodeMouseDown: (event: ReactMouseEvent, nodeId: string) => void;
    onNodeHoverStart: (nodeId: string) => void;
    onNodeHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: ReactPointerEvent, nodeId: string, handleType: "source" | "target", handleId?: string, anchorRatio?: number) => void;
    onNodeResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onToggleFrame: (nodeId: string) => void;
    onFolderStyleChange: (nodeId: string, style: CanvasFolderStyle) => void;
    onFolderThemeChange: (nodeId: string, theme: CanvasFolderTheme) => void;
    onNodeTitleChange: (nodeId: string, title: string) => void;
    onNodeContextMenu: (event: ReactMouseEvent, nodeId: string) => void;
    onNodeContentChange: (nodeId: string, content: string) => void;
    onToggleBatch: (nodeId: string) => void;
    onSetBatchPrimary: (node: CanvasNodeData) => void;
    onRetry: (node: CanvasNodeData) => void;
    onReloadResource: (node: CanvasNodeData) => void;
    onOpenTaskDetails: (node: CanvasNodeData) => void;
    onCancelTask?: (node: CanvasNodeData) => void;
    onOpenVersions: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onReplaceMedia: (node: CanvasNodeData) => void;
    onOpenTextEditor: (node: CanvasNodeData) => void;
    onOpenDrawing: (node: CanvasNodeData) => void;
    onStartBatchConnection: (event: ReactPointerEvent, sourceNodeIds: string[]) => void;
    imageCropNodeId?: string | null;
    onCancelImageCrop?: () => void;
    onConfirmImageCrop?: (node: CanvasNodeData, crop: CanvasImageCropRect) => void | Promise<void>;
    annotationNodeId?: string | null;
    onCancelAnnotation?: () => void;
    onConfirmAnnotation?: (node: CanvasNodeData, dataUrl: string) => void | Promise<void>;
    maskEditNodeId?: string | null;
    maskEditConfig?: AiConfig;
    onCancelMaskEdit?: () => void;
    onConfirmMaskEdit?: (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => void | Promise<void>;
    videoCropNodeId?: string | null;
    onCancelVideoCrop?: () => void;
    onConfirmVideoCrop?: (node: CanvasNodeData, crop: CanvasVideoCropRect, sourceDimensions: { width: number; height: number }) => void | Promise<void>;
};

const EMPTY_RESOURCE_REFERENCES: CanvasResourceReference[] = [];
const EMPTY_CANVAS_NODES: CanvasNodeData[] = [];

export const CanvasProjectWorldLayers = memo(function CanvasProjectWorldLayers(props: CanvasProjectWorldLayersProps) {
    const { viewportScale } = props;
    const retryRef = useRef(props.onRetry);
    useLayoutEffect(() => { retryRef.current = props.onRetry; }, [props.onRetry]);
    // Retry is an event, not node display state. Keep its identity stable while
    // always invoking the handler from the latest committed project render.
    const retryNode = useCallback((node: CanvasNodeData) => retryRef.current(node), []);
    const connectionLayerRef = useRef<SVGSVGElement>(null);
    const connectionDragPreviewRef = useRef<{ container: HTMLDivElement; projectId: string; preview: CanvasNodeDragPreview } | null>(null);
    useLayoutEffect(() => {
        const layer = connectionLayerRef.current;
        const container = props.containerRef.current || layer?.closest<HTMLDivElement>("[data-canvas-viewport]");
        if (!container || !layer) return;
        const groups = new Map<string, SVGGElement>();
        layer.querySelectorAll<SVGGElement>("g[data-canvas-connection-id]").forEach((group) => {
            const id = group.dataset.canvasConnectionId;
            if (id) groups.set(id, group);
        });
        const connectionsByNodeId = new Map<string, Set<CanvasDisplayConnection>>();
        for (const display of props.displayConnections) {
            for (const nodeId of [display.from.id, display.to.id]) {
                let adjacent = connectionsByNodeId.get(nodeId);
                if (!adjacent) connectionsByNodeId.set(nodeId, adjacent = new Set());
                adjacent.add(display);
            }
        }
        let previousConnections = new Set<CanvasDisplayConnection>();
        const updatePreview = (preview: CanvasNodeDragPreview | null) => {
            connectionDragPreviewRef.current = preview ? { container, projectId: props.projectId, preview } : null;
            const currentConnections = new Set<CanvasDisplayConnection>();
            for (const nodeId of preview?.nodeIds || []) {
                for (const display of connectionsByNodeId.get(nodeId) || []) currentConnections.add(display);
            }
            // Reset edges leaving the preview as well, including cancellation.
            const affectedConnections = new Set([...previousConnections, ...currentConnections]);
            previousConnections = currentConnections;
            for (const { connection, from, to } of affectedConnections) {
                const group = groups.get(connection.id);
                if (!group) continue;
                const movedFrom = canvasNodeDragGeometry(from, preview);
                const movedTo = canvasNodeDragGeometry(to, preview);
                const { pathD, startX, startY, endX, endY } = canvasConnectionPath(connection, movedFrom, movedTo, props.scriptScrollTopById[from.id] || 0, props.scriptScrollTopById[to.id] || 0);
                group.querySelectorAll<SVGPathElement>("path[d]").forEach((path) => path.setAttribute("d", pathD));
                const endpoints = group.querySelectorAll<SVGCircleElement>("circle");
                endpoints[0]?.setAttribute("cx", String(startX));
                endpoints[0]?.setAttribute("cy", String(startY));
                endpoints[1]?.setAttribute("cx", String(endX));
                endpoints[1]?.setAttribute("cy", String(endY));
                const gradient = group.querySelector<SVGLinearGradientElement>("linearGradient[gradientUnits]");
                gradient?.setAttribute("x1", String(startX));
                gradient?.setAttribute("y1", String(startY));
                gradient?.setAttribute("x2", String(endX));
                gradient?.setAttribute("y2", String(endY));
            }
        };
        // Layout effects may refresh while a pointer is still captured. Reapply
        // its preview before paint and keep cancellation tied to those edges.
        const retained = connectionDragPreviewRef.current;
        if (retained?.container === container && retained.projectId === props.projectId) updatePreview(retained.preview);
        else if (retained) {
            for (const nodeId of retained.preview.nodeIds) {
                for (const display of connectionsByNodeId.get(nodeId) || []) previousConnections.add(display);
            }
            updatePreview(null);
        }
        const unsubscribe = subscribeCanvasNodeDragPreview(container, updatePreview);
        // Hover mounts extra strokes inside a memoized connection. Keep newly
        // mounted strokes aligned even while the pointer is paused mid-drag.
        const observer = new MutationObserver(() => {
            const live = connectionDragPreviewRef.current;
            if (live) updatePreview(live.preview);
        });
        observer.observe(layer, { childList: true, subtree: true });
        return () => {
            unsubscribe();
            observer.disconnect();
        };
    }, [props.containerRef, props.displayConnections, props.projectId, props.scriptScrollTopById]);
    const { activeMediaNodeId, onActiveMediaNodeChange: setActiveMediaNodeId } = props;
    useEffect(() => {
        if (activeMediaNodeId && !props.nodeById.has(activeMediaNodeId)) setActiveMediaNodeId(null);
    }, [activeMediaNodeId, props.nodeById, setActiveMediaNodeId]);
    const orderedVisibleNodes = useMemo(() => [
        ...props.visibleNodes.filter(isFrameNode),
        ...sortCanvasNodesByStackOrder(props.visibleNodes.filter((node) => !isFrameNode(node)), props.nodeStackOrder),
    ], [props.nodeStackOrder, props.visibleNodes]);
    const batchPreviews = useMemo(() => new Map(props.visibleNodes.filter((node) => node.metadata?.isBatchRoot).map((node) => [
        node.id,
        (node.metadata?.batchChildIds || []).filter((id) => id !== node.metadata?.primaryImageId)
            .map((id) => props.nodeById.get(id))
            .filter((child): child is CanvasNodeData => Boolean(child && child.metadata?.batchRootId === node.id))
            .slice(0, 5),
    ])), [props.visibleNodes, props.nodeById]);
    const framePreviewNodes = (node: CanvasNodeData) => {
        const assetFolderId = node.metadata?.folder?.assetFolderId;
        if (assetFolderId) return props.linkedFolderPreviewNodesById.get(assetFolderId) || EMPTY_CANVAS_NODES;
        const localChildren = props.frameChildrenById.get(node.id) || EMPTY_CANVAS_NODES;
        if (localChildren.length) return localChildren;
        return EMPTY_CANVAS_NODES;
    };
    return (
        <>
            {/* Paths already use world coordinates. A viewport-sized SVG grows
                as 1 / zoom and makes WebKit allocate a huge empty surface. */}
            {props.displayConnections.length > 0 ? <svg
                ref={connectionLayerRef}
                className="absolute overflow-visible"
                width={1}
                height={1}
                style={{ left: 0, top: 0, pointerEvents: "none", zIndex: 0 }}
            >
                {props.displayConnections.map(({ connection, from, to }) => (
                    <ConnectionPath
                        key={connection.id}
                        connection={connection}
                        from={from}
                        to={to}
                        fromScrollTop={props.scriptScrollTopById[from.id] || 0}
                        toScrollTop={props.scriptScrollTopById[to.id] || 0}
                        active={props.selectedConnectionId === connection.id || props.relatedConnectionIds.has(connection.id)}
                        visualMode="full"
                        onSelect={() => props.onConnectionSelect(connection.id)}
                        onContextMenu={(event) => props.onConnectionContextMenu(event, connection.id)}
                    />
                ))}
            </svg> : null}

            {orderedVisibleNodes.map((node) =>
                isFrameNode(node) ? (
                    <CanvasFrameNode
                        key={node.id}
                        data={node}
                        dragOffset={props.dragPreview?.nodeIds.has(node.id) ? props.dragPreview : undefined}
                        childNodes={framePreviewNodes(node)}
                        scale={viewportScale}
                        isSelected={props.selectedNodeIds.has(node.id)}
                        isDropTarget={props.frameDropTargetId === node.id}
                        onMouseDown={props.onNodeMouseDown}
                        onResize={props.onNodeResize}
                        onToggleCollapsed={props.onToggleFrame}
                        onFolderStyleChange={props.onFolderStyleChange}
                        onFolderThemeChange={props.onFolderThemeChange}
                        onTitleChange={props.onNodeTitleChange}
                        onContextMenu={props.onNodeContextMenu}
                    />
                ) : (
                    <CanvasNode
                        key={node.id}
                        data={node}
                        dragOffset={props.dragPreview?.nodeIds.has(node.id) ? props.dragPreview : undefined}
                        scale={viewportScale}
                        lodPinned={props.lodPinnedNodeIds?.has(node.id)}
                        isSelected={props.selectedNodeIds.has(node.id)}
                        mediaActive={activeMediaNodeId === node.id}
                        onMediaPlayRequest={setActiveMediaNodeId}
                        imageCropActive={props.imageCropNodeId === node.id}
                        onCancelImageCrop={props.onCancelImageCrop}
                        onConfirmImageCrop={props.onConfirmImageCrop}
                        annotationActive={props.annotationNodeId === node.id}
                        onCancelAnnotation={props.onCancelAnnotation}
                        onConfirmAnnotation={props.onConfirmAnnotation}
                        maskEditActive={props.maskEditNodeId === node.id}
                        maskEditConfig={props.maskEditConfig}
                        onCancelMaskEdit={props.onCancelMaskEdit}
                        onConfirmMaskEdit={props.onConfirmMaskEdit}
                        videoCropActive={props.videoCropNodeId === node.id}
                        onCancelVideoCrop={props.onCancelVideoCrop}
                        onConfirmVideoCrop={props.onConfirmVideoCrop}
                        isRelated={props.relatedNodeIds.has(node.id)}
                        isFocusRelated={props.activeNodeId === node.id}
                        isConnectionTarget={props.connectionTargetNodeId === node.id || props.batchConnectionPreview?.targetNodeId === node.id}
                        connectionApproach={props.connectionApproach?.nodeId === node.id ? props.connectionApproach.point : undefined}
                        forceInputVisible={Boolean(props.batchConnectionPreview)}
                        batchCount={props.batchChildCountById.get(node.id) || 0}
                        batchExpanded={Boolean(node.metadata?.imageBatchExpanded)}
                        batchPreviewNodes={batchPreviews.get(node.id)}
                        batchClosing={Boolean(node.metadata?.batchRootId && props.collapsingBatchIds.has(node.metadata.batchRootId))}
                        batchOpening={props.openingBatchIds.has(node.metadata?.batchRootId || node.id)}
                        batchRecovering={props.collapsingBatchIds.has(node.id)}
                        batchPrimary={Boolean(node.metadata?.batchRootId && props.nodeById.get(node.metadata.batchRootId)?.metadata?.primaryImageId === node.id)}
                        batchMotion={props.batchMotionById.get(node.id)}
                        showImageInfo={props.showImageInfo}
                        reduceMediaEffects={props.reduceMediaEffects || props.mediaEffectsDisabledNodeId === node.id}
                        resourceLabel={props.resourceReferenceByNodeId.get(node.id)}
                        mentionReferences={props.mentionReferencesByNodeId.get(node.id) || EMPTY_RESOURCE_REFERENCES}
                        renderNodeContent={props.renderCanvasNodeContent}
                        drawingProjectId={props.projectId}
                        onMouseDown={props.onNodeMouseDown}
                        onHoverStart={props.onNodeHoverStart}
                        onHoverEnd={props.onNodeHoverEnd}
                        onConnectStart={props.onConnectStart}
                        onResize={props.onNodeResize}
                        onTitleChange={props.onNodeTitleChange}
                        onContentChange={props.onNodeContentChange}
                        onToggleBatch={props.onToggleBatch}
                        onSetBatchPrimary={props.onSetBatchPrimary}
                        onRetry={retryNode}
                        onReloadResource={props.onReloadResource}
                        onOpenTaskDetails={props.onOpenTaskDetails}
                        onCancelTask={props.onCancelTask}
                        onOpenVersions={props.onOpenVersions}
                        onViewImage={props.onViewImage}
                        onReplaceMedia={props.onReplaceMedia}
                        onOpenTextEditor={props.onOpenTextEditor}
                        onOpenDrawing={props.onOpenDrawing}
                        onContextMenu={props.onNodeContextMenu}
                    />
                ),
            )}

            {props.selectedNodeBounds && !props.selectionBox ? (
                <div
                    ref={props.selectionBoundsElementRef}
                    data-canvas-selection-bounds
                    className="pointer-events-none absolute z-[var(--z-panel-floating)] rounded-xl"
                    style={{
                        left: props.selectedNodeBounds.left - 12 / viewportScale,
                        top: props.selectedNodeBounds.top - 12 / viewportScale,
                        width: props.selectedNodeBounds.width + 24 / viewportScale,
                        height: props.selectedNodeBounds.height + 24 / viewportScale,
                    }}
                >
                    {props.batchSourceNodeIds.length > 0 ? (
                        <BatchConnectionHandle
                            scale={viewportScale}
                            count={props.batchSourceNodeIds.length}
                            active={Boolean(props.batchConnectionPreview)}
                            onPointerDown={(event) => props.onStartBatchConnection(event, props.batchSourceNodeIds)}
                        />
                    ) : null}
                </div>
            ) : null}
        </>
    );
});

function BatchConnectionHandle({ scale, count, active, onPointerDown }: { scale: number; count: number; active: boolean; onPointerDown: (event: ReactPointerEvent) => void }) {
    const inverseScale = 1 / Math.max(scale, 0.05);
    const buttonStyle: CSSProperties = {
        right: -18 * inverseScale,
        top: "50%",
        width: 30 * inverseScale,
        height: 30 * inverseScale,
        background: active ? "var(--workspace-accent)" : "var(--workspace-surface-strong)",
        borderColor: active ? "var(--workspace-accent)" : "var(--workspace-border)",
        color: active ? "var(--workspace-accent-foreground)" : "var(--foreground)",
    };
    return (
        <button
            type="button"
            data-canvas-no-zoom
            className="pointer-events-auto absolute grid -translate-y-1/2 translate-x-1/2 place-items-center rounded-full border shadow-md transition hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={buttonStyle}
            title={`批量连接 ${count} 个节点`}
            aria-label={`批量连接 ${count} 个节点`}
            onPointerDown={onPointerDown}
        >
            <Link2 style={{ width: 14 * inverseScale, height: 14 * inverseScale }} strokeWidth={2} />
            <span className="sr-only">连接 {count} 个节点</span>
        </button>
    );
}
