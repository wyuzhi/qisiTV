import type { CanvasProjectStageOverlaysProps } from "@/pages/canvas/canvas-project-overlays";
import type { CanvasProjectStageProps } from "@/pages/canvas/canvas-project-stage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type OverlayStageFixtureOverrides = {
    nodes?: CanvasNodeData[];
    dialogNode?: CanvasNodeData | null;
    angleNode?: CanvasNodeData | null;
    lightingNode?: CanvasNodeData | null;
    emotionNode?: CanvasNodeData | null;
    toolbarNode?: CanvasNodeData | null;
    selectedNodeIds?: Set<string>;
    selectedNodeBounds?: { count: number; x: number; y: number; width: number; height: number } | null;
    maskEditNodeId?: string | null;
    annotationNodeId?: string | null;
    emotionNodeId?: string | null;
    angleNodeId?: string | null;
    textEditorNodeId?: string | null;
    nodeImageSettingsOpen?: boolean;
    selectionBox?: { x: number; y: number; width: number; height: number } | null;
    isCanvasNodeMoving?: boolean;
    isNodeDragging?: boolean;
    dragPreview?: { nodeIds: Set<string>; x: number; y: number } | null;
    focusMode?: boolean;
    readOnly?: boolean;
    setDialogNodeId?: (next: string | null | ((current: string | null) => string | null)) => void;
    setMaskEditNodeId?: (next: string | null) => void;
    setAngleNodeId?: (next: string | null | ((current: string | null) => string | null)) => void;
    generateAngleNode?: (node: CanvasNodeData, params: unknown) => Promise<void>;
    renderCanvasNodePanel?: (node: CanvasNodeData) => unknown;
    createUpscaleProcessingNode?: (node: CanvasNodeData) => void;
};

