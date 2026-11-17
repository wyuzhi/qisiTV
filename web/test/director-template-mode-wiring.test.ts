import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, useContext, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeActionContext, type CanvasNodeActionContextValue } from "@/components/canvas/canvas-node-action-context";

import { canvasNodeDragEndChrome } from "@/pages/canvas/canvas-pointer-chrome";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { DIRECTOR_ACTOR_PRESET_OPTIONS } from "@/lib/canvas/director/director-actor-presets";
import { snapDirectorTime } from "@/lib/canvas/director/director-animation-semantics";
import { DIRECTOR_MODES, directorModeCapabilities } from "@/lib/canvas/director/director-modes";
import { directorTransformPathLength, interpolateDirectorTransform } from "@/lib/canvas/director/director-scene";
import { isDirectorOutputTargetCurrent, mergeDirectorOutputPreview } from "@/lib/canvas/director/director-session";
import { createDirectorSceneFromTemplate } from "@/lib/canvas/director/director-templates";
import { useDirectorWorkbenchStore } from "@/stores/canvas/use-director-workbench-store";
import { CanvasNodeType } from "@/types/canvas";

const toolbarRendered: Array<Record<string, unknown>> = [];
const contextMenuRendered: Array<Record<string, unknown>> = [];
const observedActionContexts: CanvasNodeActionContextValue[] = [];

