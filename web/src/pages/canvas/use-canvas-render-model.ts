import { useEffect, useMemo, useRef } from "react";

import { buildNodeGenerationInputs, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { isFrameNode } from "@/lib/canvas/canvas-frame";
import { CANVAS_LOD_ENTER_SCREEN_PX, canvasLodTypicalNodeExtent, resolveCanvasLodActive } from "@/lib/canvas/canvas-lod";
import { prewarmCanvasLodThumbnails } from "@/lib/canvas/canvas-lod-thumbnails";
import { sameNodeSemanticData } from "@/lib/canvas/canvas-project-domain";
import { canvasNodeRenderPadding, CANVAS_MAX_RENDERED_CONNECTIONS, shouldReduceCanvasMediaEffects } from "@/lib/canvas/canvas-performance-mode";
import { CANVAS_GESTURE_RETAIN_LIMIT, type CanvasVirtualizationViewport } from "@/lib/canvas/canvas-viewport-render-sync";
import { buildCanvasNodeMentionReferenceMap, buildCanvasResourceReferences, reuseCanvasResourceReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { buildSkillMentionReferences } from "@/lib/canvas/canvas-skill-mentions";
import { buildCanvasSpatialIndex, canvasNodeBounds, type CanvasSpatialIndexEntry } from "@/lib/canvas/canvas-spatial-index";
import type { Skill } from "@/services/api/skills";
import type { Asset, ImageAsset } from "@/stores/use-asset-store";
import type { DirectorScene } from "@/types/director";
import { CanvasNodeType, type CanvasConnection, type CanvasDisplayConnection, type CanvasMediaPerformanceMode, type CanvasNodeData, type ContextMenuState, type ViewportTransform } from "@/types/canvas";

type DragPreview = { x: number; y: number; nodeIds: Set<string> } | null;
type IndexedConnection = { connection: CanvasConnection; fromId: string; toId: string };

type UseCanvasRenderModelOptions = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    assets: Asset[];
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    mediaPerformanceMode: CanvasMediaPerformanceMode;
    selectedNodeIds: Set<string>;
    hoveredNodeId: string | null;
    dragPreview: DragPreview;
    collapsingBatchIds: Set<string>;
    addedSkills: Skill[];
    directorScenes?: DirectorScene[];
    infoNodeId: string | null;
    maskEditNodeId: string | null;
    annotationNodeId: string | null;
    splitNodeId: string | null;
    upscaleNodeId: string | null;
    angleNodeId: string | null;
    lightingNodeId: string | null;
    emotionNodeId: string | null;
    previewNodeId: string | null;
    contextMenu: ContextMenuState | null;
    versionCompareRootId: string | null;
    directorNodeId: string | null;
    scriptEditorNodeId: string | null;
    dialogNodeId: string | null;
    /** Nodes that must stay interactive DOM cards while the overview canvas is active. */
    lodPinnedNodeIds?: ReadonlySet<string>;
    /** True while a camera gesture is still in flight. */
    viewportInteracting?: boolean;
};

const EMPTY_LOD_NODES: CanvasNodeData[] = [];
const EMPTY_PINNED_NODE_IDS: ReadonlySet<string> = new Set();
const EMPTY_CONFIG_INPUTS_BY_ID = new Map<string, NodeGenerationInput[]>();

function sameConfigInputs(left: NodeGenerationInput[] | undefined, right: NodeGenerationInput[] | undefined) {
    if (left === right) return true;
    if (!left || !right || left.length !== right.length) return false;
    return left.every((item, index) => {
        const other = right[index];
        return item.nodeId === other.nodeId
            && item.type === other.type
            && item.sourceKind === other.sourceKind
            && item.title === other.title
            && item.previewUrl === other.previewUrl
            && item.alwaysIncludeText === other.alwaysIncludeText
            && item.text === other.text
            && item.image?.id === other.image?.id
            && item.image?.storageKey === other.image?.storageKey
            && item.image?.dataUrl === other.image?.dataUrl
            && item.video?.id === other.video?.id
            && item.video?.storageKey === other.video?.storageKey
            && item.video?.url === other.video?.url
            && item.audio?.id === other.audio?.id
            && item.audio?.storageKey === other.audio?.storageKey
            && item.audio?.url === other.audio?.url
            && item.character?.assetId === other.character?.assetId
            && item.character?.requestedVersionId === other.character?.requestedVersionId;
    });
}

export function useCanvasRenderModel({
    nodes,
    connections,
    assets,
    viewport,
    viewportSize,
    mediaPerformanceMode,
    selectedNodeIds,
    hoveredNodeId,
    dragPreview,
    collapsingBatchIds,
    addedSkills,
    directorScenes,
    infoNodeId,
    maskEditNodeId,
    annotationNodeId,
    splitNodeId,
    upscaleNodeId,
    angleNodeId,
    lightingNodeId,
    emotionNodeId,
    previewNodeId,
    contextMenu,
    versionCompareRootId,
    directorNodeId,
    scriptEditorNodeId,
    dialogNodeId,
    lodPinnedNodeIds = EMPTY_PINNED_NODE_IDS,
    viewportInteracting = false,
}: UseCanvasRenderModelOptions) {
    const reduceMediaEffects = useMemo(() => shouldReduceCanvasMediaEffects(mediaPerformanceMode, nodes), [mediaPerformanceMode, nodes]);
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const nodeIndexById = useMemo(() => new Map(nodes.map((node, index) => [node.id, index])), [nodes]);
    // These maps are consumed by both virtualization and node chrome. Building
    // them together keeps a metadata update from walking a 50k-node array six
    // separate times before React can paint the next frame.
    const nodeDerivedData = useMemo(() => {
        const collapsedBatchChildIds = new Set<string>();
        const renderHiddenNodeIds = new Set<string>();
        const frameChildrenById = new Map<string, CanvasNodeData[]>();
        const canvasImageNodes: CanvasNodeData[] = [];
        const batchRoots: CanvasNodeData[] = [];
        const batchMotionById = new Map<string, { x: number; y: number; index: number }>();
        const batchChildIndexByRootId = new Map<string, Map<string, number>>();

        for (const node of nodes) {
            const rootId = node.metadata?.batchRootId;
            const root = rootId ? nodeById.get(rootId) : undefined;
            if (root && !root.metadata?.imageBatchExpanded) {
                collapsedBatchChildIds.add(node.id);
                if (!collapsingBatchIds.has(root.id)) renderHiddenNodeIds.add(node.id);
            }

            if (rootId && collapsingBatchIds.has(rootId)) renderHiddenNodeIds.delete(node.id);
            const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
            if (parent && isFrameNode(parent)) {
                const children = frameChildrenById.get(parent.id);
                if (children) children.push(node);
                else frameChildrenById.set(parent.id, [node]);
                if (parent.metadata?.frame?.collapsed) renderHiddenNodeIds.add(node.id);
            }

            if (node.metadata?.isBatchRoot) batchRoots.push(node);
            // 资产托盘与节点渲染共用同一份可视内容：生成结果在资源尚未
            // 完成持久化时可能只有 previewContent，不能因此从“当前画布”中消失。
            if (node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.previewContent) && !collapsedBatchChildIds.has(node.id) && !(parent && isFrameNode(parent) && parent.metadata?.frame?.collapsed)) {
                canvasImageNodes.push(node);
            }
        }

        for (const root of batchRoots) {
            const childIndex = new Map((root.metadata?.batchChildIds || []).map((childId, index) => [childId, index]));
            batchChildIndexByRootId.set(root.id, childIndex);
        }
        for (const node of nodes) {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) continue;
            const root = nodeById.get(rootId);
            const index = batchChildIndexByRootId.get(rootId)?.get(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            batchMotionById.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        }

        const batchChildCountById = new Map<string, number>();
        for (const root of batchRoots) {
            const childIndex = batchChildIndexByRootId.get(root.id);
            const liveChildCount = [...(childIndex?.keys() || [])].filter((childId) => nodeById.get(childId)?.metadata?.batchRootId === root.id).length;
            batchChildCountById.set(root.id, liveChildCount);
        }

        return { batchChildCountById, batchMotionById, canvasImageNodes, collapsedBatchChildIds, frameChildrenById, renderHiddenNodeIds };
    }, [collapsingBatchIds, nodeById, nodes]);
    const { batchChildCountById, batchMotionById, canvasImageNodes, collapsedBatchChildIds, frameChildrenById, renderHiddenNodeIds } = nodeDerivedData;
    const renderBounds = useMemo(() => {
        // A gesture refreshes this window only when the camera nears its edge
        // (see shouldRefreshCanvasVirtualization). The controller widens the
        // margin a step per refresh and passes it with the camera.
        const gesturePadding = viewportInteracting ? (viewport as CanvasVirtualizationViewport).renderPaddingPx ?? 0 : 0;
        const enterPadding = Math.max(canvasNodeRenderPadding(reduceMediaEffects, false), gesturePadding) / viewport.k;
        const retainPadding = Math.max(canvasNodeRenderPadding(reduceMediaEffects, true), gesturePadding) / viewport.k;
        const viewLeft = -viewport.x / viewport.k;
        const viewTop = -viewport.y / viewport.k;
        const viewWidth = viewportSize.width / viewport.k;
        const viewHeight = viewportSize.height / viewport.k;
        return {
            enter: { left: viewLeft - enterPadding, top: viewTop - enterPadding, right: viewLeft + viewWidth + enterPadding, bottom: viewTop + viewHeight + enterPadding },
            retain: { left: viewLeft - retainPadding, top: viewTop - retainPadding, right: viewLeft + viewWidth + retainPadding, bottom: viewTop + viewHeight + retainPadding },
        };
    }, [reduceMediaEffects, viewport, viewportInteracting, viewportSize.height, viewportSize.width]);
    const geometryNodesRef = useRef(nodes);
    const geometryNodes = useMemo(() => {
        const previous = geometryNodesRef.current;
        const geometryUnchanged =
            previous.length === nodes.length &&
            nodes.every((node, index) => {
                const old = previous[index];
                return old === node || (old.id === node.id && old.type === node.type && old.parentId === node.parentId
                    && old.position.x === node.position.x && old.position.y === node.position.y && old.width === node.width && old.height === node.height
                    && old.metadata?.batchRootId === node.metadata?.batchRootId && old.metadata?.imageBatchExpanded === node.metadata?.imageBatchExpanded
                    && old.metadata?.frame?.collapsed === node.metadata?.frame?.collapsed);
            });
        if (!geometryUnchanged) geometryNodesRef.current = nodes;
        return geometryNodesRef.current;
    }, [nodes]);
    const nodeSpatialIndex = useMemo(() => buildCanvasSpatialIndex(geometryNodes.map((node) => ({ id: node.id, bounds: canvasNodeBounds(node), value: node.id }))), [geometryNodes]);
    const renderedNodeIdsRef = useRef<Set<string>>(new Set());
    const retainedNodeIdsRef = useRef<Set<string>>(new Set());
    const domNodeIdsRef = useRef<Set<string>>(new Set());
    const visibleNodesRef = useRef<CanvasNodeData[]>([]);
    const lodNodesRef = useRef<CanvasNodeData[]>(EMPTY_LOD_NODES);
    const lodActiveRef = useRef(false);
    const lodScaleRef = useRef<number | null>(null);
    const typicalExtentRef = useRef(0);
    const { visibleNodes, lodNodes, lodActive, lodEnterScale } = useMemo(() => {
        const frames: CanvasNodeData[] = [];
        const regular: CanvasNodeData[] = [];
        const renderedNodeIds = renderedNodeIdsRef.current;
        // Spatial bounds may cull offscreen nodes; a count budget must not
        // discard visible media or displace it when selection is retained.
        const forcedNodeIds = new Set([...selectedNodeIds, ...lodPinnedNodeIds, ...(dragPreview?.nodeIds || [])]);
        const candidates = nodeSpatialIndex
            .query(renderBounds.retain)
            .map((nodeId) => nodeById.get(nodeId))
            .filter((node): node is CanvasNodeData => Boolean(node));
        const candidateIds = new Set(candidates.map((node) => node.id));
        for (const nodeId of forcedNodeIds) {
            if (candidateIds.has(nodeId)) continue;
            const node = nodeById.get(nodeId);
            if (node) candidates.push(node);
            candidateIds.add(nodeId);
        }
        // During a pan or zoom, cards already mounted stay mounted: unmounting
        // them mid-gesture is most of the DOM churn behind slow frames. The
        // gesture-end commit culls them again. Very large windows skip this.
        const previousDomIds = domNodeIdsRef.current;
        const gestureRetainedIds = viewportInteracting && previousDomIds.size <= CANVAS_GESTURE_RETAIN_LIMIT ? previousDomIds : EMPTY_PINNED_NODE_IDS;
        for (const nodeId of gestureRetainedIds) {
            if (candidateIds.has(nodeId)) continue;
            const node = nodeById.get(nodeId);
            if (node) candidates.push(node);
        }
        const prioritized = candidates.filter((node) => forcedNodeIds.has(node.id));
        const remaining = candidates.filter((node) => !forcedNodeIds.has(node.id));
        // Gesture-retained nodes were appended after the spatial query. Keep
        // document order so React never moves a mounted card (a moved <video>
        // reloads) when a node passes between the query and the retained set.
        if (gestureRetainedIds.size) remaining.sort((left, right) => (nodeIndexById.get(left.id) ?? 0) - (nodeIndexById.get(right.id) ?? 0));
        [...prioritized, ...remaining].forEach((node) => {
            if (renderHiddenNodeIds.has(node.id)) return;
            const retained = forcedNodeIds.has(node.id) || renderedNodeIds.has(node.id) || gestureRetainedIds.has(node.id);
            const insideEnterBounds = node.position.x + node.width > renderBounds.enter.left && node.position.x < renderBounds.enter.right && node.position.y + node.height > renderBounds.enter.top && node.position.y < renderBounds.enter.bottom;
            if (!retained && !insideEnterBounds) return;
            (isFrameNode(node) ? frames : regular).push(node);
        });

        // Overview LOD: every regular node is still displayed by the overview
        // canvas; only interactive ones are mounted as full DOM cards.
        // The typical extent follows whichever nodes are in view, so a pan can
        // cross the threshold at a fixed zoom. Only a scale change may switch
        // modes mid-gesture; a pan resolves it once, at the gesture-end commit.
        const measuredExtent = canvasLodTypicalNodeExtent(regular);
        if (!viewportInteracting || typicalExtentRef.current <= 0) typicalExtentRef.current = measuredExtent;
        const typicalExtent = typicalExtentRef.current || measuredExtent;
        const lodEnterScale = typicalExtent > 0 ? CANVAS_LOD_ENTER_SCREEN_PX / typicalExtent : 0;
        const panOnly = viewportInteracting && lodScaleRef.current === viewport.k;
        const nextLodActive = panOnly ? lodActiveRef.current : resolveCanvasLodActive({
            previous: lodActiveRef.current,
            typicalExtent,
            scale: viewport.k,
            deferExit: viewportInteracting,
        });
        lodActiveRef.current = nextLodActive;
        lodScaleRef.current = viewport.k;
        let domRegular = regular;
        let nextLod = EMPTY_LOD_NODES;
        if (nextLodActive) {
            // The overview canvas culls each frame against the live camera, so
            // it receives every displayable node instead of a stale window.
            nextLod = nodes.filter((node) => !isFrameNode(node) && !renderHiddenNodeIds.has(node.id));
            const dragging = Boolean(dragPreview?.nodeIds.size);
            // Cards already mounted when the gesture began stay in the DOM tree
            // and are hidden via CSS display:none while the overview canvas is
            // active, avoiding both double-rasterization and the 33-card
            // unmount/remount spike on entering and leaving LOD.
            const retainGestureDom = gestureRetainedIds.size > 0;
            domRegular = dragging
                ? regular.filter((node) => previousDomIds.has(node.id))
                : regular.filter((node) => (retainGestureDom && previousDomIds.has(node.id)) || lodPinnedNodeIds.has(node.id));
        }
        retainedNodeIdsRef.current = new Set([...frames, ...(nextLodActive ? domRegular : regular)].map((node) => node.id));

        const next = [...frames, ...domRegular];
        const previous = visibleNodesRef.current;
        const nextVisible = previous.length === next.length && next.every((node, index) => node === previous[index]) ? previous : next;
        visibleNodesRef.current = nextVisible;
        const previousLod = lodNodesRef.current;
        const stableLod = previousLod.length === nextLod.length && nextLod.every((node, index) => node === previousLod[index]) ? previousLod : nextLod;
        lodNodesRef.current = stableLod;
        return { visibleNodes: nextVisible, lodNodes: stableLod, lodActive: nextLodActive, lodEnterScale };
    }, [dragPreview, lodPinnedNodeIds, nodeById, nodeIndexById, nodeSpatialIndex, nodes, renderBounds, renderHiddenNodeIds, selectedNodeIds, viewport.k, viewportInteracting]);
    useEffect(() => {
        domNodeIdsRef.current = new Set(visibleNodes.map((node) => node.id));
        // Enter/retain hysteresis tracks what is displayed in the camera window.
        renderedNodeIdsRef.current = retainedNodeIdsRef.current;
        if (!viewportInteracting && visibleNodes.length > 0) prewarmCanvasLodThumbnails(visibleNodes);
    }, [lodNodes, viewportInteracting, visibleNodes]);

    const imageAssets = useMemo(() => assets.filter((asset): asset is ImageAsset => asset.kind === "image" && asset.status !== "archived"), [assets]);
    const semanticNodesRef = useRef(nodes);
    const semanticNodes = useMemo(() => {
        const previous = semanticNodesRef.current;
        const positionOnlyChange = previous.length === nodes.length && nodes.every((node, index) => sameNodeSemanticData(node, previous[index]));
        if (!positionOnlyChange) semanticNodesRef.current = nodes;
        return semanticNodesRef.current;
    }, [nodes]);
    const versionCompareNodes = useMemo(() => {
        if (!versionCompareRootId) return [];
        return nodes.filter((node) => (node.metadata?.versionOfNodeId || node.id) === versionCompareRootId).sort((a, b) => (a.metadata?.versionLabel || "").localeCompare(b.metadata?.versionLabel || ""));
    }, [nodes, versionCompareRootId]);

    const selectedNodeIdForToolbar = selectedNodeIds.size === 1 ? [...selectedNodeIds][0] : null;
    const toolbarCandidate = selectedNodeIdForToolbar ? nodeById.get(selectedNodeIdForToolbar) || null : null;
    const toolbarNode = isFrameNode(toolbarCandidate) ? null : toolbarCandidate;
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const annotationNode = annotationNodeId ? nodeById.get(annotationNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const lightingNode = lightingNodeId ? nodeById.get(lightingNodeId) || null : null;
    const emotionNode = emotionNodeId ? nodeById.get(emotionNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const contextMenuNode = contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) || null : null;
    // Hover only drives transient affordances (toolbar/handles). Selection is
    // the explicit focus action that raises a node and highlights its graph.
    const activeNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;

    const selectedNodeBounds = useMemo(() => {
        if (selectedNodeIds.size < 2) return null;
        const selectedNodes = [...selectedNodeIds].map((nodeId) => nodeById.get(nodeId)).filter((node): node is CanvasNodeData => Boolean(node && !renderHiddenNodeIds.has(node.id)));
        if (selectedNodes.length < 2) return null;
        const left = Math.min(...selectedNodes.map((node) => node.position.x));
        const top = Math.min(...selectedNodes.map((node) => node.position.y));
        const right = Math.max(...selectedNodes.map((node) => node.position.x + node.width));
        const bottom = Math.max(...selectedNodes.map((node) => node.position.y + node.height));
        return { left, top, width: right - left, height: bottom - top, count: selectedNodes.length };
    }, [nodeById, renderHiddenNodeIds, selectedNodeIds]);
    const selectedVideoNodes = useMemo(
        () =>
            [...selectedNodeIds]
                .map((nodeId) => nodeById.get(nodeId))
                .filter((node): node is CanvasNodeData => Boolean(node && node.type === CanvasNodeType.Video && node.metadata?.content && !renderHiddenNodeIds.has(node.id)))
                .sort((a, b) => {
                    const shotA = a.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER;
                    const shotB = b.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER;
                    return shotA - shotB || a.position.y - b.position.y || a.position.x - b.position.x;
                }),
        [nodeById, renderHiddenNodeIds, selectedNodeIds],
    );
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();
        if (!activeNodeId) return { nodeIds, connectionIds };
        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });
        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);
    const connectionSpatialIndex = useMemo(() => {
        // Store identities, not media/metadata snapshots. A title or task-status
        // update must refresh the endpoints below without rebuilding the grid.
        const geometryById = new Map(geometryNodes.map(node => [node.id, node]));
        const entries: CanvasSpatialIndexEntry<IndexedConnection>[] = [];
        const connectionIdsByNodeId = new Map<string, Set<string>>();
        const hiddenByBatch = (node: CanvasNodeData) => {
            const root = node.metadata?.batchRootId ? geometryById.get(node.metadata.batchRootId) : undefined;
            return Boolean(root && !root.metadata?.imageBatchExpanded);
        };
        connections.forEach((connection) => {
            const fromNode = geometryById.get(connection.fromNodeId);
            const toNode = geometryById.get(connection.toNodeId);
            if (!fromNode || !toNode) return;
            if (hiddenByBatch(fromNode) || hiddenByBatch(toNode)) return;
            const fromParent = fromNode.parentId ? geometryById.get(fromNode.parentId) : null;
            const toParent = toNode.parentId ? geometryById.get(toNode.parentId) : null;
            const displayFrom = fromParent && isFrameNode(fromParent) && fromParent.metadata?.frame?.collapsed ? fromParent : fromNode;
            const displayTo = toParent && isFrameNode(toParent) && toParent.metadata?.frame?.collapsed ? toParent : toNode;
            if (displayFrom.id === displayTo.id) return;
            const left = Math.min(displayFrom.position.x, displayTo.position.x);
            const top = Math.min(displayFrom.position.y, displayTo.position.y);
            const right = Math.max(displayFrom.position.x + displayFrom.width, displayTo.position.x + displayTo.width);
            const bottom = Math.max(displayFrom.position.y + displayFrom.height, displayTo.position.y + displayTo.height);
            const value = { connection, fromId: displayFrom.id, toId: displayTo.id };
            entries.push({ id: connection.id, bounds: { left, top, right, bottom }, value });
            for (const nodeId of new Set([connection.fromNodeId, connection.toNodeId, displayFrom.id, displayTo.id])) {
                const ids = connectionIdsByNodeId.get(nodeId) || new Set<string>();
                ids.add(connection.id);
                connectionIdsByNodeId.set(nodeId, ids);
            }
        });
        return { index: buildCanvasSpatialIndex(entries), connectionIdsByNodeId, entriesById: new Map(entries.map((entry) => [entry.id, entry.value])) };
    }, [connections, geometryNodes]);
    const displayConnectionsRef = useRef<CanvasDisplayConnection[]>([]);
    const displayConnections = useMemo(() => {
        const candidateById = new Map<string, IndexedConnection>();
        connectionSpatialIndex.index.query(renderBounds.retain, CANVAS_MAX_RENDERED_CONNECTIONS).forEach((display) => candidateById.set(display.connection.id, display));
        dragPreview?.nodeIds.forEach((nodeId) => {
            connectionSpatialIndex.connectionIdsByNodeId.get(nodeId)?.forEach((connectionId) => {
                const display = connectionSpatialIndex.entriesById.get(connectionId);
                if (display) candidateById.set(connectionId, display);
            });
        });
        const next = [...candidateById.values()].flatMap(({ connection, fromId, toId }) => {
            const sourceFrom = nodeById.get(fromId);
            const sourceTo = nodeById.get(toId);
            if (!sourceFrom || !sourceTo) return [];
            const from = dragPreview?.nodeIds.has(sourceFrom.id) ? { ...sourceFrom, position: { x: sourceFrom.position.x + dragPreview.x, y: sourceFrom.position.y + dragPreview.y } } : sourceFrom;
            const to = dragPreview?.nodeIds.has(sourceTo.id) ? { ...sourceTo, position: { x: sourceTo.position.x + dragPreview.x, y: sourceTo.position.y + dragPreview.y } } : sourceTo;
            const connectionLeft = Math.min(from.position.x, to.position.x);
            const connectionTop = Math.min(from.position.y, to.position.y);
            const connectionRight = Math.max(from.position.x + from.width, to.position.x + to.width);
            const connectionBottom = Math.max(from.position.y + from.height, to.position.y + to.height);
            if (connectionRight <= renderBounds.retain.left || connectionLeft >= renderBounds.retain.right || connectionBottom <= renderBounds.retain.top || connectionTop >= renderBounds.retain.bottom) return [];
            return [{ connection, from, to }];
        });
        const previous = displayConnectionsRef.current;
        if (
            previous.length === next.length &&
            next.every((item, index) => {
                const prev = previous[index];
                return prev.connection === item.connection && prev.from === item.from && prev.to === item.to;
            })
        ) {
            return previous;
        }
        displayConnectionsRef.current = next;
        return next;
    }, [connectionSpatialIndex, dragPreview, nodeById, renderBounds]);

    const configInputsByIdRef = useRef<Map<string, NodeGenerationInput[]>>(EMPTY_CONFIG_INPUTS_BY_ID);
    const configInputsById = useMemo(() => {
        const configNodeIds = new Set<string>();
        visibleNodes.forEach((node) => {
            if (node.type === CanvasNodeType.Config) configNodeIds.add(node.id);
        });
        selectedNodeIds.forEach((nodeId) => {
            if (nodeById.get(nodeId)?.type === CanvasNodeType.Config) configNodeIds.add(nodeId);
        });
        if (dialogNodeId && nodeById.get(dialogNodeId)?.type === CanvasNodeType.Config) configNodeIds.add(dialogNodeId);
        if (configNodeIds.size === 0) {
            configInputsByIdRef.current = EMPTY_CONFIG_INPUTS_BY_ID;
            return EMPTY_CONFIG_INPUTS_BY_ID;
        }
        const map = new Map<string, NodeGenerationInput[]>();
        configNodeIds.forEach((nodeId) => map.set(nodeId, buildNodeGenerationInputs(nodeId, semanticNodes, connections)));
        const previous = configInputsByIdRef.current;
        if (previous.size === map.size && [...map.entries()].every(([id, inputs]) => sameConfigInputs(previous.get(id), inputs))) {
            return previous;
        }
        configInputsByIdRef.current = map;
        return map;
    }, [connections, dialogNodeId, nodeById, selectedNodeIds, semanticNodes, visibleNodes]);
    const activeDirectorNode = useMemo(() => semanticNodes.find((node) => node.id === directorNodeId) || null, [directorNodeId, semanticNodes]);
    const activeStylePresetId = useMemo(() => semanticNodes.find((node) => node.metadata?.workflowKind === "styleboard")?.metadata?.stylePresetId, [semanticNodes]);
    const activeScriptNode = useMemo(() => semanticNodes.find((node) => node.id === scriptEditorNodeId && node.type === CanvasNodeType.Script) || null, [scriptEditorNodeId, semanticNodes]);
    const activeDirectorScene = useMemo(() => directorScenes?.find((scene) => scene.id === activeDirectorNode?.metadata?.directorSceneId) || null, [activeDirectorNode?.metadata?.directorSceneId, directorScenes]);
    const resourceReferenceTargetNodes = useMemo(() => {
        const targetNodes = [...visibleNodes];
        const activeId = dialogNodeId || activeNodeId;
        if (activeId) {
            const activeNode = nodeById.get(activeId);
            if (activeNode) targetNodes.push(activeNode);
        }
        return targetNodes;
    }, [activeNodeId, dialogNodeId, nodeById, visibleNodes]);
    const canvasResourceReferencesRef = useRef<CanvasResourceReference[]>([]);
    const canvasResourceReferences = useMemo(() => {
        const next = buildCanvasResourceReferences(semanticNodes, connections, dialogNodeId || activeNodeId, resourceReferenceTargetNodes);
        return canvasResourceReferencesRef.current = reuseCanvasResourceReferences(canvasResourceReferencesRef.current, next);
    }, [activeNodeId, connections, dialogNodeId, resourceReferenceTargetNodes, semanticNodes]);
    const resourceReferenceByNodeId = useMemo(() => new Map(canvasResourceReferences.map((reference) => [reference.nodeId, reference])), [canvasResourceReferences]);
    const skillMentionReferences = useMemo(() => buildSkillMentionReferences(addedSkills), [addedSkills]);
    const mentionReferencesRef = useRef(new Map<string, CanvasResourceReference[]>());
    const mentionReferencesByNodeId = useMemo(() => {
        const map = buildCanvasNodeMentionReferenceMap(semanticNodes, connections, visibleNodes);
        map.forEach((references, nodeId) => map.set(nodeId, reuseCanvasResourceReferences(mentionReferencesRef.current.get(nodeId), skillMentionReferences.length ? [...references, ...skillMentionReferences] : references)));
        return mentionReferencesRef.current = map;
    }, [connections, semanticNodes, skillMentionReferences, visibleNodes]);

    return {
        activeDirectorNode,
        activeDirectorScene,
        activeNodeId,
        activeScriptNode,
        activeStylePresetId,
        angleNode,
        lightingNode,
        emotionNode,
        annotationNode,
        batchChildCountById,
        batchMotionById,
        canvasImageNodes,
        configInputsById,
        contextMenuNode,
        displayConnections,
        frameChildrenById,
        imageAssets,
        infoNode,
        lodActive,
        lodEnterScale,
        lodNodes,
        maskEditNode,
        mentionReferencesByNodeId,
        nodeById,
        previewNode,
        reduceMediaEffects,
        relatedHighlight,
        resourceReferenceByNodeId,
        selectedNodeBounds,
        selectedVideoNodes,
        semanticNodes,
        skillMentionReferences,
        splitNode,
        toolbarNode,
        upscaleNode,
        versionCompareNodes,
        visibleNodes,
    };
}
