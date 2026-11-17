import { App, Button } from "antd";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { CanvasDeleteConfirmation } from "@/components/canvas/canvas-delete-confirmation";
import type { CanvasNodeGraphContextValue } from "@/components/canvas/canvas-node-graph-context";
import { CanvasProjectSidebar } from "@/components/canvas/canvas-project-sidebar";
import { CanvasShortDramaGuide } from "@/components/canvas/canvas-short-drama-entry";
import { CanvasUploadModal } from "@/components/canvas/canvas-upload-modal";
import { CanvasOverlayLayerProvider } from "@/components/canvas/canvas-overlay-layer";
import { usePersonalAssetLibrary } from "@/hooks/use-personal-asset-library";
import { DEFAULT_DRAWING_ENGINE } from "@/lib/canvas/canvas-drawing-engine";
import { getContextResourceNodes, buildCanvasAgentMentionReferences } from "@/lib/canvas/canvas-resource-references";
import { listCanvasWorkspaceProjectCanvases } from "@/lib/canvas/canvas-workspace-project";
import { isEmbeddedRuntime } from "@/lib/embedded-runtime";
import { persistCanvasTimeline, refreshLocalCanvasProjectIfChanged } from "@/services/local-workspace-repository";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasThemeScope } from "@/stores/canvas/use-canvas-theme-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasWorkspaceMode } from "@/types/canvas";
import { highlightAssistantNodes } from "./canvas-assistant-highlight";
import { CanvasAssistantSidebar } from "./canvas-assistant-sidebar";
import { CanvasProjectEditorDialogs } from "./canvas-project-editor-dialogs";
import { CanvasProjectStage } from "./canvas-project-stage";
import { CanvasTopBar } from "./canvas-project-top-bar";
import { CanvasRefreshShell } from "./canvas-refresh-shell";
import { CanvasSyncStatus } from "./canvas-sync-status";
import { CanvasVersionHistory, useCanvasVersionHistory } from "./canvas-version-history";
import { CanvasVersionPreview } from "./canvas-version-preview";
import { CanvasWorkflowWorkspace, type CanvasWorkflowsHandle } from "./canvas-workflow-workspace";
import { useCanvasActiveTasks } from "./use-canvas-active-tasks";
import { resolveCanvasRightPanel, useCanvasAssistant, useCanvasAssistantDockable } from "./use-canvas-assistant";
import { useCanvasAssistantContinuation } from "./use-canvas-assistant-continuation";
import { useCanvasAssistantProposal } from "./use-canvas-assistant-proposal";
import { useCanvasConnectedNodeVisibility } from "./use-canvas-connected-node-visibility";
import { useCanvasDocumentState } from "./use-canvas-document-state";
import { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasImport } from "./use-canvas-import";
import { useCanvasLibTvVisualFixtures } from "./use-canvas-libtv-visual-fixtures";
import { useCanvasPreferences } from "./use-canvas-preferences";
import { useCanvasProjectActions } from "./use-canvas-project-actions";
import { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import { useCanvasProjectLifecycle } from "./use-canvas-project-lifecycle";
import { useCanvasProjectMediaAndSelection } from "./use-canvas-project-media-and-selection";
import { useCanvasProjectMenu } from "./use-canvas-project-menu";
import { useCanvasSelectionContext } from "./use-canvas-selection-context";
import { useCanvasUpload } from "./use-canvas-upload";
import { useCanvasViewportController } from "./use-canvas-viewport-controller";
import { useCanvasDockedViewport, useCanvasViewportState } from "./use-canvas-viewport-state";
import { useCanvasWorkflowInstances } from "./use-canvas-workflow-instances";

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
    const { containerRef, viewport, viewportRef, setViewport, setVirtualizationViewport, size } = viewportState;

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
    const { nodes, nodesRef, setNodes, adoptNodes, connections, connectionsRef, setConnections, chatSessions, chatSessionsRef, setChatSessions, activeChatId, activeChatIdRef, setActiveChatId } = document;
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
    const activeMediaNodeId = pageUi((state) => state.activeMediaNodeId);
    useEffect(() => {
        pageUi.getState().resetForProject();
    }, [pageUi, projectId]);
    // While the overview canvas is active it culls every frame itself, so
    // camera previews need not re-render this page to refresh virtualization.
    const lodActiveRef = useRef(false);
    const lodEnterScaleRef = useRef(0);
    const contextMenu = pageUi((state) => state.contextMenu);
    const preferences = useCanvasPreferences();
    const {
        snapToGrid,
        showConnections,
        canvasAppearance,
        backgroundMode,
        showImageInfo,
        mediaPerformanceMode,
        theme,
        resolvedCanvasAppearance,
        applyCanvasAppearance,
        setBackgroundMode,
        setShowImageInfo,
        setCanvasAppearance,
        setMediaPerformanceMode,
        setShowConnections,
        focusMode,
        enterFocusMode,
        exitFocusMode,
        toggleFocusMode,
    } = preferences;
    const workspaceMode: CanvasWorkspaceMode = "professional";
    const dialogs = useCanvasProjectDialogs(pageUi);
    const {
        setGenerationHistoryOpen,
        setTapNowImportOpen,
        setNodeSearchOpen,
        setLibTVImportOpen,
        textEditorNodeId,
        setScriptEditorNodeId,
        setVersionCompareRootId,
    } = dialogs;
    const setToolbarNodeId = pageUi((state) => state.setToolbarNodeId);
    const nodeImageSettingsOpen = pageUi((state) => state.nodeImageSettingsOpen);
    const setNodeImageSettingsOpen = pageUi((state) => state.setNodeImageSettingsOpen);
    const dialogNodeId = pageUi((state) => state.dialogNodeId);
    const setDialogNodeId = pageUi((state) => state.setDialogNodeId);
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
    }), [activeChatIdRef, chatSessionsRef, connectionsRef, nodesRef, viewportRef]);
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
    const internalAssistantEnabled = !isEmbeddedRuntime();
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
    const { selectedIds: assistantSelectedNodeIds, askSelectedNodes } = useCanvasSelectionContext(projectId, currentProject?.title, nodes, selectedNodeIds, projectLoaded, openAssistant);
    // 助手的 @ 菜单覆盖整张画布，而不是只覆盖能当生成输入的资源节点。
    const assistantMentionReferences = useMemo(() => buildCanvasAgentMentionReferences(nodes), [nodes]);
    // 扩展节点（对比/图表/调色）要读自己的上游才能渲染，经 Context 下发；
    // 取上游复用 canvas-resource-references 的实现，别在这里另写一份。必须 memo——
    // 每帧新对象会让所有节点跟着重渲染，错题本里多条崩溃都出在画布高频更新。
    const nodeGraphContext = useMemo<CanvasNodeGraphContextValue>(() => ({ getUpstreamNodes: (nodeId: string) => getContextResourceNodes(nodeId, nodes, connections), getNode: (nodeId: string) => nodes.find((node) => node.id === nodeId) }), [connections, nodes]);

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
    }, [dialogNodeId, setNodeImageSettingsOpen]);

    useLayoutEffect(() => {
        selectedNodeIdsRef.current = selectedNodeIds;
    }, [selectedNodeIds]);

    // 停靠栏挤压画布时补偿一半位移：用户正在看的那块内容留在原处，视野不跳。
    const dockedPanelWidth = !assistantDockable ? 0 : rightPanel === "assistant" ? assistant.width : workflowLibraryOpen && !focusMode && !versions.preview ? 380 : 0;
    useCanvasDockedViewport(dockedPanelWidth, viewportState);

    const viewportController = useCanvasViewportController({
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
    const { focusCanvasNode, getCanvasCenter, screenToCanvas } = viewportController;

    const workflowInstances = useCanvasWorkflowInstances({
        canvasId: projectId,
        domainProjectId: currentProject?.projectId,
        readOnly,
        nodes,
        nodesRef,
        setNodes,
        connectionsRef,
        setConnections,
        getCanvasCenter,
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

    const editGenerationInputRef = useRef<((node: CanvasNodeData) => void) | undefined>(undefined);
    const generation = useCanvasGenerationOrchestration({
        pageUi,
        readOnly,
        onEditGenerationInput: (target) => editGenerationInputRef.current?.(target),
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

    const assistantContinuation = useCanvasAssistantContinuation(assistant, !readOnly && internalAssistantEnabled);
    const { runAssistantProposal, assistantProposalFeedback, runningProposalIds } = useCanvasAssistantProposal({
        projectId,
        addedSkills,
        nodesRef,
        connectionsRef,
        handledProposals: assistant.handledProposals,
        markProposalHandled: assistant.markProposalHandled,
        continuationSessionId: assistant.sessionId,
        continuePlan: Boolean(assistant.plan?.items.some((item) => item.status !== "done")),
        onContinuationArmed: assistantContinuation.refresh,
        handleGenerateNode: generation.handleGenerateNode,
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
        onCancelNodeGeneration: generation.cancelNodeGeneration,
    });

    const mediaSelection = useCanvasProjectMediaAndSelection({
        projectId,
        linkedProjectId,
        readOnly,
        canvasTitle: currentProject?.title || "未命名画布",
        directorScenes: currentProject?.directorScenes,
        addedSkills,
        projectLoaded,
        mediaPerformanceMode,
        showConnections,
        snapToGrid,
        defaultDrawingEngine,
        assets,
        assetsHydrated,
        effectiveConfig,
        searchParams,
        setSearchParams,
        pageUi,
        selectedNodeIds,
        selectedNodeIdsRef,
        selectedConnectionId,
        hoveredNodeId,
        lodHoverNodeId,
        activeMediaNodeId,
        nodeImageSettingsOpen,
        contextMenu,
        lodActiveRef,
        lodEnterScaleRef,
        historyPausedRef,
        viewportState,
        viewportController,
        document,
        dialogs,
        generation,
        uploads,
        workflowInstances,
        keepConnectedNodeVisible,
        cleanupCanvasFiles,
        message,
    });
    editGenerationInputRef.current = mediaSelection.canvasNodeActions.editGenerationInput;

    const actions = useCanvasProjectActions({
        pageUi,
        projectId,
        workspaceMode,
        currentProject,
        linkedProjectId,
        workspaceProject,
        shortDramaEnabled,
        localOnly,
        readOnly,
        internalAssistantEnabled,
        projectLoaded,
        focusMode,
        config,
        theme,
        searchParams,
        setSearchParams,
        selectedNodeIds,
        selectedNodeIdsRef,
        selectedConnectionId,
        shortcutRequestNonceSetter: setShortcutRequestNonce,
        activeTasks,
        versions,
        clearCanvasFiles,
        enterFocusMode,
        exitFocusMode,
        toggleFocusMode,
        toggleAssistant,
        openAssistant,
        undoCanvas,
        redoCanvas,
        saveCanvasProject,
        updateProject,
        viewportState,
        viewportController,
        document,
        dialogs,
        generation,
        uploads,
        workflowInstances,
        mediaSelection,
        message,
    });

    const { linkedProjectQuery, timelineAssetInsert, mediaTools, nodeOperations, nodeEditor, handleProjectFolderInsert, renderModel, dialogNode } = mediaSelection;
    const { handleFrameToggle, toggleBatchExpanded } = nodeEditor;
    const { deleteNodes, setPrimaryVersion } = nodeOperations;
    const { nodeById, toolbarNode } = renderModel;
    const { activateShortDramaStep, shortDramaGuide, skipShortDramaGuide, clearCanvas, locateAssistantNodes, locateProjectStyleNode, styles, director, addDirectorReferenceToCanvas } = actions;

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
            {projectMenu.deletingCanvas ? (
                <CanvasDeleteConfirmation
                    title="删除画布？"
                    description={`将删除「${projectMenu.deletingCanvasTitle}」，里面的节点和连线也会一起移除。`}
                    onCancel={projectMenu.cancelDeleteCanvas}
                    onConfirm={projectMenu.confirmDeleteCanvas}
                />
            ) : null}
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
                    <CanvasProjectSidebar projectId={currentProject.projectId} detail={linkedProjectQuery.data} onAddChapter={uploads.handleProjectChapterInsert} onLocateStyle={locateProjectStyleNode} onOpenAssets={() => timelineAssetInsert.openProjectAssets()} />
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
                                    onToggleAssistant={internalAssistantEnabled ? toggleAssistant : undefined}
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
                                    onImportImage={() => uploads.handleUploadRequest()}
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
                                                  ...mediaSelection.canvasContext,
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

                            <CanvasProjectStage
                                projectId={projectId}
                                currentProject={currentProject}
                                workspaceMode={workspaceMode}
                                shortDramaEnabled={shortDramaEnabled}
                                readOnly={readOnly}
                                assets={assets}
                                effectiveConfig={effectiveConfig}
                                searchParams={searchParams}
                                shortcutRequestNonce={shortcutRequestNonce}
                                pageUi={pageUi}
                                workflowsRef={workflowsRef}
                                versions={versions}
                                activeTasks={activeTasks}
                                historyState={historyState}
                                undoCanvas={undoCanvas}
                                redoCanvas={redoCanvas}
                                reloadLatestCanvasProject={reloadLatestCanvasProject}
                                openVersions={openVersions}
                                toggleVersions={toggleVersions}
                                nodeGraphContext={nodeGraphContext}
                                preferences={preferences}
                                viewportState={viewportState}
                                viewportController={viewportController}
                                document={document}
                                dialogs={dialogs}
                                generation={generation}
                                uploads={uploads}
                                mediaSelection={mediaSelection}
                                actions={actions}
                                askSelectedNodes={askSelectedNodes}
                            />

                            <CanvasUploadModal open={uploads.uploadModalOpen} onClose={uploads.closeUploadModal} onUpload={uploads.handleUploadFiles} onImportUrl={uploads.handleImportUrl} />
                            <input ref={uploads.imageInputRef} type="file" accept="image/*,video/*,.mp4,.mov,.m4v,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav,.txt,.md,.markdown" multiple className="hidden" onChange={uploads.handleImageInputChange} />

                            <CanvasProjectEditorDialogs
                                projectId={projectId}
                                readOnly={readOnly}
                                theme={theme}
                                config={effectiveConfig}
                                document={document}
                                dialogs={dialogs}
                                renderModel={renderModel}
                                generation={generation}
                                nodeEditor={nodeEditor}
                                mediaTools={mediaTools}
                                styles={styles}
                                director={director}
                                viewport={viewport}
                                viewportSize={size}
                                onFocusNode={focusCanvasNode}
                                onOpenNodePromptPanel={(nodeId) => {
                                    const selection = new Set([nodeId]);
                                    selectedNodeIdsRef.current = selection;
                                    setSelectedNodeIds(selection);
                                    setSelectedConnectionId(null);
                                    setDialogNodeId(nodeId);
                                }}
                                onSearchFocusNode={(nodeId) => {
                                    const target = nodeById.get(nodeId);
                                    const parent = target?.parentId ? nodeById.get(target.parentId) : null;
                                    if (parent?.metadata?.frame?.collapsed) {
                                        handleFrameToggle(parent.id); if (parent.metadata.folder) { focusCanvasNode(parent.id); return; }
                                    }
                                    const batchRoot = target?.metadata?.batchRootId ? nodeById.get(target.metadata.batchRootId) : null;
                                    if (batchRoot && !batchRoot.metadata?.imageBatchExpanded) toggleBatchExpanded(batchRoot.id);
                                    const selection = new Set([nodeId]);
                                    selectedNodeIdsRef.current = selection; setSelectedNodeIds(selection); setSelectedConnectionId(null); focusCanvasNode(nodeId);
                                }}
                                imports={{ onApplyLibTV: applyLibTVImport, onApplyTapNow: applyTapNowImport }}
                                timeline={{
                                    project: currentProject?.timeline || null,
                                    onSave: (next) => persistCanvasTimeline(projectId, next),
                                    onUpdate: (next) => updateProject(projectId, { timeline: next }),
                                    onOpenAssetLibrary: timelineAssetInsert.openTimelineAssetLibrary,
                                    onOpenProjectAssets: () => timelineAssetInsert.openProjectAssets("all", undefined, "timeline"),
                                    onUploadLocalFiles: uploads.uploadTimelineMedia,
                                    addNodeToTimelineRef: timelineAssetInsert.timelineAddNodeRef,
                                    addMediaToTimelineRef: timelineAssetInsert.timelineMediaAddRef,
                                    onCreateAssembledNode: uploads.createVideoNodeFromBlob,
                                }}
                                directorOnboardingScope={directorOnboardingScope}
                                onDeleteNodes={deleteNodes}
                                onAddDirectorImage={addDirectorReferenceToCanvas}
                                onFlush={flushCanvasStorePersistence}
                                onClearCanvas={clearCanvas}
                                onSetPrimaryVersion={setPrimaryVersion}
                                assets={{
                                    pickerOpen: uploads.assetPickerOpen,
                                    multiple: timelineAssetInsert.assetInsertScope === "canvas",
                                    onInsertLibrary: timelineAssetInsert.handleLibraryAssetsInsert,
                                    onClosePicker: uploads.closeAssetPicker,
                                    projectOpen: timelineAssetInsert.projectAssetOpen,
                                    detail: linkedProjectQuery.data,
                                    initialCategory: timelineAssetInsert.projectAssetInitialCategory,
                                    initialFolderId: timelineAssetInsert.projectAssetInitialFolderId,
                                    onCloseProject: timelineAssetInsert.closeProjectAssets,
                                    onInsertProject: timelineAssetInsert.handleTimelineProjectAssetsInsert,
                                    onInsertFolder: timelineAssetInsert.projectAssetScope === "canvas" ? handleProjectFolderInsert : undefined,
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
                    onOpenChange={(open) => { setWorkflowLibraryOpen(open); if (open) { assistant.setOpen(false); versions.close(); } }}
                    onInstantiate={workflowInstances.add}
                />
            </main>
        </>
    );
}
