import { useCallback, useEffect, useMemo, type MutableRefObject } from "react";
import type { SetURLSearchParams } from "react-router";
import type { App } from "antd";

import { batchSourceRestriction } from "@/lib/canvas/canvas-batch-connection";
import { resolveRenderedCanvasConnections } from "@/lib/canvas/canvas-connection-policy";
import { summarizeCanvasContext } from "@/lib/canvas/canvas-context-summary";
import type { DEFAULT_DRAWING_ENGINE } from "@/lib/canvas/canvas-drawing-engine";
import { linkedFolderPresentation } from "./canvas-resource-handoff-plan";
import { buildLinkedFolderPreviewNodes } from "@/lib/canvas/canvas-linked-folder-previews";
import { planUpscaleProcessingNode } from "@/lib/canvas/canvas-upscale-processor";
import {
    openCanvasGenerationInputEditor,
    resolveCanvasPromptEditTarget,
    revealCanvasTargetNode,
} from "@/lib/canvas/canvas-generation-failure-ux";
import { workflowDropSlot } from "@/lib/canvas/reusable-workflow-instance";
import { generationErrorMessage } from "@/lib/generation-error";
import { isCanvasPointerMoving, resolvePromptDialogNode } from "./canvas-pointer-chrome";
import { useCanvasConnectionController } from "./use-canvas-connection-controller";
import { useCanvasMediaTools } from "./use-canvas-media-tools";
import { useCanvasNodeClick } from "./use-canvas-node-click";
import { useCanvasNodeActions } from "./use-canvas-node-actions";
import { useCanvasNodeEditor } from "./use-canvas-node-editor";
import { useCanvasNodeOperations } from "./use-canvas-node-operations";
import { useCanvasNodeReferences } from "./use-canvas-node-references";
import { useCanvasNodeToolbarHover, useCanvasPointerSelectionChrome } from "./use-canvas-pointer-chrome";
import { useCanvasRenderModel } from "./use-canvas-render-model";
import { useCanvasResourceHandoff } from "./use-canvas-resource-handoff";
import { useCanvasSelectionController } from "./use-canvas-selection-controller";
import { useCanvasTimelineAssetInsert } from "./use-canvas-timeline-asset-insert";
import { useCanvasUpscaleBatch } from "./use-canvas-upscale-batch";
import type { useCanvasDocumentState } from "./use-canvas-document-state";
import type { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import type { useCanvasPreferences } from "./use-canvas-preferences";
import type { useCanvasProjectLifecycle } from "./use-canvas-project-lifecycle";
import type { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import type { useCanvasUpload } from "./use-canvas-upload";
import type { useCanvasViewportController } from "./use-canvas-viewport-controller";
import type { useCanvasViewportState } from "./use-canvas-viewport-state";
import type { useCanvasWorkflowInstances } from "./use-canvas-workflow-instances";
import type { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type MediaAndSelectionParams = {
    projectId: string;
    linkedProjectId: string;
    readOnly: boolean;
    canvasTitle: string;
    directorScenes?: CanvasProject["directorScenes"];
    addedSkills: ReturnType<typeof useCanvasProjectLifecycle>["addedSkills"];
    projectLoaded: boolean;
    mediaPerformanceMode: ReturnType<typeof useCanvasPreferences>["mediaPerformanceMode"];
    showConnections: boolean;
    snapToGrid: boolean;
    defaultDrawingEngine: typeof DEFAULT_DRAWING_ENGINE;
    assets: Asset[];
    assetsHydrated: boolean;
    effectiveConfig: AiConfig;
    searchParams: URLSearchParams;
    setSearchParams: SetURLSearchParams;
    pageUi: ReturnType<typeof createCanvasPageUiStore>;
    selectedNodeIds: Set<string>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    selectedConnectionId: string | null;
    hoveredNodeId: string | null;
    lodHoverNodeId: string | null;
    activeMediaNodeId: string | null;
    nodeImageSettingsOpen: boolean;
    contextMenu: ReturnType<ReturnType<typeof createCanvasPageUiStore>["getState"]>["contextMenu"];
    lodActiveRef: MutableRefObject<boolean>;
    lodEnterScaleRef: MutableRefObject<number>;
    historyPausedRef: MutableRefObject<boolean>;
    viewportState: ReturnType<typeof useCanvasViewportState>;
    viewportController: ReturnType<typeof useCanvasViewportController>;
    document: ReturnType<typeof useCanvasDocumentState>;
    dialogs: ReturnType<typeof useCanvasProjectDialogs>;
    generation: ReturnType<typeof useCanvasGenerationOrchestration>;
    uploads: ReturnType<typeof useCanvasUpload>;
    workflowInstances: ReturnType<typeof useCanvasWorkflowInstances>;
    keepConnectedNodeVisible: (node: CanvasNodeData) => void;
    cleanupCanvasFiles: (extra?: unknown) => void;
    message: ReturnType<typeof App.useApp>["message"];
};

export function useCanvasProjectMediaAndSelection({
    projectId,
    linkedProjectId,
    readOnly,
    canvasTitle,
    directorScenes,
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
}: MediaAndSelectionParams) {
    const { containerRef, viewport, viewportRef, virtualizationViewport, size } = viewportState;
    const { focusCanvasNode, getCanvasCenter, screenToCanvas } = viewportController;
    const { nodes, nodesRef, setNodes, connections, connectionsRef, setConnections, chatSessionsRef, bringNodeToFront, updateNodeFromContent, updateMediaNodeFromContent, updateNodeMetadataFromContent } = document;
    const {
        setDrawingNodeId,
        infoNodeId,
        previewNodeId,
        versionCompareRootId,
        directorNodeId,
        scriptEditorNodeId,
        clearDeletedNodeIds,
    } = dialogs;
    const dialogNodeId = pageUi((state) => state.dialogNodeId);
    const setDialogNodeId = pageUi((state) => state.setDialogNodeId);
    const setToolbarNodeId = pageUi((state) => state.setToolbarNodeId);
    const setSelectedNodeIds = pageUi((state) => state.setSelectedNodeIds);
    const scriptScrollTopById = pageUi((state) => state.scriptScrollTopById);
    const {
        applyGenerationTaskResult,
        bindGenerationTask,
        cancelNodeGeneration,
        finishGenerationRequest,
        setRunningNodeId,
        startGenerationRequest,
    } = generation;
    const {
        createAssetPayloadNodes,
        handleAssetsInsert,
        handleProjectAssetsInsert,
        handleUploadRequest,
        openAssetsAtPosition,
        startUploadStatus,
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
    const timelineAssetInsert = useCanvasTimelineAssetInsert({
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
        cropNodeId,
        recoverDepthCaptureNodes,
        videoCropNodeId,
        maskEditNodeId,
        upscaleNodeId,
        inlineTrimNodeId,
        segmentRunningMode,
        setAngleNodeId,
        setLightingNodeId,
        setEmotionNodeId,
        setAnnotationNodeId,
        setCropNodeId,
        setVideoCropNodeId,
        setMaskEditNodeId,
        clearDeletedNodes: clearDeletedMediaToolNodes,
    } = mediaTools;

    const bindUpscaleTask = useCallback((task: GenerationTask, nodeId: string) => bindGenerationTask(nodeId, task), [bindGenerationTask]);
    const { startUpscaleBatch } = useCanvasUpscaleBatch({
        pageUi,
        projectId,
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        prepareResource: prepareUpscaleResource,
        observeTask: observeAIUpscale,
        bindTask: bindUpscaleTask,
    });
    const createUpscaleProcessingNode = useCallback((source: CanvasNodeData) => {
        if (!source.metadata?.content && !source.metadata?.storageKey) {
            if (source.metadata?.workflowOperation?.id.endsWith(".ai-upscale")) void recoverAIUpscale(source).catch((error) => message.error(generationErrorMessage(error)));
            else message.warning("请先选择可读取的图片或视频");
            return;
        }
        const plan = planUpscaleProcessingNode(nodesRef.current, connectionsRef.current, source, selectedNodeIdsRef.current);
        connectionsRef.current = plan.connections;
        setConnections(plan.connections);
        setNodes((current) => [...current, plan.processor]);
        setSelectedNodeIds(new Set([plan.processor.id]));
        setDialogNodeId(null);
        setToolbarNodeId(null);
    }, [connectionsRef, message, nodesRef, recoverAIUpscale, selectedNodeIdsRef, setConnections, setDialogNodeId, setNodes, setSelectedNodeIds, setToolbarNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        const controller = new AbortController();
        recoverDepthCaptureNodes(controller.signal);
        return () => controller.abort();
    }, [projectId, projectLoaded, recoverDepthCaptureNodes]);

    const handleNodesDeleted = useCallback(
        (removedIds: Set<string>, nextNodes: CanvasNodeData[], _removedNodes: CanvasNodeData[]) => {
            void _removedNodes;
            const clearDeletedId = (current: string | null) => (current && removedIds.has(current) ? null : current);
            removedIds.forEach((id) => cancelNodeGeneration(id));
            clearDeletedNodeIds(removedIds);
            clearDeletedMediaToolNodes(removedIds);
            setRunningNodeId(clearDeletedId);
            cleanupCanvasFiles({ projectId, nodes: nextNodes, chatSessions: chatSessionsRef.current });
        },
        [
            cancelNodeGeneration,
            chatSessionsRef,
            cleanupCanvasFiles,
            clearDeletedMediaToolNodes,
            clearDeletedNodeIds,
            projectId,
            setRunningNodeId,
        ],
    );

    const nodeOperations = useCanvasNodeOperations({
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
    const {
        createFolder,
        deleteNodes,
        duplicateNode,
        duplicateNodesByDelta,
    } = nodeOperations;

    const referenceActions = useCanvasNodeReferences({ projectId, document, pageUi, uploads });
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
        onReplaceReference: referenceActions.handleReplaceNodeReference,
    });
    const {
        cancelPendingConnectionCreate,
        connectionTargetNodeId,
        connectingParams,
        handleBatchConnectionTargetClick,
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
    });

    const selectionController = useCanvasSelectionController({
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
        onAltDragDuplicate: duplicateNodesByDelta,
        onBatchConnectionTarget: handleBatchConnectionTargetClick,
        onLinkedFolderDrop: archiveNodesToLinkedFolder,
        onNodeDrop: workflowInstances.drop,
        onNodeDropTarget: (ids, point) => {
            const source = ids.length === 1 ? nodesRef.current.find((node) => node.id === ids[0]) : undefined;
            return source ? workflowDropSlot(nodesRef.current, source, point)?.id : undefined;
        },
        onDeselect: handleCanvasDeselect,
        snapToGrid,
    });
    const { dragPreview, isNodeDragging, nodeDraggingRef } = selectionController;

    const toolbarHover = useCanvasNodeToolbarHover({
        pageUi,
        projectId,
        nodeDraggingRef,
        nodeImageSettingsOpen,
    });

    const nodeEditor = useCanvasNodeEditor({
        pageUi,
        canvasId: projectId,
        canvasTitle,
        domainProjectId: linkedProjectId,
        readOnly,
        nodesRef,
        setNodes,
        openProjectAssets: timelineAssetInsert.openProjectAssets,
    });

    const handleProjectFolderInsert = useCallback(
        (folderId: string) => {
            const folder = linkedProjectQuery.data?.assetFolders.find((item) => item.id === folderId);
            if (!folder || !linkedProjectId) throw new Error("素材文件夹已不存在，请刷新后重试");
            const { style, theme } = linkedFolderPresentation(folder);
            createFolder(timelineAssetInsert.projectAssetInsertPosition, { id: folder.id, projectId: linkedProjectId, title: folder.name, style, theme, createdAt: folder.createdAt });
        },
        [createFolder, linkedProjectId, linkedProjectQuery.data?.assetFolders, timelineAssetInsert.projectAssetInsertPosition],
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
        collapsingBatchIds: nodeEditor.collapsingBatchIds,
        addedSkills,
        directorScenes,
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
        displayConnections,
        lodActive,
        lodEnterScale,
        nodeById,
    } = renderModel;
    lodActiveRef.current = lodActive;
    lodEnterScaleRef.current = lodEnterScale;
    const renderedConnections = useMemo(() => resolveRenderedCanvasConnections(displayConnections, showConnections, selectedNodeIds, selectedConnectionId), [displayConnections, selectedConnectionId, selectedNodeIds, showConnections]);
    const dialogNodeCandidate = dialogNodeId ? nodeById.get(dialogNodeId) || null : null;
    const dialogNode = resolvePromptDialogNode(dialogNodeCandidate);
    // dragPreview is published on the same pointer-down frame as isNodeDragging.
    // Treat either signal as moving so floating editors disappear before the
    // first preview transform is painted and never affect drag layout.
    const isCanvasNodeMoving = isCanvasPointerMoving(isNodeDragging, dragPreview);
    const inlineTrimNode = inlineTrimNodeId ? nodeById.get(inlineTrimNodeId) || null : null;
    const pendingConnectionSourceNode = connectionController.pendingConnectionCreate?.connection.handleType === "source" ? nodeById.get(connectionController.pendingConnectionCreate.connection.nodeId) : null;
    const canCreateDrawingFromConnection = !connectionController.pendingConnectionCreate?.batchSourceNodeIds?.length && pendingConnectionSourceNode?.type === CanvasNodeType.Image && Boolean(pendingConnectionSourceNode.metadata?.content);

    const { handleFrameToggle, toggleFrameCollapsed, toggleBatchExpanded } = nodeEditor;
    const locateCanvasNode = useCallback((nodeId: string) => {
        revealCanvasTargetNode(nodeId, {
            nodes: nodesRef.current,
            readOnly,
            focusCanvasNode,
            toggleFrameCollapsed,
            handleFrameToggle,
            toggleBatchExpanded,
        });
    }, [focusCanvasNode, handleFrameToggle, nodesRef, readOnly, toggleBatchExpanded, toggleFrameCollapsed]);

    const canEditGenerationInput = useCallback(
        (node: CanvasNodeData) => !readOnly && Boolean(resolveCanvasPromptEditTarget(node, nodesRef.current, connectionsRef.current)),
        [connectionsRef, nodesRef, readOnly],
    );

    const editGenerationInput = useCallback((node: CanvasNodeData) => {
        openCanvasGenerationInputEditor(node, {
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            readOnly,
            focusCanvasNode,
            toggleFrameCollapsed,
            handleFrameToggle,
            toggleBatchExpanded,
            setDialogNodeId,
        });
    }, [connectionsRef, focusCanvasNode, handleFrameToggle, nodesRef, readOnly, setDialogNodeId, toggleBatchExpanded, toggleFrameCollapsed]);

    const canvasNodeActions = useCanvasNodeActions({
        pageUi,
        replaceCanvasNodeMedia,
        downloadNodeImage: nodeEditor.downloadNodeImage,
        duplicateNode,
        deleteNodes,
        updateNodeMetadataFromContent,
        updateNodeFromContent,
        updateMediaNodeFromContent,
        addPanoramaCaptureNode: mediaTools.addPanoramaCaptureNode,
        startUpscaleBatch,
        recoverAIUpscale,
        stepImageHistory: readOnly ? undefined : nodeEditor.stepNodeHistoryImage,
        restorePreviousHistoryImage: readOnly ? undefined : nodeEditor.restorePreviousNodeHistoryImage,
        focusNode: locateCanvasNode,
        editGenerationInput: readOnly ? undefined : editGenerationInput,
        canEditGenerationInput: readOnly ? undefined : canEditGenerationInput,
    });

    const cancelImageCrop = useCallback(() => setCropNodeId(null), [setCropNodeId]);
    const cancelAnnotation = useCallback(() => setAnnotationNodeId(null), [setAnnotationNodeId]);
    const cancelMaskEdit = useCallback(() => setMaskEditNodeId(null), [setMaskEditNodeId]);
    const cancelVideoCrop = useCallback(() => setVideoCropNodeId(null), [setVideoCropNodeId]);

    return {
        replaceCanvasNodeMedia,
        reloadCanvasNodeResource,
        linkedProjectQuery,
        canvasContext,
        timelineAssetInsert,
        mediaTools,
        startUpscaleBatch,
        createUpscaleProcessingNode,
        setAngleNodeId,
        setLightingNodeId,
        setEmotionNodeId,
        cancelImageCrop,
        cancelAnnotation,
        cancelMaskEdit,
        cancelVideoCrop,
        nodeOperations,
        referenceActions,
        connectionController,
        batchSourceNodeIds,
        selectionController,
        toolbarHover,
        nodeEditor,
        handleProjectFolderInsert,
        linkedFolderPreviewNodesById,
        lodPinnedNodeIds,
        renderModel,
        renderedConnections,
        dialogNode,
        isCanvasNodeMoving,
        inlineTrimNode,
        canCreateDrawingFromConnection,
        canvasNodeActions,
    };
}