mock.module("@/components/canvas/canvas-toolbar", () => ({
    CanvasToolbar: (props: Record<string, unknown>) => {
        toolbarRendered.push(props);
        return null;
    },
}));
mock.module("@/pages/canvas/canvas-project-context-menu", () => ({
    CanvasProjectContextMenu: (props: Record<string, unknown>) => {
        contextMenuRendered.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/infinite-canvas", () => ({
    InfiniteCanvas: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
mock.module("@/components/canvas/canvas-lod-layer", () => ({ CanvasLodLayer: () => null }));
mock.module("@/components/canvas/canvas-leafer-graphics-layer", () => ({ CanvasLeaferGraphicsLayer: () => null }));
mock.module("@/components/canvas/canvas-active-task-panel", () => ({ CanvasActiveTaskPanel: () => null }));
mock.module("@/components/canvas/canvas-focus-mode-bar", () => ({ CanvasFocusModeBar: () => null }));
mock.module("@/components/canvas/canvas-file-drop-overlay", () => ({ CanvasFileDropOverlay: () => null }));
mock.module("@/pages/canvas/canvas-project-overlays", () => ({ CanvasProjectStageOverlays: () => null }));
mock.module("@/pages/canvas/canvas-project-world-layers", () => ({
    CanvasProjectWorldLayers: () => {
        observedActionContexts.push(useContext(CanvasNodeActionContext));
        return null;
    },
}));
mock.module("@/pages/canvas/canvas-sync-status", () => ({ CanvasSyncStatus: () => null }));

const { CanvasProjectStage } = await import("@/pages/canvas/canvas-project-stage");
const { CanvasDirectorNodePanel } = await import("@/components/canvas/director/canvas-director-node-panel");
const { DirectorViewportDock } = await import("@/components/canvas/director/director-viewport-dock");
const { createCanvasStageProps } = await import("./helpers/canvas-stage-overlays-fixture");

beforeEach(() => {
    toolbarRendered.length = 0;
    contextMenuRendered.length = 0;
    observedActionContexts.length = 0;
    useDirectorWorkbenchStore.getState().reset();
});

describe("新建场景直达空导演台与入口接线", () => {
    test("空导演台场景与独立导演台节点不携带视频生成输入框状态", () => {
        const scene = createDirectorSceneFromTemplate("empty", "镜头 1");
        expect(scene.objects).toEqual([]);
        expect("mode" in scene).toBe(false);

        const node = createCanvasNode(CanvasNodeType.Director, { x: 120, y: 80 }, { directorSceneId: scene.id });
        expect(node.type).toBe(CanvasNodeType.Director);
        expect(node.metadata?.directorSceneId).toBe(scene.id);
        expect(node.metadata?.generationMode).toBeUndefined();
        expect(node.metadata?.composerContent).toBeUndefined();
        expect(canvasNodeDragEndChrome(node)).toEqual({ dialogNodeId: null, toolbarNodeId: undefined });
    });

    test("画布工具栏与右键菜单直接创建导演台，右键入口透传点击位置", () => {
        const calls: Array<{ pos?: { x: number; y: number } }> = [];
        const stageProps = createCanvasStageProps({ focusMode: false, readOnly: false });
        stageProps.actions = {
            ...stageProps.actions,
            contextMenuHandlers: {
                handleCanvasContextMenu: () => undefined,
                handleConnectionSelect: () => undefined,
                handleConnectionContextMenu: () => undefined,
                handleNodeContextMenu: () => undefined,
            },
            mediaShareActions: {
                copyNodeContentToClipboard: async () => undefined,
                copyNodeMediaUrlToClipboard: async () => undefined,
                confirmUploadNodeImageToArkPrivateAsset: () => undefined,
            },
            createDirectorShot: (position?: { x: number; y: number }) => {
                calls.push({ pos: position });
            },
        } as typeof stageProps.actions;
        stageProps.preferences = {
            ...stageProps.preferences,
            focusDockRevealed: true,
        } as typeof stageProps.preferences;
        stageProps.viewportController = {
            ...stageProps.viewportController,
            screenToCanvas: (x: number, y: number) => ({ x, y }),
        } as typeof stageProps.viewportController;
        const origPageUi = stageProps.pageUi;
        stageProps.pageUi = Object.assign(
            (selector: (s: Record<string, unknown>) => unknown) =>
                selector({
                    selectedNodeIds: new Set<string>(),
                    selectedConnectionId: null,
                    activeMediaNodeId: null,
                    setActiveMediaNodeId: () => undefined,
                    contextMenu: null,
                    setContextMenu: () => undefined,
                    scriptScrollTopById: {},
                    nodeImageSettingsOpen: false,
                    setDialogNodeId: () => undefined,
                }),
            { getState: () => ({ setLodHoverNodeId: () => undefined }) },
        ) as unknown as typeof origPageUi;
        stageProps.mediaSelection = {
            ...stageProps.mediaSelection,
            reloadCanvasNodeResource: async () => undefined,
            replaceCanvasNodeMedia: () => undefined,
            timelineAssetInsert: {
                openCanvasAssetLibrary: () => undefined,
                openProjectAssets: () => undefined,
            },
            cancelImageCrop: () => undefined,
            cancelAnnotation: () => undefined,
            cancelMaskEdit: () => undefined,
            cancelVideoCrop: () => undefined,
            selectionController: {
                ...stageProps.mediaSelection.selectionController,
                alignmentGuides: [],
                deselectCanvas: () => undefined,
                frameDropTargetId: null,
                handleCanvasMouseDown: () => undefined,
                handleNodeMouseDown: () => undefined,
            },
            renderModel: {
                ...stageProps.mediaSelection.renderModel,
                activeNodeId: null,
                batchChildCountById: new Map(),
                batchMotionById: new Map(),
                contextMenuNode: null,
                frameChildrenById: new Map(),
                lodActive: false,
                lodNodes: [],
                maskEditNode: null,
                mentionReferencesByNodeId: new Map(),
                nodeById: new Map(),
                reduceMediaEffects: false,
                relatedHighlight: { nodeIds: new Set(), connectionIds: new Set() },
                resourceReferenceByNodeId: new Map(),
                visibleNodes: [],
            },
            connectionController: {
                ...stageProps.mediaSelection.connectionController,
                batchConnectionPreview: null,
                connectionApproach: null,
                connectionTargetAnchorRatio: null,
                connectionTargetNodeId: null,
                connectingParams: null,
                handleConnectStart: () => undefined,
                mouseWorld: { x: 0, y: 0 },
                startBatchConnection: () => undefined,
            },
            nodeOperations: {
                ...stageProps.mediaSelection.nodeOperations,
                copyNodesToClipboard: () => undefined,
                copySelectedNodes: () => undefined,
                createFolder: () => undefined,
                createNode: () => undefined,
                deleteConnection: () => undefined,
                duplicateNode: () => undefined,
                hasCopiedNodes: false,
                spreadSelectedNodes: () => undefined,
            },
            linkedFolderPreviewNodesById: new Map(),
            lodPinnedNodeIds: new Set(),
            renderedConnections: [],
            canvasNodeActions: {},
        } as unknown as typeof stageProps.mediaSelection;

        renderToStaticMarkup(createElement(CanvasProjectStage, stageProps));
        expect(toolbarRendered).toHaveLength(1);
        expect(contextMenuRendered).toHaveLength(1);
        expect(observedActionContexts).toHaveLength(1);
        expect(observedActionContexts[0]).toBe(stageProps.mediaSelection.canvasNodeActions as unknown as CanvasNodeActionContextValue);

        (toolbarRendered[0]?.onOpenDirector as () => void)();
        (contextMenuRendered[0]?.onOpenDirector as (pos: { x: number; y: number }) => void)({ x: 320, y: 240 });
        expect(calls).toEqual([{ pos: undefined }, { pos: { x: 320, y: 240 } }]);
    });

    test("导演节点面板仅保留打开入口，不渲染上传或提示词输入控件", () => {
        const scene = createDirectorSceneFromTemplate("empty", "空镜");
        const node = createCanvasNode(CanvasNodeType.Director, { x: 0, y: 0 }, { directorSceneId: scene.id });
        const html = renderToStaticMarkup(
            createElement(CanvasDirectorNodePanel, {
                node,
                scene,
                readNodeContent: () => undefined,
                onOpen: () => undefined,
            }),
        );
        expect(html).not.toContain("<textarea");
        expect(html).not.toContain("场景描述");
    });
});

describe("导演台模式能力与异步状态保护", () => {
    test("角色预设按 identity 区分标准角色与几何体，不靠下标切片", () => {
        const characters = DIRECTOR_ACTOR_PRESET_OPTIONS.filter((preset) => preset.id !== "geometric");
        const geometries = DIRECTOR_ACTOR_PRESET_OPTIONS.filter((preset) => preset.id === "geometric");
        expect(characters.length).toBeGreaterThan(0);
        expect(geometries.map((item) => item.id)).toEqual(["geometric"]);
    });

    test("store 按模式约束 renderMode，切离动画模式时停播、关 Auto Key 并复位合法渲染视图", () => {
        const store = useDirectorWorkbenchStore;
        store.getState().setMode("layout");
        store.getState().setRenderMode("pose");
        expect(store.getState().renderMode).toBe("beauty");

        store.getState().setMode("animate");
        store.getState().setRenderMode("pose");
        store.getState().setPlaying(true);
        store.getState().setAutoKey(true);
        expect(store.getState().renderMode).toBe("pose");

        store.getState().setMode("layout");
        expect(store.getState().playing).toBe(false);
        expect(store.getState().autoKey).toBe(false);
        expect(store.getState().renderMode).toBe("beauty");
        expect(directorModeCapabilities("animate").keyframes).toBe(true);
        expect(directorModeCapabilities("layout").keyframes).toBe(false);
        expect(DIRECTOR_MODES.map((m) => m.mode)).toEqual(["layout", "pose", "animate", "camera"]);
    });

    test("dock 按模式 capabilities 渲染模式与工作区选中态", () => {
        const html = renderToStaticMarkup(
            createElement(DirectorViewportDock, {
                transformMode: "translate",
                renderMode: "depth",
                renderModes: directorModeCapabilities("camera").renderModes,
                onTransformModeChange: () => undefined,
                onRenderModeChange: () => undefined,
                timelineOpen: false,
                onToggleTimeline: () => undefined,
                captureBusy: false,
                captureReady: true,
                onCapture: () => undefined,
                onExportClay: () => undefined,
                exportBusy: false,
                onApplyToCanvas: () => undefined,
                applyBusy: false,
                saveRetryable: false,
                saveRetryBusy: false,
                onRetrySave: () => undefined,
                mode: "camera",
                workspaceView: "scene",
            }),
        );
        expect(html).toContain('data-director-mode="camera"');
        expect(html).toContain('data-workspace-view="scene"');
    });

    test("时间对齐、路径插值与异步输出归属校验行为正常", () => {
        expect(snapDirectorTime(1 / 24 + 0.001, 24)).toBeCloseTo(1 / 24, 3);
        const keyframes = [
            { id: "k1", time: 0, transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } },
            { id: "k2", time: 2, transform: { position: [4, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } },
        ];
        expect(directorTransformPathLength(keyframes)).toBeCloseTo(4, 3);
        expect(interpolateDirectorTransform(keyframes[0]!.transform, keyframes, 1).position[0]).toBeCloseTo(2, 3);

        const scene = createDirectorSceneFromTemplate("empty", "输出");
        const updated = mergeDirectorOutputPreview(scene, { sceneId: scene.id, shotId: scene.activeShotId, previewNodeId: "img-preview" });
        expect(updated?.shots.find((s) => s.id === scene.activeShotId)?.previewNodeId).toBe("img-preview");
        expect(
            isDirectorOutputTargetCurrent({
                currentProjectId: "p1",
                outputProjectId: "p1",
                projectExists: true,
                sourceNode: { id: "node-1", metadata: { directorSceneId: scene.id } },
                sourceNodeId: "node-1",
                latestScene: scene,
                sceneId: scene.id,
                shotId: scene.activeShotId,
            }),
        ).toBe(true);
        expect(
            isDirectorOutputTargetCurrent({
                currentProjectId: "p2",
                outputProjectId: "p1",
                projectExists: true,
                sourceNode: { id: "node-1", metadata: { directorSceneId: scene.id } },
                sourceNodeId: "node-1",
                latestScene: scene,
                sceneId: scene.id,
                shotId: scene.activeShotId,
            }),
        ).toBe(false);
    });
});
