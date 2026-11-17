import { App } from "antd";
import { useCallback, useRef, type Dispatch, type MouseEvent as ReactMouseEvent, type MutableRefObject, type SetStateAction } from "react";
import type { SetURLSearchParams } from "react-router";

import { highlightAssistantNodes } from "./canvas-assistant-highlight";
import { pasteCanvasAtPosition } from "./canvas-project-clipboard";
import { CanvasProjectNodeContent } from "./canvas-project-node-content";
import { CanvasProjectNodePrompt } from "./canvas-project-node-prompt";
import { canvasNodeRetryPlan } from "./canvas-generation-orchestration";
import { useCanvasContextMenu } from "./use-canvas-context-menu";
import { canvasKeyboardEnabled, useCanvasKeyboard } from "./use-canvas-keyboard";
import { useCanvasDirector } from "./use-canvas-director";
import { useCanvasNodeMediaShareActions } from "./use-canvas-node-media-share-actions";
import { useCanvasShortDrama } from "./use-canvas-short-drama";
import { starterAssistantHandler, useCanvasStarterNavigation } from "./use-canvas-starter-navigation";
import { useCanvasStyleWorkflow } from "./use-canvas-style-workflow";
import { useCanvasCreateCommands } from "@/components/canvas/use-canvas-create-commands";
import { CanvasFreeformEmptyState, CanvasLinkedProjectEmptyState, CanvasShortDramaEmptyState } from "@/components/canvas/canvas-short-drama-entry";
import { canvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";
import { canRecoverManagedToolNode, isVideoSubtitleEraseNode } from "@/lib/canvas/canvas-ai-upscale-task";
import { removeCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { resolveCanvasEmptyStateKind } from "@/lib/canvas/canvas-starter";
import { generationErrorMessage } from "@/lib/generation-error";
import { queryGenerationTask } from "@/services/api/task-center";
import type { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import type { useCanvasVersionHistory } from "./canvas-version-history";
import type { useCanvasActiveTasks } from "./use-canvas-active-tasks";
import type { useCanvasDocumentState } from "./use-canvas-document-state";
import type { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import type { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import type { useCanvasProjectMediaAndSelection } from "./use-canvas-project-media-and-selection";
import type { useCanvasUpload } from "./use-canvas-upload";
import type { useCanvasViewportController } from "./use-canvas-viewport-controller";
import type { useCanvasViewportState } from "./use-canvas-viewport-state";
import type { useCanvasWorkflowInstances } from "./use-canvas-workflow-instances";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasWorkspaceMode, type Position } from "@/types/canvas";

type ProjectActionsParams = {
    pageUi: ReturnType<typeof createCanvasPageUiStore>;
    projectId: string;
    workspaceMode: CanvasWorkspaceMode;
    currentProject?: CanvasProject;
    linkedProjectId: string;
    workspaceProject: CanvasProject | null;
    shortDramaEnabled: boolean;
    localOnly: boolean;
    readOnly: boolean;
    internalAssistantEnabled: boolean;
    projectLoaded: boolean;
    focusMode: boolean;
    config: AiConfig;
    theme: CanvasTheme;
    searchParams: URLSearchParams;
    setSearchParams: SetURLSearchParams;
    selectedNodeIds: Set<string>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    selectedConnectionId: string | null;
    shortcutRequestNonceSetter: Dispatch<SetStateAction<number>>;
    activeTasks: ReturnType<typeof useCanvasActiveTasks>["tasks"];
    versions: ReturnType<typeof useCanvasVersionHistory>;
    clearCanvasFiles: () => void;
    enterFocusMode: () => void;
    exitFocusMode: () => void;
    toggleFocusMode: () => void;
    toggleAssistant: () => void;
    openAssistant: () => void;
    undoCanvas: () => void;
    redoCanvas: () => void;
    saveCanvasProject: (options?: { requireRemote?: boolean }) => Promise<boolean>;
    updateProject: (id: string, patch: Partial<CanvasProject>) => void;
    viewportState: ReturnType<typeof useCanvasViewportState>;
    viewportController: ReturnType<typeof useCanvasViewportController>;
    document: ReturnType<typeof useCanvasDocumentState>;
    dialogs: ReturnType<typeof useCanvasProjectDialogs>;
    generation: ReturnType<typeof useCanvasGenerationOrchestration>;
    uploads: ReturnType<typeof useCanvasUpload>;
    workflowInstances: ReturnType<typeof useCanvasWorkflowInstances>;
    mediaSelection: ReturnType<typeof useCanvasProjectMediaAndSelection>;
    message: ReturnType<typeof App.useApp>["message"];
};

export function useCanvasProjectActions({
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
    shortcutRequestNonceSetter,
    activeTasks,
    versions,
    clearCanvasFiles,
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
}: ProjectActionsParams) {
    const { containerRef, viewport } = viewportState;
    const { fitCanvasContent, fitCanvasSelection, focusCanvasImageNode, focusCanvasNode, screenToCanvas, zoomCanvasIn, zoomCanvasOut, zoomToActualSize } = viewportController;
    const { nodes, nodesRef, connections, connectionsRef, setNodes, setConnections } = document;
    const {
        openTextNodeEditor,
        setStylePickerOpen,
        setGenerationHistoryOpen,
        setInfoNodeId,
        setNodeSearchOpen,
        setPreviewNodeId,
        setVersionCompareRootId,
        setDirectorNodeId,
        directorNodeId,
        resetForClearCanvas,
    } = dialogs;
    const setSelectedNodeIds = pageUi((state) => state.setSelectedNodeIds);
    const setSelectedConnectionId = pageUi((state) => state.setSelectedConnectionId);
    const {
        finishGenerationRequest,
        generateScriptRows,
        handleRetryNode,
        reconcileImageBatchRootNode,
        retryImageBatchChildren,
        setRunningNodeId,
        startGenerationRequest,
        cancelCanvasTask,
    } = generation;
    const { handleProjectChapterInsert, handleUploadRequest, pasteSystemClipboard } = uploads;
    const {
        linkedProjectQuery,
        timelineAssetInsert,
        mediaTools,
        startUpscaleBatch,
        setAngleNodeId,
        setLightingNodeId,
        setEmotionNodeId,
        nodeOperations,
        referenceActions,
        connectionController,
        selectionController,
        nodeEditor,
        renderModel,
    } = mediaSelection;
    const {
        createFolder,
        createNode,
        createGenerationReplacement,
        copySelectedNodes,
        deleteConnection,
        deleteNodes,
        pasteCopiedNodes,
        releaseCopiedNodesPastePriority,
        restoreCopiedNodesFromText,
        shouldPreferCopiedNodes,
        autoArrangeCanvasNodes,
    } = nodeOperations;
    const { cancelSelectionBox, deselectCanvas, handleNodeMouseDown, nodeDropTargetId } = selectionController;
    const { recoverAIUpscale, retryDepthCaptureNode, setAnnotationNodeId, setCropNodeId, setFrameDialogNodeId, setMaskEditNodeId } = mediaTools;
    const { handleConfigNodeChange, handleFrameToggle } = nodeEditor;

    const styles = useCanvasStyleWorkflow({
        pageUi,
        canvasId: projectId,
        domainProjectId: currentProject?.projectId,
        nodesRef,
        selectedNodeIdsRef,
        getCanvasCenter: viewportController.getCanvasCenter,
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
        getCanvasCenter: viewportController.getCanvasCenter,
        setNodes,
        setConnections,
        setDirectorNodeId,
        updateProject,
    });
    const { addDirectorReferenceToCanvas, createDirectorShot, openDirectorWorkbench } = director;

    useCanvasStarterNavigation({
        projectLoaded,
        searchParams,
        setSearchParams,
        containerRef,
        nodesRef,
        createNode,
        fitCanvasSelection,
        createDirectorShot,
        openAssistant: starterAssistantHandler(openAssistant),
    });

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
        getCanvasCenter: viewportController.getCanvasCenter,
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
    }, [clearCanvasFiles, deselectCanvas, message, nodesRef, projectId, resetForClearCanvas, setAngleNodeId, setAnnotationNodeId, setConnections, setCropNodeId, setEmotionNodeId, setLightingNodeId, setMaskEditNodeId, setNodes, setRunningNodeId]);

    useCanvasKeyboard({
        pageUi,
        projectId,
        enabled: canvasKeyboardEnabled({ projectLoaded, previewActive: Boolean(versions.preview), directorNodeId, folderBrowserNodeId: nodeEditor.folderBrowserNodeId }),
        onToggleAssistant: focusMode || !internalAssistantEnabled ? undefined : toggleAssistant,
        nodesRef,
        selectedNodeIdsRef,
        selectedConnectionId,
        setShortcutRequestNonce: shortcutRequestNonceSetter,
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
        beginBatchConnection: () => connectionController.beginBatchConnectionMode(Array.from(selectedNodeIdsRef.current)),
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

    const mediaShareActions = useCanvasNodeMediaShareActions({
        projectId,
        domainProjectId: currentProject?.projectId,
        localOnly,
        releaseCopiedNodesPastePriority,
        handleConfigNodeChange,
    });

    const contextMenuHandlers = useCanvasContextMenu({
        pageUi,
        projectId,
        selectedNodeIdsRef,
        screenToCanvas,
        closeConnectionCreateMenu: connectionController.closeConnectionCreateMenu,
    });

    const renderModelRef = useRef(renderModel);
    renderModelRef.current = renderModel;

    const renderCanvasNodePanel = useCallback((node: CanvasNodeData) => (
        <CanvasProjectNodePrompt
            node={node}
            projectId={projectId}
            videoModel={config.videoModel}
            document={document}
            dialogs={dialogs}
            renderModel={renderModelRef.current}
            generation={generation}
            nodeEditor={nodeEditor}
            pageUi={pageUi}
            referenceActions={referenceActions}
            onFocusNode={focusCanvasNode}
            onCreateReplacement={createGenerationReplacement}
            onNodeMouseDown={handleNodeMouseDown}
        />
    ), [projectId, config.videoModel, document, dialogs, generation, nodeEditor, pageUi, referenceActions, focusCanvasNode, createGenerationReplacement, handleNodeMouseDown]);

    const renderCanvasNodeContent = useCallback((node: CanvasNodeData) => (
        <CanvasProjectNodeContent
            node={node}
            projectId={projectId}
            readOnly={readOnly}
            theme={theme}
            viewportScale={viewport.k}
            document={document}
            dialogs={dialogs}
            renderModel={renderModelRef.current}
            generation={generation}
            nodeEditor={nodeEditor}
            mediaTools={mediaTools}
            connectionController={connectionController}
            uploads={uploads}
            workflowInstances={workflowInstances}
            pageUi={pageUi}
            nodeDropTargetId={nodeDropTargetId}
            directorScenes={currentProject?.directorScenes}
            onFocusImage={focusCanvasImageNode}
            onOpenDirector={openDirectorWorkbench}
            onOpenStory={openStoryInput}
            onNodeMouseDown={handleNodeMouseDown}
        />
    ), [projectId, readOnly, theme, viewport.k, document, dialogs, renderModel.configInputsById, generation, nodeEditor, mediaTools, connectionController, uploads, workflowInstances, pageUi, nodeDropTargetId, currentProject?.directorScenes, focusCanvasImageNode, openDirectorWorkbench, openStoryInput, handleNodeMouseDown]);

    const retryCanvasNode = useCallback(
        (node: CanvasNodeData) => {
            if (node.metadata?.workflowOperation?.id.endsWith(".ai-upscale")) {
                const processor = nodesRef.current.find((item) => item.id === node.metadata?.generatedFromProcessingNodeId);
                if (canRecoverManagedToolNode(node) || (!processor && node.metadata.taskClientOperationId)) void recoverAIUpscale(node).catch((error) => message.error(generationErrorMessage(error)));
                else if (processor && !canvasNodeFailureView(node).regenerateBlocked) void startUpscaleBatch(processor).catch((error) => message.error(generationErrorMessage(error)));
                else message.info("请在超分处理节点中查询原批次，暂勿重复提交");
                return;
            }
            if (isVideoSubtitleEraseNode(node)) {
                const sourceId = node.metadata?.videoSubtitleEraseSourceNodeId || node.metadata?.generatedFromNodeId;
                const source = nodesRef.current.find((item) => item.id === sourceId);
                if (canRecoverManagedToolNode(node)) void mediaTools.recoverVideoSubtitleErase(node).catch((error) => message.error(generationErrorMessage(error)));
                else if (source && !canvasNodeFailureView(node).regenerateBlocked) mediaTools.openVideoSubtitleErase(source);
                else setGenerationHistoryOpen(true);
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
        [generateScriptRows, handleRetryNode, mediaTools, message, nodesRef, reconcileImageBatchRootNode, retryDepthCaptureNode, retryImageBatchChildren, setGenerationHistoryOpen, recoverAIUpscale, startUpscaleBatch],
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
        [containerRef, fitCanvasSelection, message, nodesRef, selectedNodeIdsRef, setSelectedConnectionId, setSelectedNodeIds],
    );

    const activeTasksRef = useRef(activeTasks);
    activeTasksRef.current = activeTasks;
    const handleCancelNodeTask = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId) {
                const c = startGenerationRequest(node.id, node.id);
                c.abort();
                finishGenerationRequest(node.id, c);
                setRunningNodeId((id) => (id === node.id ? null : id));
                setNodes((list) => list.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content || item.metadata?.storageKey ? "success" : "idle", taskStage: undefined } } : item)));
                return;
            }
            try {
                const task = activeTasksRef.current.find((item) => item.id === taskId) ?? (await queryGenerationTask(taskId));
                cancelCanvasTask(task);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "读取任务失败");
            }
        },
        [cancelCanvasTask, finishGenerationRequest, message, setNodes, setRunningNodeId, startGenerationRequest],
    );
    const openCanvasNodeVersions = useCallback((node: CanvasNodeData) => setVersionCompareRootId(node.metadata?.versionOfNodeId || node.id), [setVersionCompareRootId]);
    const viewCanvasNodeImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), [setPreviewNodeId]);
    // Overview nodes reuse the DOM card handlers; native events carry the
    // fields those handlers read (button, modifiers, client coordinates).
    const handleLodNodePointerDown = useCallback((event: PointerEvent, nodeId: string) => {
        handleNodeMouseDown(event as unknown as ReactMouseEvent, nodeId);
    }, [handleNodeMouseDown]);
    const handleLodNodeContextMenu = useCallback((event: MouseEvent, nodeId: string) => {
        contextMenuHandlers.handleNodeContextMenu(event as unknown as ReactMouseEvent, nodeId);
    }, [contextMenuHandlers]);
    const handleLodNodeDoubleClick = useCallback((node: CanvasNodeData) => {
        if (!readOnly && node.type === CanvasNodeType.Frame && node.metadata?.frame?.collapsed && node.metadata?.folder) handleFrameToggle(node.id);
        else if (node.type === CanvasNodeType.Image && node.metadata?.content) viewCanvasNodeImage(node);
    }, [handleFrameToggle, readOnly, viewCanvasNodeImage]);
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
            onOpenMyAssets: () => timelineAssetInsert.openCanvasAssetLibrary(),
            onOpenProjectCharacters: () => timelineAssetInsert.openProjectAssets("character"),
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
            <CanvasFreeformEmptyState commands={freeformCreateCommands} onOpenAssistant={internalAssistantEnabled ? openAssistant : undefined} />
        ) : emptyStateKind === "linked" ? (
            <CanvasLinkedProjectEmptyState
                projectName={linkedProjectQuery.data?.project.name || workspaceProject?.title || "项目画布"}
                hasChapter={Boolean(linkedProjectQuery.data?.units.length)}
                onAddFirstChapter={() => {
                    const first = linkedProjectQuery.data?.units.slice().sort((left, right) => left.position - right.position)[0];
                    if (first) void handleProjectChapterInsert({ id: first.id, projectId: linkedProjectId, title: first.title, position: first.position });
                }}
                onOpenAssets={() => timelineAssetInsert.openProjectAssets()}
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

    return {
        styles,
        director,
        addDirectorReferenceToCanvas,
        createDirectorShot,
        openDirectorWorkbench,
        activateShortDramaStep,
        shortDramaGuide,
        skipShortDramaGuide,
        clearCanvas,
        pasteAtPosition,
        mediaShareActions,
        contextMenuHandlers,
        renderCanvasNodePanel,
        renderCanvasNodeContent,
        retryCanvasNode,
        locateAssistantNodes,
        handleCancelNodeTask,
        openCanvasNodeVersions,
        viewCanvasNodeImage,
        handleLodNodePointerDown,
        handleLodNodeContextMenu,
        handleLodNodeDoubleClick,
        locateProjectStyleNode,
        openFrameAnalysisOrCreate,
        emptyCanvasState,
    };
}