export function createCanvasStageOverlayProps(overrides: OverlayStageFixtureOverrides = {}): CanvasProjectStageOverlaysProps {
    const noop = () => undefined;
    const noopAsync = async () => undefined;
    const state = {
        selectedNodeIds: overrides.selectedNodeIds ?? new Set<string>(),
        nodeImageSettingsOpen: overrides.nodeImageSettingsOpen ?? false,
        setDialogNodeId: overrides.setDialogNodeId ?? noop,
    };
    const pageUi = ((selector: (s: typeof state) => unknown) => selector(state)) as unknown as CanvasProjectStageOverlaysProps["pageUi"];

    return {
        currentProject: { id: "canvas-test", title: "测试画布" } as CanvasProjectStageOverlaysProps["currentProject"],
        workspaceMode: "canvas" as unknown as CanvasProjectStageOverlaysProps["workspaceMode"],
        readOnly: overrides.readOnly ?? false,
        assets: [],
        searchParams: new URLSearchParams(),
        pageUi,
        workflowsRef: { current: null },
        preferences: {
            changeSnapToGrid: noop,
            focusMode: overrides.focusMode ?? false,
            isMiniMapOpen: false,
            showConnections: true,
            snapToGrid: false,
            toggleConnections: noop,
            toggleMiniMap: noop,
        } as unknown as CanvasProjectStageOverlaysProps["preferences"],
        viewportState: {
            containerRef: { current: null },
            viewport: { x: 0, y: 0, k: 1 },
            size: { width: 1280, height: 800 },
        } as unknown as CanvasProjectStageOverlaysProps["viewportState"],
        viewportController: {
            fitCanvasContent: noop,
            handleViewportChange: noop,
            previewViewport: noop,
            setZoomScale: noop,
            focusCanvasImageNode: noop,
        } as unknown as CanvasProjectStageOverlaysProps["viewportController"],
        document: {
            nodes: overrides.nodes ?? [],
        } as unknown as CanvasProjectStageOverlaysProps["document"],
        dialogs: {
            openTextNodeEditor: noop,
            setInfoNodeId: noop,
            setPreviewNodeId: noop,
            setSubtitleNodeId: noop,
            setTimelineNodeId: noop,
            textEditorNodeId: overrides.textEditorNodeId ?? null,
        } as unknown as CanvasProjectStageOverlaysProps["dialogs"],
        generation: {
            generateImageFromTextNode: noop,
            generateFinalVideoFromDraftNode: noop,
            createVideoEditNodeFromVideo: noop,
        } as unknown as CanvasProjectStageOverlaysProps["generation"],
        uploads: {
            handleUploadRequest: noop,
            handleAssetsInsert: noopAsync,
        } as unknown as CanvasProjectStageOverlaysProps["uploads"],
        mediaSelection: {
            mediaTools: {
                angleNodeId: overrides.angleNodeId ?? null,
                annotationNodeId: overrides.annotationNodeId ?? null,
                closeInlineVideoTrim: noop,
                confirmInlineVideoTrim: noopAsync,
                depthCaptureNode: noopAsync,
                emotionNodeId: overrides.emotionNodeId ?? null,
                extractAudioFromVideo: noopAsync,
                extractVideoFrameAt: noopAsync,
                extractingVideoFramesNodeId: null,
                generateAngleNode: overrides.generateAngleNode ?? noopAsync,
                generateEmotionNode: noopAsync,
                generateLightingNode: noop,
                inlineTrimRunning: false,
                maskEditNodeId: overrides.maskEditNodeId ?? null,
                mergeSelectedVideos: noopAsync,
                mergeVideoProgress: null,
                openInlineVideoTrim: noop,
                openPanoramaConfig: noop,
                openPortraitTextureEditor: noop,
                openVideoCrop: noop,
                openVideoSubtitleErase: noop,
                segmentRunningMode: null,
                setAnnotationNodeId: noop,
                setCropNodeId: noop,
                setMaskEditNodeId: overrides.setMaskEditNodeId ?? noop,
                setUpscaleNodeId: noop,
                splitImageNode: noopAsync,
                createImageReversePromptNodes: noop,
            },
            createUpscaleProcessingNode: overrides.createUpscaleProcessingNode ?? noop,
            setAngleNodeId: overrides.setAngleNodeId ?? noop,
            setLightingNodeId: noop,
            setEmotionNodeId: noop,
            nodeOperations: {
                alignSelectedNodes: noop,
                arrangeSelectedNodes: noop,
                autoArrangeCanvasNodes: noop,
                createReferenceGroup: noop,
                createStoryboardGroup: noop,
                deleteNodes: noop,
                packSelectedIntoFolder: noop,
                toggleNodeLocked: noop,
            },
            connectionController: {
                beginBatchConnectionMode: noop,
                cancelPendingConnectionCreate: noop,
                connectionReplaceHover: null,
                createConnectedNode: noopAsync,
                getConnectionCreateDisabledReason: () => null,
                openQuickConnectionMenu: noop,
                pendingConnectionCreate: null,
            },
            selectionController: {
                dragPreview: overrides.dragPreview ?? null,
                isNodeDragging: overrides.isNodeDragging ?? false,
                selectionBoundsElementRef: { current: null },
                selectionBox: overrides.selectionBox ?? null,
            },
            toolbarHover: {
                keepNodeToolbar: noop,
                hideNodeToolbar: noop,
            },
            nodeEditor: {
                downloadNodeImage: noop,
                handleFontSizeChange: noop,
                saveNodeAsset: noopAsync,
                toggleNodeFreeResize: noop,
            },
            renderModel: {
                angleNode: overrides.angleNode ?? null,
                canvasImageNodes: [],
                emotionNode: overrides.emotionNode ?? null,
                lightingNode: overrides.lightingNode ?? null,
                selectedNodeBounds: overrides.selectedNodeBounds ?? null,
                selectedVideoNodes: [],
                toolbarNode: overrides.toolbarNode ?? null,
            },
            dialogNode: overrides.dialogNode ?? null,
            isCanvasNodeMoving: overrides.isCanvasNodeMoving ?? false,
            inlineTrimNode: null,
            canCreateDrawingFromConnection: false,
        } as unknown as CanvasProjectStageOverlaysProps["mediaSelection"],
        actions: {
            renderCanvasNodePanel: overrides.renderCanvasNodePanel ?? (() => null),
            retryCanvasNode: noop,
        } as unknown as CanvasProjectStageOverlaysProps["actions"],
        askSelectedNodes: noop,
    };
}

export function createCanvasStageProps(overrides: OverlayStageFixtureOverrides = {}): CanvasProjectStageProps {
    const noop = () => undefined;
    const noopAsync = async () => undefined;
    return {
        ...createCanvasStageOverlayProps(overrides),
        projectId: "canvas-test",
        shortDramaEnabled: false,
        effectiveConfig: {} as CanvasProjectStageProps["effectiveConfig"],
        shortcutRequestNonce: 0,
        versions: {} as CanvasProjectStageProps["versions"],
        activeTasks: [],
        historyState: { canUndo: false, canRedo: false } as CanvasProjectStageProps["historyState"],
        undoCanvas: noop,
        redoCanvas: noop,
        reloadLatestCanvasProject: noopAsync,
        openVersions: noop,
        toggleVersions: noop,
        nodeGraphContext: {} as CanvasProjectStageProps["nodeGraphContext"],
    };
}

export function makeCanvasNode(id: string, type: CanvasNodeType, metadata: Record<string, unknown> = {}): CanvasNodeData {
    return {
        id,
        type,
        title: id,
        position: { x: 100, y: 120 },
        width: 320,
        height: 240,
        metadata: metadata as CanvasNodeData["metadata"],
    };
}
