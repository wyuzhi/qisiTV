import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import {
    createLibTvAudioFixture,
    createLibTvEmptyTextFixture,
    createLibTvGeneratingFixture,
    createLibTvReadonlyDenseFixture,
    createLibTvStoryboardFixture,
    createLibTvTextFixture,
    createLibTvVideoConversionFixture,
    createLibTvVideoFixture,
    createLibTvVideoMergeFixture,
    createLibTvVideoSubtitleFixture,
} from "@/lib/canvas/canvas-libtv-fixture";
import { libtvOriginalEdgeEndpoints } from "@/lib/canvas/libtv-original-edges";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";

type UseCanvasLibTvVisualFixturesParams = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    projectLoaded: boolean;
    readOnly: boolean;
    searchParams: URLSearchParams;
    nodes: CanvasNodeData[];
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    saveCanvasProject: (options?: { requireRemote?: boolean }) => Promise<boolean>;
};

export function useCanvasLibTvVisualFixtures({
    pageUi,
    projectId,
    projectLoaded,
    readOnly,
    searchParams,
    nodes,
    nodesRef,
    connectionsRef,
    selectedNodeIdsRef,
    viewportRef,
    setNodes,
    setConnections,
    setViewport,
    saveCanvasProject,
}: UseCanvasLibTvVisualFixturesParams) {
    const fixtureAppliedRef = useRef<string | null>(null);

    const focusFixtureOnNarrowViewport = useCallback((fixtureNodes: CanvasNodeData[]) => {
        if (typeof window === "undefined" || window.innerWidth >= 768) return;
        const target = fixtureNodes.find((node) => node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Audio || node.type === CanvasNodeType.Text);
        if (!target) return;
        // Keep the fixture's world coordinates intact, but place its visual
        // bounds inside a narrow viewport so the first actionable control is
        // reachable without requiring a hidden desktop-sized pan.
        const width = Math.max(320, window.innerWidth);
        const height = Math.max(420, window.innerHeight - 56);
        const scale = Math.min(1, Math.max(0.35, Math.min((width - 24) / Math.max(1, target.width), (height - 120) / Math.max(1, target.height))));
        const next = {
            x: (width - target.width * scale) / 2 - target.position.x * scale,
            y: (height - target.height * scale) / 2 - target.position.y * scale,
            k: scale,
        };
        viewportRef.current = next;
        setViewport(next);
    }, [setViewport, viewportRef]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-storyboard") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-storyboard")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvStoryboardFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        // A saved LibTV storyboard opens in browse mode. Do not carry a stale
        // dialog/selection from the canvas that was used to load the fixture;
        // otherwise the first screenshot is polluted by a text composer.
        pageUi.getState().setSelectedNodeIds(new Set());
        selectedNodeIdsRef.current = new Set();
        pageUi.getState().setDialogNodeId(null);
        // Read-only reference mode is intentionally side-effect free: saving here
        // would surface a local-save toast that the public LibTV viewer does not show.
    }, [pageUi, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes, selectedNodeIdsRef]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-readonly-dense") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-readonly-dense")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvReadonlyDenseFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        const denseChildren = fixtureNodes;
        const nearestChild = (screenX: number, screenY: number) => denseChildren.reduce<{ node: CanvasNodeData | null; distance: number }>((best, node) => {
            const left = 189.2 + node.position.x * 0.1;
            const top = -179.4 + node.position.y * 0.1;
            const right = left + node.width * 0.1;
            const bottom = top + node.height * 0.1;
            const dx = screenX < left ? left - screenX : screenX > right ? screenX - right : 0;
            const dy = screenY < top ? top - screenY : screenY > bottom ? screenY - bottom : 0;
            const distance = Math.hypot(dx, dy);
            return distance < best.distance ? { node, distance } : best;
        }, { node: null, distance: Number.POSITIVE_INFINITY });
        const denseConnections = libtvOriginalEdgeEndpoints.flatMap((edge, index) => {
            const fromMatch = nearestChild(edge.sx, edge.sy);
            const toMatch = nearestChild(edge.ex, edge.ey);
            const fromNode = fromMatch.node;
            const toNode = toMatch.node;
            // Endpoints far outside the captured node rectangles belong to
            // off-screen/private nodes. Do not attach them to an unrelated
            // visible thumbnail merely because it is the nearest one.
            if (!fromNode || !toNode || fromMatch.distance > 1 || toMatch.distance > 1) return [];
            // Preserve parallel edges. The captured LibTV graph contains
            // repeated source/target pairs, and collapsing them changes the
            // visible wire density in the overview.
            return [{ id: `libtv-dense-edge-${index}`, fromNodeId: fromNode.id, toNodeId: toNode.id }];
        });
        connectionsRef.current = denseConnections;
        setConnections(denseConnections);
        selectedNodeIdsRef.current = new Set();
        pageUi.getState().setSelectedNodeIds(new Set());
        pageUi.getState().setDialogNodeId(null);
        // Match the public read-only overview captured from LibTV: 10% scale,
        // two-column groups and a small top-left camera offset.
        const denseViewport = { x: 189.2, y: -179.4, k: 0.1 };
        viewportRef.current = denseViewport;
        setViewport(denseViewport);
        // Do not save in the read-only fixture: LibTV's public viewer has no
        // local-save toast or persistence side effect while it is being read.
    }, [pageUi, connectionsRef, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setConnections, setNodes, setViewport, selectedNodeIdsRef, viewportRef]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-video-merge") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-video-merge")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvVideoMergeFixture(searchParams.get("fixtureMedia") || undefined);
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        const selectedFixtureNodes = new Set(fixtureNodes.map((node) => node.id));
        selectedNodeIdsRef.current = selectedFixtureNodes;
        pageUi.getState().setSelectedNodeIds(selectedFixtureNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
    }, [pageUi, focusFixtureOnNarrowViewport, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes, selectedNodeIdsRef]);

    useEffect(() => {
        if (!projectLoaded || readOnly || !["libtv-video", "libtv-video-subtitle"].includes(searchParams.get("fixture") || "")) return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-video" || node.metadata?.fixture === "libtv-video-subtitle")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = searchParams.get("fixture") === "libtv-video-subtitle" ? createLibTvVideoSubtitleFixture(searchParams.get("fixtureMedia") || undefined) : createLibTvVideoFixture(searchParams.get("fixtureMedia") || undefined);
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-video-conversion") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-video-conversion")) return;
        fixtureAppliedRef.current = projectId;
        const fixture = createLibTvVideoConversionFixture(searchParams.get("fixtureMedia") || undefined);
        const nextNodes = [...nodesRef.current, ...fixture.nodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        setConnections((current) => [...current, fixture.connection]);
        focusFixtureOnNarrowViewport(fixture.nodes);
        void saveCanvasProject({ requireRemote: false });
    }, [connectionsRef, focusFixtureOnNarrowViewport, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setConnections, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-audio") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-audio")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvAudioFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-text") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-text")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvTextFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-text-empty") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-text-empty")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvEmptyTextFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        // Visual audit fixtures are ephemeral; avoid showing the local-save
        // toast over the LibTV reference screenshot when chrome mode is on.
        if (searchParams.get("libtvChrome") !== "1") void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-generating") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-generating")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvGeneratingFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
        // Local runtime normally converts stale loading snapshots to an error
        // immediately after a refresh. The fixture intentionally re-enters the
        // running state after that guard so the visual contract can be audited
        // without pretending a real backend task exists.
        window.setTimeout(() => {
            setNodes((current) => current.map((node) => node.metadata?.fixture === "libtv-generating" ? {
                ...node,
                metadata: {
                    ...node.metadata,
                    status: "loading",
                    taskId: node.metadata.taskId || "libtv-fixture-task-42",
                    taskCreatedAt: node.metadata.taskCreatedAt || new Date(0).toISOString(),
                    taskStatus: "running",
                    taskProgress: 42,
                    taskStage: "正在生成画面",
                    errorDetails: undefined,
                },
            } : node));
        }, 260);
    }, [focusFixtureOnNarrowViewport, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);
}
