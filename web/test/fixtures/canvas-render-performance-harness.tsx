import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { CanvasProjectWorldLayers } from "@/pages/canvas/canvas-project-world-layers";
import { useCanvasRenderModel } from "@/pages/canvas/use-canvas-render-model";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";
import "antd/dist/reset.css";
import "@/styles/globals.css";
import "@/styles/beeftv-local-overrides.css";

const noop = () => {};
const selected = new Set<string>();
const emptyMap = new Map();
const emptyArray: never[] = [];
const count = Math.max(50, Math.min(1000, Number(new URLSearchParams(location.search).get("nodes")) || 500));
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#284b63"/><circle cx="160" cy="90" r="50" fill="#79b8b0"/></svg>');
const fixtureNodes = (start: number, length: number): CanvasNodeData[] => Array.from({ length }, (_, offset) => {
    const index = start + offset;
    const type = index % 20 < 14 ? CanvasNodeType.Image : index % 20 < 19 ? CanvasNodeType.Video : CanvasNodeType.Text;
    return { id: `n${index}`, type, title: `镜头 ${index + 1}`, position: { x: index % 25 * 360, y: Math.floor(index / 25) * 240 }, width: 320, height: 180,
        metadata: { content: type === CanvasNodeType.Text ? `分镜描述 ${index}` : type === CanvasNodeType.Image ? image : "", previewContent: type === CanvasNodeType.Video ? image : undefined, naturalWidth: 320, naturalHeight: 180, prompt: "固定场景的分镜描述。".repeat(120), manualSize: true } };
});

const perf = (window as any).__canvasPerf = { ready: false, nodeRenders: {} as Record<string, number>, state: {}, run: async (_kind: string, _iterations: number) => ({}) };

function Harness() {
    const [nodes, setNodes] = useState(() => fixtureNodes(0, count));
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 90, y: 80, k: 0.25 });
    const containerRef = useRef<HTMLDivElement>(null);
    const connections = useRef(Array.from({ length: count - 1 }, (_, i) => ({ id: `e${i}`, fromNodeId: `n${i}`, toNodeId: `n${i + 1}` }))).current;
    const start = performance.now();
    const model = useCanvasRenderModel({ nodes, connections, assets: emptyArray, viewport, viewportSize: { width: 1440, height: 820 }, mediaPerformanceMode: "auto", selectedNodeIds: selected, hoveredNodeId: null, dragPreview: null, collapsingBatchIds: selected, addedSkills: emptyArray,
        infoNodeId: null, maskEditNodeId: null, annotationNodeId: null, splitNodeId: null, upscaleNodeId: null, angleNodeId: null, lightingNodeId: null, emotionNodeId: null, previewNodeId: null, contextMenu: null, versionCompareRootId: null, directorNodeId: null, scriptEditorNodeId: null, dialogNodeId: null });
    const modelMs = performance.now() - start;
    const latest = useRef({ nodes, model, modelMs });
    useLayoutEffect(() => { latest.current = { nodes, model, modelMs }; perf.state = { nodes: nodes.length, visible: model.visibleNodes.length, connections: model.displayConnections.length }; perf.ready = true; });
    const rename = useCallback((id: string, title: string) => setNodes(current => current.map(node => node.id === id ? { ...node, title } : node)), []);
    (perf as any).replaceNodes = (next: CanvasNodeData[]) => flushSync(() => setNodes(next));
    (perf as any).inspect = () => ({ visible: latest.current.model.visibleNodes.map(node => node.id), connections: latest.current.model.displayConnections.map(({ connection, from, to }) => ({ id: connection.id, from: from.id, to: to.id, title: from.title, x: from.position.x, width: from.width })) });
    const props: ComponentProps<typeof CanvasProjectWorldLayers> = {
        containerRef, projectId: "performance-fixture", viewportScale: viewport.k,
        ...model, relatedConnectionIds: model.relatedHighlight.connectionIds, relatedNodeIds: model.relatedHighlight.nodeIds, visibleNodes: model.visibleNodes, nodeStackOrder: emptyArray, selectedConnectionId: null, scriptScrollTopById: {}, connectingParams: null, mouseWorld: { x: 0, y: 0 }, connectionTargetNodeId: null, connectionApproach: null, linkedFolderPreviewNodesById: emptyMap, dragPreview: null, selectedNodeIds: selected, frameDropTargetId: null, selectionBox: null, collapsingBatchIds: selected, openingBatchIds: selected, showImageInfo: false, batchSourceNodeIds: emptyArray, batchConnectionPreview: null, selectionBoundsElementRef: useRef<HTMLDivElement>(null),
        renderCanvasNodeContent: () => null, onConnectionSelect: noop, onConnectionContextMenu: noop, onNodeMouseDown: noop, onNodeHoverStart: noop, onNodeHoverEnd: noop, onConnectStart: noop, onNodeResize: noop, onToggleFrame: noop, onFolderStyleChange: noop, onFolderThemeChange: noop, onNodeTitleChange: rename, onNodeContextMenu: noop, onNodeContentChange: noop, onToggleBatch: noop, onSetBatchPrimary: noop, onRetry: noop, onReloadResource: noop, onOpenTaskDetails: noop, onOpenVersions: noop, onViewImage: noop, onReplaceMedia: noop, onOpenTextEditor: noop, onOpenDrawing: noop, onStartBatchConnection: noop,
    };
    // Stable handlers match the product; the render callback is deliberately
    // recreated, exercising CanvasNode's existing standard/custom distinction.
    perf.run = async (kind: string, iterations = 25) => {
        const durations: number[] = [], models: number[] = [];
        perf.nodeRenders = {};
        (perf as any).spatialBuilds = 0;
        for (let i = 0; i < iterations; i++) {
            const begin = performance.now();
            flushSync(() => {
                if (kind === "append") setNodes(current => [...current, ...fixtureNodes(current.length, 8)]);
                else if (kind === "move") setNodes(current => current.map(node => node.id === "n0" ? { ...node, position: { ...node.position, x: node.position.x + 1 } } : node));
                else if (kind === "pan") setViewport(current => ({ ...current, x: current.x + (i % 2 ? -8 : 8) }));
                else setNodes(current => current.map(node => node.id === "n0" ? { ...node, title: `更新 ${kind} ${i}` } : node));
            });
            durations.push(performance.now() - begin);
            models.push(latest.current.modelMs);
        }
        const stats = (values: number[]) => { values.sort((a, b) => a - b); return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.ceil(values.length * .95) - 1] }; };
        return { kind, iterations, ...perf.state, update: stats(durations), renderModel: stats(models), spatialBuilds: (perf as any).spatialBuilds, changedNodeRenders: perf.nodeRenders.n0 || 0, otherNodeRenders: Object.entries(perf.nodeRenders).filter(([id]) => id !== "n0").reduce((sum, [, n]) => sum + n, 0), scope: "production React synchronous update commits, real canvas components and synthetic local media; not paint/FPS, backend or native-host timing" };
    };
    return <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}>
        <header style={{ height: 48, padding: 12, color: "#d0d7de", background: "#18212a" }}>BeefTV 画布性能回放 · 测试数据 · {nodes.length} 节点</header>
        <main style={{ flex: 1, position: "relative" }}><InfiniteCanvas containerRef={containerRef} viewport={viewport} onViewportChange={setViewport}><CanvasProjectWorldLayers {...props} /></InfiniteCanvas></main>
    </div>;
}

useThemeStore.getState().setTheme(new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark");
createRoot(document.getElementById("root")!, { onUncaughtError(error) { (perf as any).error = String(error); } }).render(<Harness />);
