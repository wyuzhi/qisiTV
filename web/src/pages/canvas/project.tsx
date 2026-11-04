import { localAssetToInsertPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasAssistantSidebar } from "./canvas-assistant-sidebar";
import { useCanvasAssistantContinuation } from "./use-canvas-assistant-continuation";
import { highlightAssistantNodes } from "./canvas-assistant-highlight";
import { resolveCanvasRightPanel, useCanvasAssistant, useCanvasAssistantDockable } from "./use-canvas-assistant";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { generationErrorMessage } from "@/lib/generation-error";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { isCanvasImageSourceNode } from "@/lib/canvas/canvas-image-source";
import { canOpenCanvasNodePromptPanel, isCanvasMediaResultNode } from "@/lib/canvas/canvas-node-semantics";
import { nanoid } from "nanoid";
import { summarizeCanvasContext } from "@/lib/canvas/canvas-context-summary";
import { DEFAULT_DRAWING_ENGINE } from "@/lib/canvas/canvas-drawing-engine";
import { useAssetStore } from "@/stores/use-asset-store";
import { usePersonalAssetLibrary } from "@/hooks/use-personal-asset-library";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import { useCanvasThemeScope } from "@/stores/canvas/use-canvas-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { App, Button } from "antd";
import { ArrowLeftRight } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { CanvasDeleteConfirmation } from "@/components/canvas/canvas-delete-confirmation";
import { CanvasActiveTaskPanel } from "@/components/canvas/canvas-active-task-panel";
import { CanvasAssetTray } from "@/components/canvas/canvas-asset-tray";
import { CanvasProjectSidebar } from "@/components/canvas/canvas-project-sidebar";
import { CanvasNodeToolbar } from "@/components/canvas/canvas-node-toolbar";
import { useCanvasUpscaleBatch } from "./use-canvas-upscale-batch";
import { CanvasVideoInlineTrimOverlay } from "@/components/canvas/canvas-video-inline-trim";
import { CanvasNodeAnglePanel } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeLightingPanel } from "@/components/canvas/canvas-node-lighting-dialog";
import { CanvasFileDropOverlay } from "@/components/canvas/canvas-file-drop-overlay";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { useCanvasCreateCommands } from "@/components/canvas/use-canvas-create-commands";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { buildCanvasAgentMentionReferences, getContextResourceNodes, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasConnectionCreateMenu, CanvasNodePanelOverlay } from "@/components/canvas/canvas-workspace-overlays";
import { CanvasOverlayLayerContainer, CanvasOverlayLayerProvider } from "@/components/canvas/canvas-overlay-layer";
import { CanvasLeaferGraphicsLayer } from "@/components/canvas/canvas-leafer-graphics-layer";
import { CanvasLodLayer } from "@/components/canvas/canvas-lod-layer";
import { CanvasFreeformEmptyState, CanvasLinkedProjectEmptyState, CanvasShortDramaEmptyState, CanvasShortDramaGuide } from "@/components/canvas/canvas-short-drama-entry";
import { resolveCanvasEmptyStateKind } from "@/lib/canvas/canvas-starter";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { listCanvasWorkspaceProjectCanvases } from "@/lib/canvas/canvas-workspace-project";
import { batchSourceRestriction } from "@/lib/canvas/canvas-batch-connection";
import { CanvasSyncStatus } from "./canvas-sync-status";
import { CanvasVersionHistory, useCanvasVersionHistory } from "./canvas-version-history";
import { CanvasVersionPreview } from "./canvas-version-preview";
import { CanvasTopBar } from "./canvas-project-top-bar";
import { CanvasFocusModeBar } from "@/components/canvas/canvas-focus-mode-bar";
import { CanvasProjectContextMenu } from "./canvas-project-context-menu";
import { useCanvasStarterNavigation } from "./use-canvas-starter-navigation";
import { useCanvasImport } from "./use-canvas-import";
import { useCanvasNodeReferences } from "./use-canvas-node-references";
import { CanvasProjectNodePrompt } from "./canvas-project-node-prompt";
import { CanvasProjectNodeContent } from "./canvas-project-node-content";
import { CanvasProjectEditorDialogs } from "./canvas-project-editor-dialogs";
import { CanvasProjectSelectionToolbar } from "./canvas-project-selection-toolbar";
import { CanvasWorkflowWorkspace, type CanvasWorkflowsHandle } from "./canvas-workflow-workspace";
import { useCanvasWorkflowInstances } from "./use-canvas-workflow-instances";
import { workflowDropSlot } from "@/lib/canvas/reusable-workflow-instance";
import { CanvasProjectWorldLayers } from "./canvas-project-world-layers";
import { CanvasNodeActionContext, type CanvasNodeActionContextValue } from "@/components/canvas/canvas-node-action-context";
import { CanvasNodeGraphContext, type CanvasNodeGraphContextValue } from "@/components/canvas/canvas-node-graph-context";
import { CanvasRefreshShell } from "./canvas-refresh-shell";
import type { CanvasImageEmotionPayload } from "@/components/canvas/canvas-node-emotion-panel";
import { CanvasEmotionWorkspace } from "@/components/canvas/canvas-emotion-workspace";
import { removeCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { persistCanvasTimeline, refreshLocalCanvasProjectIfChanged } from "@/services/local-workspace-repository";
import { CanvasUploadModal } from "@/components/canvas/canvas-upload-modal";
import { useCanvasConnectionController } from "./use-canvas-connection-controller";
import { useCanvasActiveTasks } from "./use-canvas-active-tasks";
import { useCanvasStyleWorkflow } from "./use-canvas-style-workflow";
import { useCanvasDirector } from "./use-canvas-director";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasKeyboard } from "./use-canvas-keyboard";
import { useCanvasMediaTools } from "./use-canvas-media-tools";
import { useCanvasNodeEditor } from "./use-canvas-node-editor";
import { useCanvasNodeOperations } from "./use-canvas-node-operations";
import { useCanvasProjectMenu } from "./use-canvas-project-menu";
import { buildLinkedFolderPreviewNodes } from "@/lib/canvas/canvas-linked-folder-previews";
import { planUpscaleProcessingNode } from "@/lib/canvas/canvas-upscale-processor";
import { useCanvasProjectLifecycle } from "./use-canvas-project-lifecycle";
import { useCanvasRenderModel } from "./use-canvas-render-model";
import { useCanvasSelectionController } from "./use-canvas-selection-controller";
import { useCanvasShortDrama } from "./use-canvas-short-drama";
import { useCanvasUpload } from "./use-canvas-upload";
import { useCanvasTimelineAssetInsert } from "./use-canvas-timeline-asset-insert";
import { useCanvasViewportController } from "./use-canvas-viewport-controller";
import { useCanvasViewportState, useCanvasDockedViewport } from "./use-canvas-viewport-state";
import { useCanvasDocumentState } from "./use-canvas-document-state";
import { useCanvasPreferences } from "./use-canvas-preferences";
import { useCanvasLibTvVisualFixtures } from "./use-canvas-libtv-visual-fixtures";
import { useCanvasNodeMediaShareActions } from "./use-canvas-node-media-share-actions";
import { canvasNodeRetryPlan } from "./canvas-generation-orchestration";
import { linkedFolderPresentation } from "./canvas-resource-handoff-plan";
import { useCanvasAssistantProposal } from "./use-canvas-assistant-proposal";
import { useCanvasConnectedNodeVisibility } from "./use-canvas-connected-node-visibility";
import { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import { useCanvasPointerSelectionChrome, useCanvasNodeToolbarHover } from "./use-canvas-pointer-chrome";
import { useCanvasNodeClick } from "./use-canvas-node-click";
import { pasteCanvasAtPosition } from "./canvas-project-clipboard";
import { useCanvasContextMenu } from "./use-canvas-context-menu";
import { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import { useCanvasResourceHandoff } from "./use-canvas-resource-handoff";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasWorkspaceMode, type Position } from "@/types/canvas";


export default function CanvasPage() {
    useCanvasThemeScope();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function InfiniteCanvasPage() {
    // 命令式确认必须走 App.useApp().modal；静态 Modal.confirm 拿不到主题和 App 上下文。
    const { message, modal } = App.useApp();
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const projectId = params.id || "";
    const readOnly = searchParams.get("readonly") === "1" || searchParams.get("mode") === "readonly";
    const [projectLoaded, setProjectLoaded] = useState(false);
    const viewportState = useCanvasViewportState(projectId, projectLoaded);
    const { containerRef, viewport, viewportRef, setViewport, virtualizationViewport, setVirtualizationViewport, size } = viewportState;

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const assets = usePersonalAssetLibrary();
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const defaultDrawingEngine = DEFAULT_DRAWING_ENGINE;
    const shortDramaEnabled = useUserStore((state) => state.features.shortDramaEnabled);
    const storageMode = useUserStore((state) => state.storageMode);
    const user = useUserStore((state) => state.user);
    const localOnly = isLocalWorkspaceMode() || storageMode === "local" || user?.username === "local" || import.meta.env.VITE_CANVAS_LOCAL_MODE !== "false";
    const storedCanvasProjects = useCanvasStore((state) => state.projects);
    const workspaceCanvases = useMemo(
        () => listCanvasWorkspaceProjectCanvases(storedCanvasProjects, projectId),
        [projectId, storedCanvasProjects],
    );
    const workspaceProject = workspaceCanvases[0] || null;
    const canvasProjects = useMemo(
        () => workspaceCanvases.map((project, index) => ({
            id: project.id,
            title: project.canvasTitle?.trim() || `画布 ${index + 1}`,
        })),
        [workspaceCanvases],
    );
    const directorOnboardingScope = useUserStore((state) => state.user?.id?.trim() || "");
    const document = useCanvasDocumentState(projectId);
    const { nodes, nodesRef, setNodes, setNodesState, adoptNodes, connections, connectionsRef, setConnections, chatSessions, chatSessionsRef, setChatSessions, activeChatId, activeChatIdRef, setActiveChatId, nodeStackOrder, bringNodeToFront } = document;
    const workflowsRef = useRef<CanvasWorkflowsHandle>(null);
    // 选中、悬停和面板属于这个页面实例。切画布时这些 id 不属于新画布，
    // 不清空会同时污染选中高亮和创作助手请求的归属校验（后端按画布校验选中对象）。
    const [pageUi] = useState(createCanvasPageUiStore);
    const selectedNodeIds = pageUi((state) => state.selectedNodeIds);
    const setSelectedNodeIds = pageUi((state) => state.setSelectedNodeIds);
    const workflowLibraryOpen = pageUi((state) => state.workflowLibraryOpen);
    const setWorkflowLibraryOpen = pageUi((state) => state.setWorkflowLibraryOpen);
    const selectedConnectionId = pageUi((state) => state.selectedConnectionId);
    const setSelectedConnectionId = pageUi((state) => state.setSelectedConnectionId);
    const hoveredNodeId = pageUi((state) => state.hoveredNodeId);
    // Overview LOD: the node under the pointer is promoted to a full DOM card.
    const lodHoverNodeId = pageUi((state) => state.lodHoverNodeId);
    const setLodHoverNodeId = pageUi((state) => state.setLodHoverNodeId);
    const activeMediaNodeId = pageUi((state) => state.activeMediaNodeId);
    const setActiveMediaNodeId = pageUi((state) => state.setActiveMediaNodeId);
    useEffect(() => {
        pageUi.getState().resetForProject();
    }, [pageUi, projectId]);
    // While the overview canvas is active it culls every frame itself, so
    // camera previews need not re-render this page to refresh virtualization.
    const lodActiveRef = useRef(false);
    const lodEnterScaleRef = useRef(0);
    const contextMenu = pageUi((state) => state.contextMenu);
    const setContextMenu = pageUi((state) => state.setContextMenu);
    const {
        isMiniMapOpen,
        snapToGrid,
        showConnections,
        wheelBehavior,
        canvasTool,
        setCanvasTool,
        canvasAppearance,
        setCanvasAppearance,
        backgroundMode,
        setBackgroundMode,
        showImageInfo,
        setShowImageInfo,
        mediaPerformanceMode,
        setMediaPerformanceMode,
        theme,
        resolvedCanvasAppearance,
        applyCanvasAppearance,
        saveCanvasAppearanceDefault,
        changeSnapToGrid,
        changeConnections,
        changeWheelBehavior,
        toggleConnections,
        toggleMiniMap,
        setShowConnections,
        focusMode,
        enterFocusMode,
        exitFocusMode,
        toggleFocusMode,
        focusDockRevealed,
        setFocusDockRevealed,
    } = useCanvasPreferences();
    const workspaceMode: CanvasWorkspaceMode = "professional";
    const dialogs = useCanvasProjectDialogs(pageUi);
    const {
        openTextNodeEditor,
        openDrawingNode,
        openArtCritique,
        setClearConfirmOpen,
        setGenerationHistoryOpen,
        setTapNowImportOpen,
        setNodeSearchOpen,
        setStylePickerOpen,
        setLibTVImportOpen,
        textEditorNodeId,
        setDrawingNodeId,
        infoNodeId,
        setInfoNodeId,
        setSubtitleNodeId,
        setTimelineNodeId,
        previewNodeId,
        setPreviewNodeId,
        scriptEditorNodeId,
        setScriptEditorNodeId,
        setArtCritiqueNodeId,
        directorNodeId,
        setDirectorNodeId,
        versionCompareRootId,
        setVersionCompareRootId,
        clearDeletedNodeIds,
        resetForClearCanvas,
    } = dialogs;
    const setToolbarNodeId = pageUi((state) => state.setToolbarNodeId);
    const nodeImageSettingsOpen = pageUi((state) => state.nodeImageSettingsOpen);
    const setNodeImageSettingsOpen = pageUi((state) => state.setNodeImageSettingsOpen);
    const dialogNodeId = pageUi((state) => state.dialogNodeId);
    const setDialogNodeId = pageUi((state) => state.setDialogNodeId);
    const scriptScrollTopById = pageUi((state) => state.scriptScrollTopById);
    const [shortcutRequestNonce, setShortcutRequestNonce] = useState(0);
    const [workspaceView, setWorkspaceView] = useState<"workflow" | "storyboard">("workflow");

    const { tasks: activeTasks } = useCanvasActiveTasks(projectId, projectLoaded);
    const selectedNodeIdsRef = useRef(selectedNodeIds);

    const { adoptExternalSnapshot, getHistoryCleanupContext, historyPausedRef, historyState, redoCanvas, resetHistory, undoCanvas } = useCanvasHistory({
        pageUi,
        projectId,
        projectLoaded,
        nodes,
        connections,
        chatSessions,
        activeChatId,
        canvasAppearance,
        backgroundMode,
        showImageInfo,
        setNodes,
        setConnections,
        setChatSessions,
        setActiveChatId,
        applyCanvasAppearance,
        setBackgroundMode,
        setShowImageInfo,
    });

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, ...getHistoryCleanupContext() });
        },
        [cleanupAssetImages, getHistoryCleanupContext],
    );

    const { loadError, retryLoad, addedSkills, clearCanvasFiles, createAndOpenCanvas, currentProject, deleteCurrentProject, renameCurrentProject, reloadLatestCanvasProject, restoreCanvasProjectVersion, saveCanvasProject, forceSaveCanvasProject, updateProject } = useCanvasProjectLifecycle({
        adoptNodes,
        projectId,
        projectLoaded,
        nodes,
        connections,
        chatSessions,
        activeChatId,
        canvasAppearance,
        backgroundMode,
        showImageInfo,
        viewport,
        nodesRef,
        connectionsRef,
        chatSessionsRef,
        activeChatIdRef,
        viewportRef,
        historyPausedRef,
        setNodes,
        setConnections,
        setChatSessions,
        setActiveChatId,
        setCanvasAppearance,
        setBackgroundMode,
        setShowImageInfo,
        setViewport,
        setProjectLoaded,
        resetHistory,
        adoptExternalSnapshot,
        cleanupAssetImages,
        cleanupCanvasFiles,
    });

    useCanvasLibTvVisualFixtures({
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
    });

    const readLiveCanvasContent = useCallback(() => ({
        nodes: nodesRef.current,
        connections: connectionsRef.current,
        chatSessions: chatSessionsRef.current,
        activeChatId: activeChatIdRef.current,
        viewport: viewportRef.current,
    }), []);
    const projectMenu = useCanvasProjectMenu({
        projectId,
        currentProject,
        canvasProjects,
        workspaceTitle: workspaceProject?.title,
        readLiveContent: readLiveCanvasContent,
        renameCurrentProject,
        deleteCurrentProject,
    });

    const versions = useCanvasVersionHistory(projectId, restoreCanvasProjectVersion, currentProject);
    // 画布右侧只有一个栏位：助手和版本记录互斥，谁被打开另一个就让位。
    const assistant = useCanvasAssistant({
        canvasId: projectId,
        onCanvasChanged: (canvasId, changedNodeIds) => {
            if (canvasId !== projectId) return;
            void refreshLocalCanvasProjectIfChanged(canvasId).then(() => highlightAssistantNodes(containerRef.current, changedNodeIds));
        },
    });
    const canvasMainRef = useRef<HTMLElement>(null);
    const assistantDockable = useCanvasAssistantDockable(canvasMainRef);
    const rightPanel = resolveCanvasRightPanel(assistant.open, versions.open);
    const openVersions = () => { workflowsRef.current?.closeLibrary(); assistant.setOpen(false); setVersionCompareRootId(null); versions.show(); };
    const toggleVersions = () => {
        if (!versions.open) { workflowsRef.current?.closeLibrary(); assistant.setOpen(false); }
        setVersionCompareRootId(null);
        versions.toggle();
    };
    const toggleAssistant = useCallback(() => {
        const next = !assistant.open;
        if (next) { workflowsRef.current?.closeLibrary(); versions.close(); }
        assistant.setOpen(next);
    }, [assistant, versions]);
    const openAssistant = useCallback(() => {
        exitFocusMode();
        workflowsRef.current?.closeLibrary();
        versions.close();
        assistant.setOpen(true);
    }, [assistant, exitFocusMode, versions]);
    // 修复素材关联仍遵守当前画布版本，不能替用户确认覆盖云端的新内容。
    const confirmForceSaveCanvas = useCallback(() => {
        modal.confirm({
            title: "修复素材关联并保存？",
            content: "核对画布媒体与素材库的关联，补齐缺失素材后保存。若云端已有新版本，会保留本地草稿并提示加载最新版。",
            okText: "修复并保存",
            cancelText: "取消",
            onOk: () => forceSaveCanvasProject(),
        });
    }, [forceSaveCanvasProject, modal]);

    const { applyLibTVImport, applyTapNowImport } = useCanvasImport({ projectId, document, saveCanvasProject });
    const linkedProjectId = shortDramaEnabled ? currentProject?.projectId || "" : "";
    // 助手只接受属于当前画布的选中项：切画布那一帧仍可能残留旧 id，这里做硬约束，
    // 不让跨画布的 id 进入请求（后端会按画布校验并拒绝整个回合）。
    const assistantSelectedNodeIds = useMemo(() => {
        const available = new Set(nodes.map((node) => node.id));
        return Array.from(selectedNodeIds).filter((id) => available.has(id));
    }, [nodes, selectedNodeIds]);
    // 助手的 @ 菜单覆盖整张画布，而不是只覆盖能当生成输入的资源节点。
    const assistantMentionReferences = useMemo(() => buildCanvasAgentMentionReferences(nodes), [nodes]);
    // 扩展节点（对比/图表/调色）要读自己的上游才能渲染，经 Context 下发；
    // 取上游复用 canvas-resource-references 的实现，别在这里另写一份。必须 memo——
    // 每帧新对象会让所有节点跟着重渲染，错题本里多条崩溃都出在画布高频更新。
    const nodeGraphContext = useMemo<CanvasNodeGraphContextValue>(() => ({ getUpstreamNodes: (nodeId: string) => getContextResourceNodes(nodeId, nodes, connections), getNode: (nodeId: string) => nodes.find(node => node.id === nodeId) }), [connections, nodes]);

    // 旧内置 Agent 的深链参数（?agent=1 / ?conversation=）仍然存在于历史书签里。
    // 画布不再有 Agent 停靠面板，这里只把参数剥离，让旧链接落到正常可用的画布，
    // 画布会话数据本身保留在项目记录中。
    useEffect(() => {
        if (!projectLoaded) return;
        if (!searchParams.has("agent") && !searchParams.has("conversation")) return;
        const next = new URLSearchParams(searchParams);
        next.delete("agent");
        next.delete("conversation");
        setSearchParams(next, { replace: true });
    }, [projectLoaded, searchParams, setSearchParams]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useLayoutEffect(() => {
        selectedNodeIdsRef.current = selectedNodeIds;
    }, [selectedNodeIds]);

    // 停靠栏挤压画布时补偿一半位移：用户正在看的那块内容留在原处，视野不跳。
    const dockedPanelWidth = !assistantDockable ? 0 : rightPanel === "assistant" ? assistant.width : workflowLibraryOpen && !focusMode && !versions.preview ? 380 : 0;
    useCanvasDockedViewport(dockedPanelWidth, viewportState);

    const {
        fitCanvasContent,
        fitCanvasSelection,
        focusCanvasImageNode,
        focusCanvasNode,
        getCanvasCenter,
        handleCanvasDoubleClick,
        handleViewportChange,
        handleViewportPreviewChange,
        previewViewport,
        screenToCanvas,
        setZoomScale,
        zoomCanvasIn,
        zoomCanvasOut,
        zoomToActualSize,
    } = useCanvasViewportController({
        pageUi,
        projectId,
        containerRef,
        size,
        viewport,
        viewportRef,
        nodesRef,
        selectedNodeIdsRef,
        setViewport,
        setVirtualizationViewport,
        virtualizationPausedRef: lodActiveRef,
        lodEnterScaleRef,
    });

    const workflowInstances = useCanvasWorkflowInstances({
        canvasId: projectId, domainProjectId: currentProject?.projectId, readOnly, nodes, nodesRef, setNodes, connectionsRef, setConnections, getCanvasCenter,
        persist: () => saveCanvasProject({ requireRemote: false }),
        focusNode: (node) => {
            const k = Math.min(1, (size.width - 96) / node.width, (size.height - 160) / node.height);
            const next = { x: size.width / 2 - (node.position.x + node.width / 2) * k, y: size.height / 2 - (node.position.y + node.height / 2) * k, k };
            viewportRef.current = next;
            setViewport(next);
            setSelectedNodeIds(new Set([node.id]));
            setDialogNodeId(null);
            setToolbarNodeId(null);
            setShowConnections(true);
        },
        onError: (error) => { void message.error(error); },
    });

    // Pan only the viewport (never the node) when a newly connected target
    // crosses the visible canvas safe area, including under the Agent dock.
    const keepConnectedNodeVisible = useCanvasConnectedNodeVisibility({
        size,
        containerRef,
        viewportRef,
        nodesRef,
        connectionsRef,
        setViewport,
    });

    const generation = useCanvasGenerationOrchestration({
        pageUi,
        projectId,
        linkedProjectId,
        domainProjectId: currentProject?.projectId,
        projectLoaded,
        localOnly,
        addedSkills,
        assets,
        nodes,
        connections,
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        setGenerationHistoryOpen,
        getCanvasCenter,
    });
    const {
        applyGenerationTaskResult,
        bindGenerationTask,
        finishGenerationRequest,
        openNodeTaskDetails,
        setRunningNodeId,
        startGenerationRequest,
        handleGenerateNode,
        handleRetryNode,
        cancelCanvasTask,
        generateScriptRows,
        reconcileImageBatchRootNode,
        retryImageBatchChildren,
        generateImageFromTextNode,
    } = generation;

    const assistantContinuation = useCanvasAssistantContinuation(assistant, !readOnly);
    const { runAssistantProposal, assistantProposalFeedback, runningProposalIds } = useCanvasAssistantProposal({
        projectId,
        addedSkills,
        nodesRef,
        connectionsRef,
        handledProposals: assistant.handledProposals,
        markProposalHandled: assistant.markProposalHandled,
        continuationSessionId: assistant.sessionId,
        continuePlan: Boolean(assistant.plan?.items.some(item => item.status !== "done")),
        onContinuationArmed: assistantContinuation.refresh,
        handleGenerateNode,
    });

    const uploads = useCanvasUpload({
        pageUi,
        canvasId: projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        screenToCanvas,
        setNodes,
        setConnections,
    });
    const {
        assetPickerOpen,
        uploadModalOpen,
        closeUploadModal,
        handleImportUrl,
        closeAssetPicker,
        createVideoNodeFromBlob,
        createAssetPayloadNodes,
        fileDropActive,
        handleAssetsInsert,
        handleDrop,
        handleFileDragEnter,
        handleFileDragLeave,
        handleFileDragOver,
        handleImageInputChange,
        handleProjectAssetsInsert,
        handleProjectChapterInsert,
        handleUploadFiles,
        handleUploadRequest,
        imageInputRef,
        openAssetsAtPosition,
        pasteSystemClipboard,
        startUploadStatus,
        uploadTimelineMedia,
    } = uploads;
    const replaceCanvasNodeMedia = useCallback((node: CanvasNodeData) => handleUploadRequest(node.id), [handleUploadRequest]);
    const { linkedProjectQuery, refetchLinkedProject, archiveNodesToLinkedFolder, reloadCanvasNodeResource } = useCanvasResourceHandoff({
        projectId,
        linkedProjectId,
        projectLoaded,
        assets,
        assetsHydrated,
        nodesRef,
        searchParams,
        setSearchParams,
        setNodes,
        getCanvasCenter,
        createHandoffNodes: createAssetPayloadNodes,
        applyGenerationTaskResult,
        startGenerationRequest,
        finishGenerationRequest,
    });
    const canvasContext = useMemo(() => summarizeCanvasContext(nodes, selectedNodeIds, linkedProjectQuery.data?.units), [linkedProjectQuery.data?.units, nodes, selectedNodeIds]);
    const {
        timelineAddNodeRef,
        timelineMediaAddRef,
        assetInsertScope,
        projectAssetScope,
        projectAssetOpen,
        projectAssetInitialCategory,
        projectAssetInitialFolderId,
        projectAssetInsertPosition,
        handleLibraryAssetsInsert,
        handleTimelineProjectAssetsInsert,
        openProjectAssets,
        openCanvasAssetLibrary,
        openTimelineAssetLibrary,
        closeProjectAssets,
    } = useCanvasTimelineAssetInsert({
        linkedProjectId,
        refetchLinkedProject,
        handleAssetsInsert,
        handleProjectAssetsInsert,
        openAssetsAtPosition,
    });

    const mediaTools = useCanvasMediaTools({
        pageUi,
        projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        setNodes,
        setConnections,
        setRunningNodeId,
        startUploadStatus,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
    });
    const {
        prepareUpscaleResource,
        recoverAIUpscale,
        observeAIUpscale,
        angleNodeId,
        lightingNodeId,
        emotionNodeId,
        annotationNodeId,
        createImageReversePromptNodes,
        openPortraitTextureEditor,
        cropImageNode,
        cropNodeId,
        cropVideoNode,
        depthCaptureNode,
        retryDepthCaptureNode,
        recoverDepthCaptureNodes,
        videoCropNodeId,
        extractAudioFromVideo,
        extractVideoFrameAt,
        extractingVideoFramesNodeId,
        frameDialogNodeId,
        generateAngleNode,
        generateLightingNode,
        openPanoramaConfig,
        addPanoramaCaptureNode,
        generateEmotionNode,
        maskEditImageNode,
        maskEditNodeId,
        mergeSelectedVideos,
        mergeVideoProgress,
        saveAnnotatedImageNode,
        segmentRunningMode,
        inlineTrimNodeId,
        inlineTrimRunning,
        openInlineVideoTrim,
        openVideoCrop,
        closeInlineVideoTrim,
        confirmInlineVideoTrim,
        setFrameDialogNodeId,
        setAngleNodeId,
        setLightingNodeId,
        setEmotionNodeId,
        setAnnotationNodeId,
        setCropNodeId,
        setVideoCropNodeId,
        setMaskEditNodeId,
        setUpscaleNodeId,
        splitImageNode,
        upscaleNodeId,
        clearDeletedNodes: clearDeletedMediaToolNodes,
    } = mediaTools;

    const bindUpscaleTask = useCallback((task: GenerationTask, nodeId: string) => bindGenerationTask(nodeId, task), [bindGenerationTask]);
    const { startUpscaleBatch } = useCanvasUpscaleBatch({
        pageUi,
        projectId, nodesRef, connectionsRef, setNodes, setConnections,
        prepareResource: prepareUpscaleResource, observeTask: observeAIUpscale, bindTask: bindUpscaleTask,
    });
    const createUpscaleProcessingNode = useCallback((source: CanvasNodeData) => {
        if (!source.metadata?.content && !source.metadata?.storageKey) {
            if (source.metadata?.workflowOperation?.id.endsWith(".ai-upscale")) void recoverAIUpscale(source).catch(error => message.error(generationErrorMessage(error)));
            else message.warning("请先选择可读取的图片或视频");
            return;
        }
        const plan = planUpscaleProcessingNode(nodesRef.current, connectionsRef.current, source, selectedNodeIdsRef.current);
        connectionsRef.current = plan.connections;
        setConnections(plan.connections);
        setNodes(current => [...current, plan.processor]);
        setSelectedNodeIds(new Set([plan.processor.id]));
        setDialogNodeId(null);
        setToolbarNodeId(null);
    }, [message, recoverAIUpscale, setConnections, setNodes]);

    useEffect(() => {
        if (!projectLoaded) return;
        const controller = new AbortController();
        recoverDepthCaptureNodes(controller.signal);
        return () => controller.abort();
    }, [projectId, projectLoaded, recoverDepthCaptureNodes]);

    const handleNodesDeleted = useCallback(
        (removedIds: Set<string>, nextNodes: CanvasNodeData[], removedNodes: CanvasNodeData[]) => {
            const clearDeletedId = (current: string | null) => (current && removedIds.has(current) ? null : current);
            clearDeletedNodeIds(removedIds);
            clearDeletedMediaToolNodes(removedIds);
            setRunningNodeId(clearDeletedId);
            cleanupCanvasFiles({ projectId, nodes: nextNodes, chatSessions: chatSessionsRef.current });
        },
        [
            cleanupCanvasFiles,
            clearDeletedMediaToolNodes,
            clearDeletedNodeIds,
            message,
            projectId,
            setRunningNodeId,
        ],
    );

    const {
        alignSelectedNodes,
        autoArrangeCanvasNodes,
        arrangeSelectedNodes,
        spreadSelectedNodes,
        copyNodesToClipboard,
        copySelectedNodes,
        createFolder,
        createNode,
        createGenerationReplacement,
        createReferenceGroup,
        createStoryboardGroup,
        deleteConnection,
        deleteNodes,
        duplicateNode,
        hasCopiedNodes,
        pasteCopiedNodes,
        restoreCopiedNodesFromText,
        releaseCopiedNodesPastePriority,
        setPrimaryVersion,
        shouldPreferCopiedNodes,
        toggleNodeLocked,
    } = useCanvasNodeOperations({
        pageUi,
        projectId,
        viewportScale: viewport.k,
        defaultDrawingEngine,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        onNodesDeleted: handleNodesDeleted,
    });

    const referenceActions = useCanvasNodeReferences({ projectId, document, pageUi, uploads });
    const { handleReplaceNodeReference } = referenceActions;

    const connectionController = useCanvasConnectionController({
        pageUi,
        projectId,
        config: effectiveConfig,
        defaultDrawingEngine,
        nodesRef,
        connectionsRef,
        viewportRef,
        scriptScrollTopById,
        screenToCanvas,
        setNodes,
        setConnections,
        setDrawingNodeId,
        onConnectedNodeCreated: keepConnectedNodeVisible,
        onReplaceReference: handleReplaceNodeReference,
    });
    const {
        cancelPendingConnectionCreate,
        closeConnectionCreateMenu,
        connectionTargetAnchorRatio,
        connectionTargetNodeId,
        connectionApproach,
        connectionReplaceHover,
        connectingParams,
        createConnectedNode,
        getConnectionCreateDisabledReason,
        handleConnectStart,
        handleBatchConnectionTargetClick,
        batchConnectionPreview,
        beginBatchConnectionMode,
        startBatchConnection,
        mouseWorld,
        pendingConnectionCreate,
    } = connectionController;

    const batchSourceNodeIds = useMemo(() => nodes.filter((node) => selectedNodeIds.has(node.id) && !batchSourceRestriction(node)).map((node) => node.id), [nodes, selectedNodeIds]);

    const {
        handleCanvasSelectionStart,
        handleNodeInteractionStart,
        handleNodeDragEnd,
        handleCanvasDeselect,
    } = useCanvasPointerSelectionChrome({
        pageUi,
        projectId,
        nodesRef,
        segmentRunningMode,
    });

    const { handleSelectedNodeClick, handleNodeBringToFront } = useCanvasNodeClick({
        pageUi,
        projectId,
        nodesRef,
        segmentRunningMode,
        bringNodeToFront,
        setDrawingNodeId,
        setArtCritiqueNodeId,
    });

    const { alignmentGuides, cancelSelectionBox, deselectCanvas, dragPreview, frameDropTargetId, nodeDropTargetId, handleCanvasMouseDown, handleNodeMouseDown, isNodeDragging, nodeDraggingRef, selectionBoundsElementRef, selectionBox } = useCanvasSelectionController({
        pageUi,
        projectId,
        containerRef,
        nodesRef,
        viewportRef,
        selectedNodeIdsRef,
        historyPausedRef,
        screenToCanvas,
        setNodes,
        cancelPendingConnectionCreate,
        onCanvasSelectionStart: handleCanvasSelectionStart,
        onNodeInteractionStart: handleNodeInteractionStart,
        onNodeBringToFront: handleNodeBringToFront,
        onNodeClick: handleSelectedNodeClick,
        onNodeDragEnd: handleNodeDragEnd,
        onBatchConnectionTarget: handleBatchConnectionTargetClick,
        onLinkedFolderDrop: archiveNodesToLinkedFolder,
        onNodeDrop: workflowInstances.drop,
        onNodeDropTarget: (ids, point) => {
            const source = ids.length === 1 ? nodesRef.current.find(node => node.id === ids[0]) : undefined;
            return source ? workflowDropSlot(nodesRef.current, source, point)?.id : undefined;
        },
        onDeselect: handleCanvasDeselect,
        snapToGrid,
    });

    const {
        keepNodeToolbar,
        hideNodeToolbar,
        handleCanvasNodeHoverStart,
        handleCanvasNodeHoverEnd,
    } = useCanvasNodeToolbarHover({
        pageUi,
        projectId,
        nodeDraggingRef,
        nodeImageSettingsOpen,
    });

    const nodeEditor = useCanvasNodeEditor({
        pageUi,
        canvasId: projectId,
        canvasTitle: currentProject?.title || "未命名画布",
        domainProjectId: linkedProjectId,
        nodesRef,
        setNodes,
        openProjectAssets,
    });
    const {
        collapsingBatchIds,
        downloadNodeImage,
        handleConfigNodeChange,
        handleFolderStyleChange,
        handleFolderThemeChange,
        handleFontSizeChange,
        handleNodeContentChange,
        handleNodeResize,
        handleNodeTitleChange,
        openingBatchIds,
        saveNodeAsset,
        setBatchPrimary,
        toggleBatchExpanded,
        toggleFrameCollapsed,
        handleFrameToggle,
        toggleNodeFreeResize,
    } = nodeEditor;

    const handleProjectFolderInsert = useCallback(
        (folderId: string) => {
            const folder = linkedProjectQuery.data?.assetFolders.find((item) => item.id === folderId);
            if (!folder || !linkedProjectId) throw new Error("素材文件夹已不存在，请刷新后重试");
            const { style, theme } = linkedFolderPresentation(folder);
            createFolder(projectAssetInsertPosition, { id: folder.id, projectId: linkedProjectId, title: folder.name, style, theme, createdAt: folder.createdAt });
        },
        [createFolder, linkedProjectId, linkedProjectQuery.data?.assetFolders, projectAssetInsertPosition],
    );

    const linkedFolderPreviewNodesById = useMemo(() => buildLinkedFolderPreviewNodes(assets, linkedProjectQuery.data?.assets || []), [assets, linkedProjectQuery.data?.assets]);

    const singleSelectedNodeId = selectedNodeIds.size === 1 ? selectedNodeIds.values().next().value ?? null : null;
    // Nodes that need live controls stay as DOM cards above the overview canvas.
    const lodPinnedNodeIds = useMemo(() => new Set([
        lodHoverNodeId, hoveredNodeId, singleSelectedNodeId, activeMediaNodeId, dialogNodeId,
        cropNodeId, videoCropNodeId, annotationNodeId, maskEditNodeId,
        connectionTargetNodeId, connectingParams?.nodeId,
    ].filter((nodeId): nodeId is string => Boolean(nodeId))), [activeMediaNodeId, annotationNodeId, connectingParams?.nodeId, connectionTargetNodeId, cropNodeId, dialogNodeId, hoveredNodeId, lodHoverNodeId, maskEditNodeId, singleSelectedNodeId, videoCropNodeId]);

    const renderModel = useCanvasRenderModel({
        nodes,
        connections,
        assets,
        viewport: virtualizationViewport ?? viewport,
        viewportSize: size,
        mediaPerformanceMode,
        selectedNodeIds,
        hoveredNodeId,
        dragPreview,
        collapsingBatchIds,
        addedSkills,
        directorScenes: currentProject?.directorScenes,
        infoNodeId,
        maskEditNodeId,
        annotationNodeId,
        splitNodeId: null,
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
        lodPinnedNodeIds,
        viewportInteracting: Boolean(virtualizationViewport),
    });
    const {
        activeNodeId, angleNode, lightingNode, emotionNode, batchChildCountById, batchMotionById,
        canvasImageNodes, contextMenuNode, displayConnections, frameChildrenById, lodActive, lodEnterScale,
        lodNodes, maskEditNode, mentionReferencesByNodeId, nodeById, reduceMediaEffects, relatedHighlight,
        resourceReferenceByNodeId, selectedNodeBounds, selectedVideoNodes, toolbarNode, visibleNodes,
    } = renderModel;
    lodActiveRef.current = lodActive;
    lodEnterScaleRef.current = lodEnterScale;
    const renderedConnections = showConnections ? displayConnections : [];
    const dialogNodeCandidate = dialogNodeId ? nodeById.get(dialogNodeId) || null : null;
    const dialogNode = canOpenCanvasNodePromptPanel(dialogNodeCandidate) ? dialogNodeCandidate : null;
    // dragPreview is published on the same pointer-down frame as isNodeDragging.
    // Treat either signal as moving so floating editors disappear before the
    // first preview transform is painted and never affect drag layout.
    const isCanvasNodeMoving = isNodeDragging || Boolean(dragPreview?.nodeIds.size);
    const inlineTrimNode = inlineTrimNodeId ? nodeById.get(inlineTrimNodeId) || null : null;
    const pendingConnectionSourceNode = pendingConnectionCreate?.connection.handleType === "source" ? nodeById.get(pendingConnectionCreate.connection.nodeId) : null;
    const canCreateDrawingFromConnection = !pendingConnectionCreate?.batchSourceNodeIds?.length && pendingConnectionSourceNode?.type === CanvasNodeType.Image && Boolean(pendingConnectionSourceNode.metadata?.content);

    const duplicateNodeFromContent = useCallback((node: CanvasNodeData) => duplicateNode(node.id), [duplicateNode]);
    const deleteNodeFromContent = useCallback((node: CanvasNodeData) => deleteNodes(new Set([node.id])), [deleteNodes]);
    const { updateNodeFromContent, updateMediaNodeFromContent, updateNodeMetadataFromContent } = document;
    const canvasNodeActions = useMemo<CanvasNodeActionContextValue>(
        () => ({
            upload: replaceCanvasNodeMedia,
            download: downloadNodeImage,
            duplicate: duplicateNodeFromContent,
            deleteNode: deleteNodeFromContent,
            updateMetadata: updateNodeMetadataFromContent,
            updateNode: updateNodeFromContent,
            updateMediaNode: updateMediaNodeFromContent,
            openArtCritique,
            addPanoramaCaptureNode,
            startUpscaleBatch,
            recoverUpscaleResult: recoverAIUpscale,
        }),
        [addPanoramaCaptureNode, deleteNodeFromContent, downloadNodeImage, duplicateNodeFromContent, openArtCritique, replaceCanvasNodeMedia, updateMediaNodeFromContent, updateNodeFromContent, updateNodeMetadataFromContent, startUpscaleBatch, recoverAIUpscale],
    );
    const styles = useCanvasStyleWorkflow({
        pageUi,
        canvasId: projectId,
        domainProjectId: currentProject?.projectId,
        nodesRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setStylePickerOpen,
    });

    const director = useCanvasDirector({
        pageUi,
        projectId,
        domainProjectId: currentProject?.projectId,
        directorNodeId,
        directorScenes: currentProject?.directorScenes || [],
        nodesRef,
        connectionsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setDirectorNodeId,
        updateProject,
    });
    const { addDirectorReferenceToCanvas, createDirectorShot, openDirectorWorkbench } = director;

    useCanvasStarterNavigation({ projectLoaded, searchParams, setSearchParams, containerRef, nodesRef,
        createNode, fitCanvasSelection, createDirectorShot, openAssistant });

    const {
        activateStep: activateShortDramaStep,
        createPipeline: createShortDramaPipeline,
        guideCollapsed: shortDramaGuideCollapsed,
        openStoryInput,
        progress: shortDramaProgress,
        setGuideCollapsed: setShortDramaGuideCollapsed,
        skipGuide: skipShortDramaGuide,
    } = useCanvasShortDrama({
        pageUi,
        projectId,
        nodes,
        connections,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setStylePickerOpen,
        fitCanvasSelection,
        focusCanvasNode,
        openTextEditor: openTextNodeEditor,
    });

    const shortDramaGuide = shortDramaEnabled && !currentProject?.projectId && shortDramaProgress.active ? { progress: shortDramaProgress, collapsed: shortDramaGuideCollapsed, onToggle: () => setShortDramaGuideCollapsed((value) => !value) } : undefined;

    const clearCanvas = useCallback(() => {
        const drawingIds = nodesRef.current.flatMap((node) => (node.type === CanvasNodeType.Drawing && node.metadata?.drawingId ? [node.metadata.drawingId] : []));
        if (drawingIds.length) {
            void Promise.all(drawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId))).catch(() => message.warning("画布已清空，但部分本地绘图缓存清理失败"));
        }
        setNodes([]);
        setConnections([]);
        resetForClearCanvas();
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAnnotationNodeId(null);
        setAngleNodeId(null);
        setLightingNodeId(null);
        setEmotionNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        clearCanvasFiles();
    }, [clearCanvasFiles, deselectCanvas, message, nodesRef, projectId, resetForClearCanvas, setEmotionNodeId]);

    useCanvasKeyboard({
        pageUi,
        projectId,
        enabled: projectLoaded && !versions.preview && !directorNodeId,
        onToggleAssistant: focusMode ? undefined : toggleAssistant,
        nodesRef,
        selectedNodeIdsRef,
        selectedConnectionId,
        setShortcutRequestNonce,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setAnnotationNodeId,
        saveCanvasProject,
        zoomToActualSize,
        fitCanvasContent,
        fitCanvasSelection,
        undoCanvas,
        redoCanvas,
        cancelSelectionBox,
        copySelectedNodes,
        pasteCopiedNodes,
        restoreCopiedNodesFromText,
        shouldPreferCopiedNodes,
        pasteSystemClipboard,
        deleteNodes,
        deleteConnection,
        deselectCanvas,
        zoomCanvasIn,
        zoomCanvasOut,
        autoArrangeCanvasNodes,
        focusMode,
        exitFocusMode,
        toggleFocusMode,
        onOpenSearch: () => setNodeSearchOpen(true),
        beginBatchConnection: () => beginBatchConnectionMode(Array.from(selectedNodeIdsRef.current)),
    });
    const pasteAtPosition = useCallback(
        (position: Position) => {
            pasteCanvasAtPosition(position, {
                shouldPreferCopiedNodes,
                pasteCopiedNodes,
                pasteSystemClipboard,
                warn: (content) => message.warning(content),
            });
        },
        [message, pasteCopiedNodes, pasteSystemClipboard, shouldPreferCopiedNodes],
    );

    const {
        copyNodeContentToClipboard,
        copyNodeMediaUrlToClipboard,
        confirmUploadNodeImageToArkPrivateAsset,
    } = useCanvasNodeMediaShareActions({
        projectId,
        domainProjectId: currentProject?.projectId,
        localOnly,
        releaseCopiedNodesPastePriority,
        handleConfigNodeChange,
    });

    const {
        handleCanvasContextMenu,
        handleNodeContextMenu,
        handleConnectionSelect,
        handleConnectionContextMenu,
    } = useCanvasContextMenu({
        pageUi,
        projectId,
        selectedNodeIdsRef,
        screenToCanvas,
        closeConnectionCreateMenu,
    });

    const renderModelRef = useRef(renderModel);
    renderModelRef.current = renderModel;
    const cancelImageCrop = useCallback(() => setCropNodeId(null), [setCropNodeId]);
    const cancelAnnotation = useCallback(() => setAnnotationNodeId(null), [setAnnotationNodeId]);
    const cancelMaskEdit = useCallback(() => setMaskEditNodeId(null), [setMaskEditNodeId]);
    const cancelVideoCrop = useCallback(() => setVideoCropNodeId(null), [setVideoCropNodeId]);

    const renderCanvasNodePanel = useCallback((node: CanvasNodeData) => (
        <CanvasProjectNodePrompt node={node} projectId={projectId} videoModel={config.videoModel}
            document={document} dialogs={dialogs} renderModel={renderModelRef.current} generation={generation}
            nodeEditor={nodeEditor} pageUi={pageUi} referenceActions={referenceActions}
            onFocusNode={focusCanvasNode} onCreateReplacement={createGenerationReplacement}
            onNodeMouseDown={handleNodeMouseDown} />
    ), [projectId, config.videoModel, document, dialogs, generation, nodeEditor, pageUi,
        referenceActions, focusCanvasNode, createGenerationReplacement, handleNodeMouseDown]);

    const renderCanvasNodeContent = useCallback((node: CanvasNodeData) => (
        <CanvasProjectNodeContent node={node} projectId={projectId} readOnly={readOnly}
            theme={theme} viewportScale={viewport.k} document={document} dialogs={dialogs}
            renderModel={renderModelRef.current} generation={generation} nodeEditor={nodeEditor}
            mediaTools={mediaTools} connectionController={connectionController} uploads={uploads}
            workflowInstances={workflowInstances} pageUi={pageUi} nodeDropTargetId={nodeDropTargetId}
            directorScenes={currentProject?.directorScenes} onFocusImage={focusCanvasImageNode}
            onOpenDirector={openDirectorWorkbench} onOpenStory={openStoryInput} onNodeMouseDown={handleNodeMouseDown}
        />
    ), [projectId, readOnly, theme, viewport.k, document, dialogs, renderModel.configInputsById, generation, nodeEditor,
        mediaTools, connectionController, uploads, workflowInstances, pageUi, nodeDropTargetId,
        currentProject?.directorScenes, focusCanvasImageNode, openDirectorWorkbench, openStoryInput, handleNodeMouseDown]);

    const retryCanvasNode = useCallback(
        (node: CanvasNodeData) => {
            if (node.metadata?.workflowOperation?.id.endsWith(".ai-upscale")) {
                const processor = nodesRef.current.find(item => item.id === node.metadata?.generatedFromProcessingNodeId);
                if (node.metadata.taskId) void recoverAIUpscale(node).catch(error => message.error(generationErrorMessage(error)));
                else if (processor) void startUpscaleBatch(processor).catch(error => message.error(generationErrorMessage(error)));
                else message.info("请在超分处理节点中查询原批次，暂勿重复提交");
                return;
            }
            const plan = canvasNodeRetryPlan(node, nodesRef.current);
            if (plan.kind === "history") {
                setGenerationHistoryOpen(true);
                return;
            }
            if (plan.kind === "depth") {
                void retryDepthCaptureNode(node);
                return;
            }
            if (plan.kind === "script-empty") {
                message.warning("分镜脚本缺少剧情内容，无法重试");
                return;
            }
            if (plan.kind === "script") {
                void generateScriptRows(node.id, plan.prompt);
                return;
            }
            if (plan.kind === "image-batch-empty") {
                message.info("当前批次没有需要重试的失败图片");
                return;
            }
            if (plan.kind === "image-batch-root") {
                message.info(`正在重试 ${plan.children.length} 个失败图片`);
                retryImageBatchChildren(node.id, plan.children);
                return;
            }
            if (plan.kind === "image-batch-child") {
                void handleRetryNode(node).finally(() => reconcileImageBatchRootNode(plan.rootId));
                return;
            }
            void handleRetryNode(node);
        },
        [generateScriptRows, handleRetryNode, message, nodesRef, reconcileImageBatchRootNode, retryDepthCaptureNode, retryImageBatchChildren, setGenerationHistoryOpen, recoverAIUpscale, startUpscaleBatch],
    );

    // 改动卡片的「在画布上查看」：选中这些节点并把视野带过去，再点亮一下。
    const locateAssistantNodes = useCallback(
        (nodeIds: string[]) => {
            const available = new Set(nodesRef.current.map((node) => node.id));
            const targets = nodeIds.filter((id) => available.has(id));
            if (!targets.length) {
                message.info("这些节点已经不在画布上了");
                return;
            }
            const selection = new Set(targets);
            selectedNodeIdsRef.current = selection;
            setSelectedNodeIds(selection);
            setSelectedConnectionId(null);
            fitCanvasSelection();
            highlightAssistantNodes(containerRef.current, targets);
        },
        [fitCanvasSelection, message, nodesRef, selectedNodeIdsRef, setSelectedConnectionId, setSelectedNodeIds],
    );

    const activeTasksRef = useRef(activeTasks);
    activeTasksRef.current = activeTasks;
    const handleCancelNodeTask = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId) { const c = startGenerationRequest(node.id, node.id); c.abort(); finishGenerationRequest(node.id, c); setRunningNodeId((id) => (id === node.id ? null : id)); setNodes((list) => list.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content || item.metadata?.storageKey ? "success" : "idle", taskStage: undefined } } : item))); return; }
            try {
                const task = activeTasksRef.current.find((item) => item.id === taskId) ?? (await queryGenerationTask(taskId));
                cancelCanvasTask(task);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "读取任务失败");
            }
        },
        [cancelCanvasTask, finishGenerationRequest, message, setNodes, setRunningNodeId, startGenerationRequest],
    );
    const openCanvasNodeVersions = useCallback((node: CanvasNodeData) => setVersionCompareRootId(node.metadata?.versionOfNodeId || node.id), []);
    const viewCanvasNodeImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), []);
    // Overview nodes reuse the DOM card handlers; native events carry the
    // fields those handlers read (button, modifiers, client coordinates).
    const handleLodNodePointerDown = useCallback((event: PointerEvent, nodeId: string) => {
        handleNodeMouseDown(event as unknown as ReactMouseEvent, nodeId);
    }, [handleNodeMouseDown]);
    const handleLodNodeContextMenu = useCallback((event: MouseEvent, nodeId: string) => {
        handleNodeContextMenu(event as unknown as ReactMouseEvent, nodeId);
    }, [handleNodeContextMenu]);
    const handleLodNodeDoubleClick = useCallback((node: CanvasNodeData) => {
        if (node.type === CanvasNodeType.Image && node.metadata?.content) viewCanvasNodeImage(node);
    }, [viewCanvasNodeImage]);
    const locateProjectStyleNode = useCallback(() => {
        const styleNode = nodesRef.current.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "styleboard");
        if (!styleNode) {
            message.info("项目画风节点正在同步，请稍后再试");
            return;
        }
        focusCanvasNode(styleNode.id);
    }, [focusCanvasNode, message, nodesRef]);
    const openFrameAnalysisOrCreate = useCallback(() => {
        const selectedVideo = nodesRef.current.find((node) => selectedNodeIds.has(node.id) && node.type === CanvasNodeType.Video);
        if (selectedVideo) {
            setFrameDialogNodeId(selectedVideo.id);
            return;
        }
        message.info("请先选中一个视频节点，再打开逐帧拉片");
    }, [message, nodesRef, selectedNodeIds, setFrameDialogNodeId]);
    const freeformCreateCommands = useCanvasCreateCommands({
        workspaceMode,
        isProjectLinked: Boolean(shortDramaEnabled && currentProject?.projectId),
        handlers: {
            onAddText: () => createNode(CanvasNodeType.Text),
            onAddImage: () => createNode(CanvasNodeType.Image),
            onAddVideo: () => createNode(CanvasNodeType.Video),
            onAddAudio: () => createNode(CanvasNodeType.Audio),
            onAddScript: () => createNode(CanvasNodeType.Script),
            onAddFrame: openFrameAnalysisOrCreate,
            onAddFolder: createFolder,
            onAddDrawing: () => createNode(CanvasNodeType.Drawing),
            onAddWorkflow: () => createNode(CanvasNodeType.Config),
            onAddExtensionNode: (type) => createNode(type),
            onChooseStyle: () => setStylePickerOpen(true),
            onOpenDirector: () => createDirectorShot(),
            onUpload: () => handleUploadRequest(),
            onOpenMyAssets: () => openCanvasAssetLibrary(),
            onOpenProjectCharacters: () => openProjectAssets("character"),
            onOpenGenerationHistory: () => setGenerationHistoryOpen(true),
        },
    });
    const emptyStateKind = resolveCanvasEmptyStateKind({
        nodeCount: nodes.length,
        shortDramaEnabled,
        isProjectLinked: Boolean(currentProject?.projectId),
        starterMode: currentProject?.starterMode,
    });
    const emptyCanvasState =
        emptyStateKind === "freeform" ? (
            <CanvasFreeformEmptyState commands={freeformCreateCommands} onOpenAssistant={openAssistant} />
        ) : emptyStateKind === "linked" ? (
            <CanvasLinkedProjectEmptyState
                projectName={linkedProjectQuery.data?.project.name || workspaceProject?.title || "项目画布"}
                hasChapter={Boolean(linkedProjectQuery.data?.units.length)}
                onAddFirstChapter={() => {
                    const first = linkedProjectQuery.data?.units.slice().sort((left, right) => left.position - right.position)[0];
                    if (first) void handleProjectChapterInsert({ id: first.id, projectId: linkedProjectId, title: first.title, position: first.position });
                }}
                onOpenAssets={() => openProjectAssets()}
                onAddText={() => createNode(CanvasNodeType.Text)}
            />
        ) : emptyStateKind === "guided" ? (
            <CanvasShortDramaEmptyState
                onCreatePipeline={createShortDramaPipeline}
                onStartFreeform={() => updateProject(projectId, { starterMode: "freeform" })}
                onUpload={() => handleUploadRequest()}
                onAddText={() => createNode(CanvasNodeType.Text)}
                onAddScript={() => createNode(CanvasNodeType.Script)}
            />
        ) : null;
    if (!projectLoaded && loadError)
        return (
            <main className="flex h-full flex-col items-center justify-center gap-4">
                <p role="alert">{loadError}</p>
                <Button onClick={retryLoad}>重新加载</Button>
                <Link to="/canvas">返回画布库</Link>
            </main>
        );
    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <>
            {projectMenu.deletingCanvas ? <CanvasDeleteConfirmation title="删除画布？"
                description={`将删除「${projectMenu.deletingCanvasTitle}」，里面的节点和连线也会一起移除。`}
                onCancel={projectMenu.cancelDeleteCanvas} onConfirm={projectMenu.confirmDeleteCanvas} /> : null}
            <a
                href="#canvas-main"
                onClick={(event) => {
                    event.preventDefault();
                    canvasMainRef.current?.focus();
                }}
                className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--z-toast)] focus:rounded-md focus:border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
            >
                跳转到画布主内容
            </a>
            <main ref={canvasMainRef} id="canvas-main" data-canvas-readonly={readOnly ? "true" : "false"} data-libtv-readonly-dense={searchParams.get("fixture") === "libtv-readonly-dense" ? "true" : "false"} tabIndex={-1} className="flex h-full min-h-0 overflow-hidden outline-none" style={{ background: resolvedCanvasAppearance.background, color: theme.node.text }}>
                {!focusMode && !versions.preview && shortDramaEnabled && currentProject?.projectId ? (
                    <CanvasProjectSidebar projectId={currentProject.projectId} detail={linkedProjectQuery.data} onAddChapter={handleProjectChapterInsert} onLocateStyle={locateProjectStyleNode} onOpenAssets={() => openProjectAssets()} />
                ) : null}
                <CanvasOverlayLayerProvider>
                    <div className="canvas-editor-shell relative flex min-w-0 flex-1" data-canvas-editor-panel-open={dialogNode || textEditorNodeId ? "true" : "false"} data-canvas-toolbar-node={toolbarNode?.id || undefined}>
                    <section data-canvas-editor inert={Boolean(versions.preview)} style={{ visibility: versions.preview ? "hidden" : undefined, opacity: versions.preview ? 0 : undefined }} className="relative min-w-0 flex-1 flex flex-col min-h-0 overflow-hidden">
                        {!focusMode ? (
                            <CanvasTopBar
                                workspaceView={workspaceView}
                                onWorkspaceViewChange={(view) => {
                                    if (view === "storyboard") {
                                        const script = nodesRef.current.find((node) => node.type === CanvasNodeType.Script);
                                        if (script) {
                                            setWorkspaceView(view);
                                            setScriptEditorNodeId(script.id);
                                            focusCanvasNode(script.id);
                                        } else {
                                            message.info("当前画布还没有脚本节点，请先从添加节点中创建脚本");
                                        }
                                    } else {
                                        setWorkspaceView(view);
                                        setScriptEditorNodeId(null);
                                    }
                                }}
                                syncStatus={<CanvasSyncStatus projectId={projectId} onLoadLatest={reloadLatestCanvasProject} onOpenVersions={openVersions} />}
                                readOnly={readOnly}
                                onDuplicateProject={projectMenu.duplicateCurrentProject}
                                versionsOpen={versions.open}
                                onToggleVersions={toggleVersions}
                                onOpenWorkflows={readOnly ? undefined : () => workflowsRef.current?.toggleLibrary()}
                                workflowsOpen={workflowLibraryOpen}
                                assistantOpen={rightPanel === "assistant"}
                                onToggleAssistant={toggleAssistant}
                                // LibTV 的画布工作区使用“未命名工作区”作为首屏默认标题；
                                // 项目库仍保留“未命名项目”，因此只在画布顶栏做显示层映射。
                                title={workspaceProject?.title === "未命名项目" || !workspaceProject?.title ? "未命名工作区" : workspaceProject.title}
                                titleDraft={projectMenu.titleDraft}
                                isTitleEditing={projectMenu.titleEditing}
                                onTitleDraftChange={projectMenu.setTitleDraft}
                                onStartTitleEditing={projectMenu.startTitleEditing}
                                onFinishTitleEditing={projectMenu.finishTitleEditing}
                                onCancelTitleEditing={projectMenu.cancelTitleEditing}
                                canUndo={historyState.canUndo}
                                canRedo={historyState.canRedo}
                                onCreateCanvas={createAndOpenCanvas}
                                projectCanvases={canvasProjects}
                                currentCanvasId={projectId}
                                onSwitchCanvas={(id) => navigate(`/canvas/${id}`)}
                                onOpenCanvasInNewWindow={projectMenu.openCanvasInNewWindow}
                                onRenameCanvas={projectMenu.renameCanvas}
                                onDuplicateCanvas={projectMenu.duplicateCanvas}
                                onDeleteCanvas={projectMenu.requestDeleteCanvas}
                                onDeleteProject={() => projectMenu.requestDeleteCanvas(projectId)}
                                onSave={() => void saveCanvasProject()}
                                onForceSave={confirmForceSaveCanvas}
                                localOnly={localOnly}
                                libtvChrome={searchParams.get("libtvChrome") === "1"}
                                libtvReadonlyChrome={searchParams.get("fixture") === "libtv-readonly-dense"}
                                onImportImage={() => handleUploadRequest()}
                                onImportLibTV={() => setLibTVImportOpen(true)}
                                onImportTapNow={() => setTapNowImportOpen(true)}
                                onUndo={undoCanvas}
                                onRedo={redoCanvas}
                                mediaPerformanceMode={mediaPerformanceMode}
                                onMediaPerformanceModeChange={setMediaPerformanceMode}
                                onOpenSearch={() => setNodeSearchOpen(true)}
                                projectContext={
                                    shortDramaEnabled && currentProject?.projectId
                                        ? {
                                              ...canvasContext,
                                              projectId: currentProject.projectId,
                                              projectName: linkedProjectQuery.data?.project.name || workspaceProject?.title || currentProject.title,
                                          }
                                        : undefined
                                }
                                onEnterFocusMode={enterFocusMode}
                                shortDramaGuide={shortDramaGuide}
                            />
                        ) : null}

                        {!focusMode && shortDramaGuide ? (
                            <CanvasShortDramaGuide progress={shortDramaGuide.progress} collapsed={shortDramaGuide.collapsed} onToggle={shortDramaGuide.onToggle} onSkip={skipShortDramaGuide} onStepClick={activateShortDramaStep} />
                        ) : null}

                        <div className="relative flex min-h-0 min-w-0 flex-1">
                            <div className="relative min-w-0 flex-1 overflow-hidden">
                                <InfiniteCanvas
                                    interactive={!versions.preview && !readOnly}
                                    containerRef={containerRef}
                                    viewport={viewport}
                                    appearance={canvasAppearance}
                                    backgroundMode={backgroundMode}
                                    wheelBehavior={wheelBehavior}
                                    lodDomHidden={lodActive && !isCanvasNodeMoving}
                                    graphicsLayer={
                                        <>
                                        <CanvasLodLayer
                                            containerRef={containerRef}
                                            active={lodActive}
                                            interactive={!versions.preview && !readOnly}
                                            viewport={viewport}
                                            nodes={lodNodes}
                                            nodeStackOrder={nodeStackOrder}
                                            selectedNodeIds={selectedNodeIds}
                                            theme={theme}
                                            onNodePointerDown={handleLodNodePointerDown}
                                            onNodeContextMenu={handleLodNodeContextMenu}
                                            onNodeDoubleClick={handleLodNodeDoubleClick}
                                            onHoverNodeChange={setLodHoverNodeId}
                                        />
                                        <CanvasLeaferGraphicsLayer
                                            containerRef={containerRef}
                                            viewport={viewport}
                                            theme={theme}
                                            scriptScrollTopById={scriptScrollTopById}
                                            connectingParams={connectingParams}
                                            batchConnectionPreview={batchConnectionPreview}
                                            mouseWorld={mouseWorld}
                                            connectionTargetNodeId={connectionTargetNodeId}
                                            connectionTargetAnchorRatio={connectionTargetAnchorRatio}
                                            nodeById={nodeById}
                                            selectionBox={selectionBox}
                                            selectedNodeBounds={selectedNodeBounds}
                                            alignmentGuides={alignmentGuides}
                                        />
                                        </>
                                    }
                                    onViewportChange={handleViewportChange}
                                    onViewportPreviewChange={handleViewportPreviewChange}
                                    onCanvasMouseDown={handleCanvasMouseDown}
                                    boxSelectEnabled={canvasTool === "box-select"}
                                    onCanvasDoubleClick={handleCanvasDoubleClick}
                                    onCanvasDeselect={deselectCanvas}
                                    onContextMenu={handleCanvasContextMenu}
                                    onDrop={handleDrop}
                                    onFileDragEnter={handleFileDragEnter}
                                    onFileDragLeave={handleFileDragLeave}
                                    onFileDragOver={handleFileDragOver}
                                >
                                    <CanvasNodeActionContext.Provider value={canvasNodeActions}>
                                        <CanvasNodeGraphContext.Provider value={nodeGraphContext}>
                                            <CanvasProjectWorldLayers
                                                containerRef={containerRef}
                                                connectionApproach={connectionApproach}
                                                projectId={projectId}
                                                viewportScale={viewport.k}
                                                displayConnections={renderedConnections}
                                                selectedConnectionId={selectedConnectionId}
                                                relatedConnectionIds={relatedHighlight.connectionIds}
                                                scriptScrollTopById={scriptScrollTopById}
                                                connectingParams={connectingParams}
                                                mouseWorld={mouseWorld}
                                                connectionTargetNodeId={connectionTargetNodeId}
                                                nodeById={nodeById}
                                                visibleNodes={visibleNodes}
                                                nodeStackOrder={nodeStackOrder}
                                                frameChildrenById={frameChildrenById}
                                                linkedFolderPreviewNodesById={linkedFolderPreviewNodesById}
                                                dragPreview={dragPreview}
                                                selectedNodeIds={selectedNodeIds}
                                                lodPinnedNodeIds={lodPinnedNodeIds}
                                                activeMediaNodeId={activeMediaNodeId}
                                                onActiveMediaNodeChange={setActiveMediaNodeId}
                                                frameDropTargetId={frameDropTargetId}
                                                relatedNodeIds={relatedHighlight.nodeIds}
                                                activeNodeId={activeNodeId}
                                                selectionBox={selectionBox}
                                                batchChildCountById={batchChildCountById}
                                                collapsingBatchIds={collapsingBatchIds}
                                                openingBatchIds={openingBatchIds}
                                                batchMotionById={batchMotionById}
                                                showImageInfo={showImageInfo}
                                                reduceMediaEffects={reduceMediaEffects}
                                                resourceReferenceByNodeId={resourceReferenceByNodeId}
                                                mentionReferencesByNodeId={mentionReferencesByNodeId}
                                                mediaEffectsDisabledNodeId={emotionNodeId}
                                                selectedNodeBounds={selectedNodeBounds}
                                                batchSourceNodeIds={batchSourceNodeIds}
                                                batchConnectionPreview={batchConnectionPreview}
                                                selectionBoundsElementRef={selectionBoundsElementRef}
                                                renderCanvasNodeContent={renderCanvasNodeContent}
                                                onConnectionSelect={handleConnectionSelect}
                                                onConnectionContextMenu={handleConnectionContextMenu}
                                                onNodeMouseDown={handleNodeMouseDown}
                                                onNodeHoverStart={handleCanvasNodeHoverStart}
                                                onNodeHoverEnd={handleCanvasNodeHoverEnd}
                                                onConnectStart={handleConnectStart}
                                                onNodeResize={handleNodeResize}
                                                onToggleFrame={handleFrameToggle}
                                                onFolderStyleChange={handleFolderStyleChange}
                                                onFolderThemeChange={handleFolderThemeChange}
                                                onNodeTitleChange={handleNodeTitleChange}
                                                onNodeContextMenu={handleNodeContextMenu}
                                                onNodeContentChange={handleNodeContentChange}
                                                onToggleBatch={toggleBatchExpanded}
                                                onSetBatchPrimary={setBatchPrimary}
                                                onRetry={retryCanvasNode}
                                                onReloadResource={reloadCanvasNodeResource}
                                                onOpenTaskDetails={openNodeTaskDetails}
                                                onCancelTask={handleCancelNodeTask}
                                                onOpenVersions={openCanvasNodeVersions}
                                                onViewImage={viewCanvasNodeImage}
                                                onReplaceMedia={replaceCanvasNodeMedia}
                                                onOpenTextEditor={openTextNodeEditor}
                                                onOpenDrawing={openDrawingNode}
                                                onStartBatchConnection={startBatchConnection}
                                                imageCropNodeId={cropNodeId}
                                                onCancelImageCrop={cancelImageCrop}
                                                onConfirmImageCrop={cropImageNode}
                                                annotationNodeId={annotationNodeId}
                                                onCancelAnnotation={cancelAnnotation}
                                                onConfirmAnnotation={saveAnnotatedImageNode}
                                                maskEditNodeId={maskEditNodeId}
                                                maskEditConfig={maskEditNode ? { ...effectiveConfig, model: maskEditNode.metadata?.model || effectiveConfig.model, imageModel: maskEditNode.metadata?.model || effectiveConfig.imageModel, size: maskEditNode.metadata?.size || effectiveConfig.size, quality: maskEditNode.metadata?.quality || effectiveConfig.quality, count: String(maskEditNode.metadata?.count || effectiveConfig.count) } : effectiveConfig}
                                                onCancelMaskEdit={cancelMaskEdit}
                                                onConfirmMaskEdit={maskEditImageNode}
                                                videoCropNodeId={videoCropNodeId}
                                                onCancelVideoCrop={cancelVideoCrop}
                                                onConfirmVideoCrop={cropVideoNode}
                                            />
                                        </CanvasNodeGraphContext.Provider>
                                    </CanvasNodeActionContext.Provider>
                                </InfiniteCanvas>

                                <CanvasActiveTaskPanel tasks={activeTasks} onCancelTask={cancelCanvasTask} topInset={focusMode ? "var(--space-3)" : "var(--canvas-topbar-offset)"} />

                                {focusMode ? (
                                    <CanvasFocusModeBar
                                        syncStatus={<CanvasSyncStatus projectId={projectId} onLoadLatest={reloadLatestCanvasProject} onOpenVersions={openVersions} />}
                                        versionsOpen={versions.open}
                                        onToggleVersions={toggleVersions}
                                        dockRevealed={focusDockRevealed}
                                        zoomPercent={viewport.k}
                                        onToggleDock={() => setFocusDockRevealed((value) => !value)}
                                        onExit={exitFocusMode}
                                        onZoomIn={zoomCanvasIn}
                                        onZoomOut={zoomCanvasOut}
                                        onFit={fitCanvasContent}
                                    />
                                ) : null}

                                <CanvasFileDropOverlay active={fileDropActive} theme={theme} />

                                {!readOnly ? emptyCanvasState : null}

                                {!readOnly && searchParams.get("fixture") !== "libtv-readonly-dense" && (!focusMode || focusDockRevealed) ? (
                                    <CanvasToolbar
                                        selectedCount={selectedNodeIds.size}
                                        libtvChrome={searchParams.get("libtvChrome") === "1"}
                                        workspaceMode={workspaceMode}
                                        canvasTool={canvasTool}
                                        onToolChange={setCanvasTool}
                                        isProjectLinked={Boolean(shortDramaEnabled && currentProject?.projectId)}
                                        canUndo={historyState.canUndo}
                                        canRedo={historyState.canRedo}
                                        appearance={canvasAppearance}
                                        backgroundMode={backgroundMode}
                                        showImageInfo={showImageInfo}
                                        onAddImage={() => createNode(CanvasNodeType.Image)}
                                        onAddVideo={() => createNode(CanvasNodeType.Video)}
                                        onAddAudio={() => createNode(CanvasNodeType.Audio)}
                                        onAddText={() => createNode(CanvasNodeType.Text)}
                                        onChooseStyle={() => setStylePickerOpen(true)}
                                        onAddScript={() => createNode(CanvasNodeType.Script)}
                                        onAddFrame={openFrameAnalysisOrCreate}
                                        onAddFolder={createFolder}
                                        onAddDrawing={() => createNode(CanvasNodeType.Drawing)}
                                        onAddExtensionNode={(type) => createNode(type)}
                                        onAddWorkflow={() => createNode(CanvasNodeType.Config)}
                                        onOpenDirector={() => createDirectorShot()}
                                        onUndo={undoCanvas}
                                        onRedo={redoCanvas}
                                        onUpload={() => handleUploadRequest()}
                                        onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                                        onClear={() => setClearConfirmOpen(true)}
                                        onDeselect={deselectCanvas}
                                        onAppearanceChange={applyCanvasAppearance}
                                        onSaveAppearanceDefault={saveCanvasAppearanceDefault}
                                        onBackgroundModeChange={setBackgroundMode}
                                        snapToGrid={snapToGrid}
                                        onSnapToGridChange={changeSnapToGrid}
                                        showConnections={showConnections}
                                        onShowConnectionsChange={changeConnections}
                                        wheelBehavior={wheelBehavior}
                                        onWheelBehaviorChange={changeWheelBehavior}
                                        onShowImageInfoChange={setShowImageInfo}
                                        onOpenMyAssets={() => openCanvasAssetLibrary()}
                                        onOpenProjectCharacters={() => openProjectAssets("character")}
                                        onOpenGenerationHistory={() => setGenerationHistoryOpen(true)}
                                        shortcutRequestNonce={shortcutRequestNonce}
                                    />
                                ) : null}
                            </div>

                        </div>

                        {angleNode?.metadata?.content ? (
                            <CanvasNodePanelOverlay
                                node={angleNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                panelWidth={640}
                                panelHeight={540}
                                allowOverflow
                                dragOffset={dragPreview?.nodeIds.has(angleNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(angleNode.id))}
                            >
                                <CanvasNodeAnglePanel
                                    dataUrl={angleNode.metadata.content}
                                    onClose={() => setAngleNodeId(null)}
                                    onConfirm={(params) => {
                                        void generateAngleNode(angleNode, params);
                                    }}
                                />
                            </CanvasNodePanelOverlay>
                        ) : null}

                        {lightingNode?.metadata?.content ? (
                            <AppModal flush open centered title={null} closable={false} footer={null} width={720} onCancel={() => setLightingNodeId(null)}>
                                <CanvasNodeLightingPanel
                                    dataUrl={lightingNode.metadata.content}
                                    onClose={() => setLightingNodeId(null)}
                                    onConfirm={(options, prompt) => {
                                        generateLightingNode(lightingNode, options, prompt);
                                    }}
                                />
                            </AppModal>
                        ) : null}

                        {emotionNode?.metadata?.content && !isCanvasNodeMoving ? (
                            <CanvasEmotionWorkspace
                                node={emotionNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                dragOffset={dragPreview?.nodeIds.has(emotionNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(emotionNode.id))}
                                onClose={() => setEmotionNodeId(null)}
                                onConfirm={(payload: CanvasImageEmotionPayload) => {
                                    void generateEmotionNode(emotionNode, payload);
                                }}
                            />
                        ) : null}

                        {dialogNode &&
                        !maskEditNodeId &&
                        !isCanvasImageSourceNode(dialogNode) &&
                        !dialogNode.metadata?.fileUpload &&
                        dialogNode.type !== CanvasNodeType.Script &&
                        dialogNode.type !== CanvasNodeType.BatchTable &&
                        dialogNode.type !== CanvasNodeType.Drawing &&
                        dialogNode.type !== CanvasNodeType.Panorama &&
                        !selectionBox &&
                        !isCanvasNodeMoving ? (
                            <CanvasNodePanelOverlay
                                node={dialogNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                panelHeight={dialogNode.type === CanvasNodeType.Text ? 148 : undefined}
                                allowOverflow={dialogNode.type !== CanvasNodeType.Config}
                                // Media composers follow the LibTV layout: keep the prompt
                                // panel attached below the node instead of flipping above it
                                // when the node is near the bottom of the canvas.
                                keepBelowNode={dialogNode.type === CanvasNodeType.Image || dialogNode.type === CanvasNodeType.Video || dialogNode.type === CanvasNodeType.Audio}
                                dragOffset={dragPreview?.nodeIds.has(dialogNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(dialogNode.id))}
                            >
                                {renderCanvasNodePanel(dialogNode)}
                            </CanvasNodePanelOverlay>
                        ) : null}

                        {pendingConnectionCreate ? (
                            <CanvasConnectionCreateMenu
                                pending={pendingConnectionCreate}
                                viewport={viewport}
                                viewportSize={size}
                                containerRef={containerRef}
                                canCreateDrawing={canCreateDrawingFromConnection}
                                getDisabledReason={(type) => getConnectionCreateDisabledReason(type, pendingConnectionCreate)}
                                onCreate={(type) => void createConnectedNode(type, pendingConnectionCreate)}
                                onClose={cancelPendingConnectionCreate}
                            />
                        ) : null}

                        {connectionReplaceHover ? (
                            <div
                                className="pointer-events-none fixed z-[var(--z-dialog-popover)] flex select-none items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white/90 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-md transition-all"
                                style={{
                                    left: connectionReplaceHover.clientX + 14,
                                    top: connectionReplaceHover.clientY + 14,
                                    transform: "translateY(-50%)",
                                }}
                            >
                                <ArrowLeftRight className="size-3 text-blue-400" />
                                <span>松开替换</span>
                                <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-200">@{connectionReplaceHover.referenceLabel}</span>
                            </div>
                        ) : null}

                        {selectedNodeBounds && !selectionBox && !isCanvasNodeMoving ? (
                            <CanvasProjectSelectionToolbar
                                anchorRef={selectionBoundsElementRef}
                                containerRef={containerRef}
                                count={selectedNodeBounds.count}
                                selectedVideoCount={selectedVideoNodes.length}
                                mergingVideos={Boolean(mergeVideoProgress)}
                                onAlign={alignSelectedNodes}
                                onArrange={arrangeSelectedNodes}
                                onCreateStoryboard={createStoryboardGroup}
                                onCreateReferenceGroup={createReferenceGroup}
                                onBatchConnect={() => beginBatchConnectionMode(Array.from(selectedNodeIds))}
                                onMergeVideos={() => void mergeSelectedVideos()}
                                onAskAssistant={openAssistant}
                                onSaveWorkflow={readOnly ? undefined : () => workflowsRef.current?.saveSelection()}
                            />
                        ) : null}

                        <CanvasNodeToolbar
                            node={isCanvasNodeMoving || nodeImageSettingsOpen || annotationNodeId || maskEditNodeId || emotionNodeId || angleNodeId || (dialogNode && !isCanvasMediaResultNode(dialogNode)) || textEditorNodeId ? null : toolbarNode}
                            workspaceMode={workspaceMode}
                            viewport={viewport}
                            containerRef={containerRef}
                            onKeep={keepNodeToolbar}
                            onLeave={hideNodeToolbar}
                            onInfo={(node) => (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId ? openTextNodeEditor(node) : setInfoNodeId(node.id))}
                            onEditText={openTextNodeEditor}
                            onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                            onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                            onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                            onGenerateImage={generateImageFromTextNode}
                            onUpload={(node) => handleUploadRequest(node.id)}
                            onDownload={downloadNodeImage}
                            onSaveAsset={(node) => void saveNodeAsset(node)}
                            onAnnotate={(node) => setAnnotationNodeId(node.id)}
                            onMaskEdit={(node) => { setDialogNodeId(null); setMaskEditNodeId(node.id); }}
                            onEmotion={(node) => { setDialogNodeId(null); setEmotionNodeId((current) => (current === node.id ? null : node.id)); }}
                            onPortraitTexture={openPortraitTextureEditor}
                            onCrop={(node) => node.type === CanvasNodeType.Video ? openVideoCrop(node) : setCropNodeId(node.id)}
                            onSplit={(node, params) => void splitImageNode(node, params)}
                            onUpscale={(node) => setUpscaleNodeId(node.id)} onSuperResolve={createUpscaleProcessingNode}
                            onDraftToFinal={generation.generateFinalVideoFromDraftNode} onVideoEditOperation={generation.createVideoEditNodeFromVideo}
                            onAngle={(node) => { setDialogNodeId(null); setAngleNodeId((current) => (current === node.id ? null : node.id)); }}
                            onLighting={(node) => { setDialogNodeId(null); setLightingNodeId((current) => (current === node.id ? null : node.id)); }}
                            onPanorama={openPanoramaConfig}
                            onViewImage={(node) => setPreviewNodeId(node.id)}
                            onExtractVideoFrames={extractVideoFrameAt}
                            onExtractAudioFromVideo={(node) => void extractAudioFromVideo(node)}
                            // 视频剪辑使用视频节点下方的内嵌时间轴，不再打开旧的片段重拍弹窗。
                            onTrimVideoSegments={openInlineVideoTrim}
                            onDepthCapture={(node) => void depthCaptureNode(node)}
                            onSubtitles={(node) => setSubtitleNodeId(node.id)}
                            onTimeline={(node) => setTimelineNodeId(node.id)}
                            extractingVideoFrames={toolbarNode?.id === extractingVideoFramesNodeId}
                            extractingAudio={segmentRunningMode === "audio"}
                            trimmingVideo={inlineTrimRunning}
                            onReversePrompt={createImageReversePromptNodes}
                            onRetry={retryCanvasNode}
                            onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                            onToggleLocked={(node) => toggleNodeLocked(node.id)}
                            onDelete={(node) => deleteNodes(new Set([node.id]))}
                        />

{isMiniMapOpen && !focusMode ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} canvasContainerRef={containerRef} onViewportPreviewChange={previewViewport} onViewportChange={handleViewportChange} /> : null}

                        {!focusMode ? (
                            <CanvasOverlayLayerContainer
                                overlayId="asset-tray"
                                fallbackZIndex="var(--z-panel)"
                                className={`canvas-libtv-overlay-toolbar absolute bottom-[calc(var(--canvas-inset-y)+var(--space-16))] left-[var(--canvas-inset-x)] flex items-end gap-2 lg:bottom-[var(--canvas-inset-y)] ${searchParams.get("fixture") === "libtv-readonly-dense" ? "canvas-libtv-readonly-dock" : ""}`}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                onWheel={(event) => event.stopPropagation()}
                            >
                                <CanvasAssetTray
                                    libraryAssets={assets.filter((asset): asset is Extract<typeof asset, { kind: "image" | "video" | "audio" | "text" }> => ["image", "video", "audio", "text"].includes(asset.kind))}
                                    canvasImages={canvasImageNodes}
                                    showLibrary={!currentProject?.projectId}
                                    activeNodeId={selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null}
                                    onInsertAsset={(asset) => void handleAssetsInsert([localAssetToInsertPayload(asset)])}
                                    onFocusCanvasImage={focusCanvasImageNode}
                                />
                                <CanvasZoomControls
                                    scale={viewport.k}
                                    libtvChrome={searchParams.get("libtvChrome") === "1"}
                                    containerRef={containerRef}
                                    onScaleChange={setZoomScale}
                                    onFitContent={fitCanvasContent}
                                    onAutoArrange={autoArrangeCanvasNodes}
                                    snapToGrid={snapToGrid}
                                    onSnapToGridChange={changeSnapToGrid}
                                    showConnections={showConnections}
                                    onToggleConnections={toggleConnections}
                                    isMiniMapOpen={isMiniMapOpen}
                                    onToggleMiniMap={toggleMiniMap}
                                />
                            </CanvasOverlayLayerContainer>
                        ) : null}

                        {inlineTrimNode ? (
                            <CanvasVideoInlineTrimOverlay
                                node={inlineTrimNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                dragOffset={dragPreview?.nodeIds.has(inlineTrimNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(inlineTrimNode.id))}
                                busy={inlineTrimRunning}
                                onCancel={closeInlineVideoTrim}
                                onConfirm={(range) => void confirmInlineVideoTrim(inlineTrimNode, range)}
                            />
                        ) : null}

                        <CanvasProjectContextMenu
                            menu={contextMenu}
                            node={contextMenuNode}
                            workspaceMode={workspaceMode}
                            isProjectLinked={Boolean(currentProject?.projectId)}
                            canUndo={historyState.canUndo}
                            canRedo={historyState.canRedo}
                            canPaste={hasCopiedNodes || Boolean(navigator.clipboard)}
                            selectedCount={selectedNodeIds.size}
                            screenToCanvas={screenToCanvas}
                            onClose={() => setContextMenu(null)}
                            onAddNode={(type, position) => createNode(type, position)}
                            onAddFolder={createFolder}
                            onChooseStyle={() => setStylePickerOpen(true)}
                            onOpenDirector={(position) => createDirectorShot(position)}
                            onUpload={(nodeId, position) => handleUploadRequest(nodeId, position)}
                            onOpenAssets={openCanvasAssetLibrary}
                            onOpenProjectCharacters={(position) => openProjectAssets("character", position)}
                            onOpenGenerationHistory={() => setGenerationHistoryOpen(true)}
                            onUndo={undoCanvas}
                            onRedo={redoCanvas}
                            onPaste={pasteAtPosition}
                            onCopyNode={(nodeId) => copyNodesToClipboard(new Set([nodeId]))}
                            onCreateGenerationCopy={(nodeId) => duplicateNode(nodeId, "copy")}
                            onDuplicate={duplicateNode}
                            onDeleteNode={(nodeId) => deleteNodes(new Set([nodeId]))}
                            onDeleteConnection={deleteConnection}
                            onSaveAsset={(node) => void saveNodeAsset(node)}
                            onViewMedia={(node) => setPreviewNodeId(node.id)}
                            onEditText={openTextNodeEditor}
                            onOpenDrawing={openDrawingNode}
                            onGenerateImage={generateImageFromTextNode}
                            onCopyContent={(node) => void copyNodeContentToClipboard(node)}
                            onCopyMediaUrl={(node) => void copyNodeMediaUrlToClipboard(node)}
                            onUploadToArkPrivateAsset={confirmUploadNodeImageToArkPrivateAsset}
                            onSetAssetCategory={(nodeId, assetCategory) => handleConfigNodeChange(nodeId, { assetCategory })}
                            onToggleFrame={(node) => handleFrameToggle(node.id)}
                            onSpreadSelection={spreadSelectedNodes}
                            onCopySelection={copySelectedNodes}
                            onDeleteSelection={() => deleteNodes(selectedNodeIds)}
                        />

                        <CanvasUploadModal open={uploadModalOpen} onClose={closeUploadModal} onUpload={handleUploadFiles} onImportUrl={handleImportUrl} />
                        <input ref={imageInputRef} type="file" accept="image/*,video/*,.mp4,.mov,.m4v,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav,.txt,.md,.markdown" multiple className="hidden" onChange={handleImageInputChange} />

                        <CanvasProjectEditorDialogs
                            projectId={projectId} theme={theme} config={effectiveConfig}
                            document={document} dialogs={dialogs} renderModel={renderModel}
                            generation={generation} nodeEditor={nodeEditor} mediaTools={mediaTools}
                            styles={styles} director={director}
                            viewport={viewport} viewportSize={size}
                            onFocusNode={focusCanvasNode}
                            onSearchFocusNode={(nodeId) => {
                                const target = nodeById.get(nodeId);
                                const parent = target?.parentId ? nodeById.get(target.parentId) : null;
                                if (parent?.metadata?.frame?.collapsed) toggleFrameCollapsed(parent.id);
                                const batchRoot = target?.metadata?.batchRootId ? nodeById.get(target.metadata.batchRootId) : null;
                                if (batchRoot && !batchRoot.metadata?.imageBatchExpanded) toggleBatchExpanded(batchRoot.id);
                                const selection = new Set([nodeId]);
                                selectedNodeIdsRef.current = selection;
                                setSelectedNodeIds(selection);
                                setSelectedConnectionId(null);
                                focusCanvasNode(nodeId);
                            }}
                            imports={{ onApplyLibTV: applyLibTVImport, onApplyTapNow: applyTapNowImport }}
                            timeline={{
                                project: currentProject?.timeline || null,
                                onSave: next => persistCanvasTimeline(projectId, next),
                                onUpdate: next => updateProject(projectId, { timeline: next }),
                                onOpenAssetLibrary: openTimelineAssetLibrary,
                                onOpenProjectAssets: () => openProjectAssets("all", undefined, "timeline"),
                                onUploadLocalFiles: uploadTimelineMedia,
                                addNodeToTimelineRef: timelineAddNodeRef, addMediaToTimelineRef: timelineMediaAddRef,
                                onCreateAssembledNode: createVideoNodeFromBlob,
                            }}
                            directorOnboardingScope={directorOnboardingScope}
                            onDeleteNodes={deleteNodes} onAddDirectorImage={addDirectorReferenceToCanvas}
                            onFlush={flushCanvasStorePersistence} onClearCanvas={clearCanvas}
                            onSetPrimaryVersion={setPrimaryVersion}
                            assets={{
                                pickerOpen: assetPickerOpen, multiple: assetInsertScope === "canvas",
                                onInsertLibrary: handleLibraryAssetsInsert, onClosePicker: closeAssetPicker,
                                projectOpen: projectAssetOpen, detail: linkedProjectQuery.data,
                                initialCategory: projectAssetInitialCategory, initialFolderId: projectAssetInitialFolderId,
                                onCloseProject: closeProjectAssets, onInsertProject: handleTimelineProjectAssetsInsert,
                                onInsertFolder: projectAssetScope === "canvas" ? handleProjectFolderInsert : undefined,
                            }}
                        />
                    </section>
                    {versions.preview ? <CanvasVersionPreview key={versions.preview.key} preview={versions.preview} busy={versions.restoring || versions.confirming} onReturn={versions.returnToCurrent} onShowVersions={versions.show} /> : null}
                    </div>
                </CanvasOverlayLayerProvider>
                {rightPanel === "assistant" && !focusMode && !versions.preview ? (
                    <CanvasAssistantSidebar
                        proposalFeedback={assistantProposalFeedback}
                        runningProposalIds={runningProposalIds}
                        assistant={assistant}
                        continuation={assistantContinuation}
                        nodes={nodes}
                        canvasTitle={workspaceProject?.title === "未命名项目" || !workspaceProject?.title ? "未命名工作区" : workspaceProject.title}
                        dockable={assistantDockable}
                        readOnly={readOnly}
                        selectedNodeIds={assistantSelectedNodeIds}
                        references={assistantMentionReferences}
                        onLocateNodes={locateAssistantNodes}
                        onRunProposal={runAssistantProposal}
                        onOpenModelSettings={() => navigate("/settings?section=channels")}
                    />
                ) : null}
                <CanvasVersionHistory history={versions} />
                <CanvasWorkflowWorkspace
                    key={projectId}
                    ref={workflowsRef}
                    nodes={nodes}
                    connections={connections}
                    selection={selectedNodeIds}
                    readOnly={readOnly}
                    dockable={assistantDockable}
                    visible={!focusMode && !versions.preview}
                    onOpenChange={open => { setWorkflowLibraryOpen(open); if (open) { assistant.setOpen(false); versions.close(); } }}
                    onInstantiate={workflowInstances.add}
                />
            </main>
        </>
    );
}
