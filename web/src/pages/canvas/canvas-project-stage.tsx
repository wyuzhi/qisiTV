import type { RefObject } from "react";

import { CanvasActiveTaskPanel } from "@/components/canvas/canvas-active-task-panel";
import { CanvasFileDropOverlay } from "@/components/canvas/canvas-file-drop-overlay";
import { CanvasFocusModeBar } from "@/components/canvas/canvas-focus-mode-bar";
import { CanvasLeaferGraphicsLayer } from "@/components/canvas/canvas-leafer-graphics-layer";
import { CanvasLodLayer } from "@/components/canvas/canvas-lod-layer";
import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { CanvasNodeGraphContext, type CanvasNodeGraphContextValue } from "@/components/canvas/canvas-node-graph-context";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import type { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import type { Asset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasWorkspaceMode } from "@/types/canvas";
import { CanvasProjectContextMenu } from "./canvas-project-context-menu";
import { CanvasProjectStageOverlays } from "./canvas-project-overlays";
import { CanvasProjectWorldLayers } from "./canvas-project-world-layers";
import { CanvasSyncStatus } from "./canvas-sync-status";
import type { CanvasWorkflowsHandle } from "./canvas-workflow-workspace";
import type { useCanvasVersionHistory } from "./canvas-version-history";
import type { useCanvasActiveTasks } from "./use-canvas-active-tasks";
import type { useCanvasDocumentState } from "./use-canvas-document-state";
import type { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import type { useCanvasHistory } from "./use-canvas-history";
import type { useCanvasPreferences } from "./use-canvas-preferences";
import type { useCanvasProjectActions } from "./use-canvas-project-actions";
import type { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import type { useCanvasProjectMediaAndSelection } from "./use-canvas-project-media-and-selection";
import type { useCanvasUpload } from "./use-canvas-upload";
import type { useCanvasViewportController } from "./use-canvas-viewport-controller";
import type { useCanvasViewportState } from "./use-canvas-viewport-state";

export type CanvasProjectStageProps = {
    projectId: string;
    currentProject?: CanvasProject;
    workspaceMode: CanvasWorkspaceMode;
    shortDramaEnabled: boolean;
    readOnly: boolean;
    assets: Asset[];
    effectiveConfig: AiConfig;
    searchParams: URLSearchParams;
    shortcutRequestNonce: number;
    pageUi: ReturnType<typeof createCanvasPageUiStore>;
    workflowsRef: RefObject<CanvasWorkflowsHandle | null>;
    versions: ReturnType<typeof useCanvasVersionHistory>;
    activeTasks: ReturnType<typeof useCanvasActiveTasks>["tasks"];
    historyState: ReturnType<typeof useCanvasHistory>["historyState"];
    undoCanvas: () => void;
    redoCanvas: () => void;
    reloadLatestCanvasProject: () => Promise<void>;
    openVersions: () => void;
    toggleVersions: () => void;
    nodeGraphContext: CanvasNodeGraphContextValue;
    preferences: ReturnType<typeof useCanvasPreferences>;
    viewportState: ReturnType<typeof useCanvasViewportState>;
    viewportController: ReturnType<typeof useCanvasViewportController>;
    document: ReturnType<typeof useCanvasDocumentState>;
    dialogs: ReturnType<typeof useCanvasProjectDialogs>;
    generation: ReturnType<typeof useCanvasGenerationOrchestration>;
    uploads: ReturnType<typeof useCanvasUpload>;
    mediaSelection: ReturnType<typeof useCanvasProjectMediaAndSelection>;
    actions: ReturnType<typeof useCanvasProjectActions>;
    askSelectedNodes: () => void;
};

export function CanvasProjectStage(props: CanvasProjectStageProps) {
    const {
        projectId,
        currentProject,
        workspaceMode,
        shortDramaEnabled,
        readOnly,
        effectiveConfig,
        searchParams,
        shortcutRequestNonce,
        pageUi,
        versions,
        activeTasks,
        historyState,
        undoCanvas,
        redoCanvas,
        reloadLatestCanvasProject,
        openVersions,
        toggleVersions,
        nodeGraphContext,
        preferences,
        viewportState,
        viewportController,
        document,
        dialogs,
        generation,
        uploads,
        mediaSelection,
        actions,
    } = props;
    const { containerRef, viewport } = viewportState;
    const { fitCanvasContent, handleCanvasDoubleClick, handleViewportChange, handleViewportPreviewChange, screenToCanvas, zoomCanvasIn, zoomCanvasOut } = viewportController;
    const { nodes } = document;
    const selectedNodeIds = pageUi((state) => state.selectedNodeIds);
    const selectedConnectionId = pageUi((state) => state.selectedConnectionId);
    const activeMediaNodeId = pageUi((state) => state.activeMediaNodeId);
    const setActiveMediaNodeId = pageUi((state) => state.setActiveMediaNodeId);
    const contextMenu = pageUi((state) => state.contextMenu);
    const setContextMenu = pageUi((state) => state.setContextMenu);
    const scriptScrollTopById = pageUi((state) => state.scriptScrollTopById);
    const {
        applyCanvasAppearance,
        backgroundMode,
        canvasAppearance,
        canvasTool,
        changeConnections,
        changeSnapToGrid,
        changeWheelBehavior,
        exitFocusMode,
        focusDockRevealed,
        focusMode,
        saveCanvasAppearanceDefault,
        setBackgroundMode,
        setCanvasTool,
        setFocusDockRevealed,
        setShowImageInfo,
        showConnections,
        showImageInfo,
        snapToGrid,
        theme,
        wheelBehavior,
    } = preferences;
    const {
        openTextNodeEditor,
        openDrawingNode,
        setClearConfirmOpen,
        setGenerationHistoryOpen,
        setInfoNodeId,
        setPreviewNodeId,
        setStylePickerOpen,
    } = dialogs;
    const {
        reloadCanvasNodeResource,
        replaceCanvasNodeMedia,
        timelineAssetInsert,
        mediaTools,
        cancelImageCrop,
        cancelAnnotation,
        cancelMaskEdit,
        cancelVideoCrop,
        nodeOperations,
        connectionController,
        batchSourceNodeIds,
        selectionController,
        toolbarHover,
        nodeEditor,
        linkedFolderPreviewNodesById,
        lodPinnedNodeIds,
        renderModel,
        renderedConnections,
        isCanvasNodeMoving,
        canvasNodeActions,
    } = mediaSelection;
    const {
        alignmentGuides,
        deselectCanvas,
        dragPreview,
        frameDropTargetId,
        handleCanvasMouseDown,
        handleNodeMouseDown,
        selectionBoundsElementRef,
        selectionBox,
    } = selectionController;
    const {
        activeNodeId,
        batchChildCountById,
        batchMotionById,
        contextMenuNode,
        frameChildrenById,
        lodActive,
        lodNodes,
        maskEditNode,
        mentionReferencesByNodeId,
        nodeById,
        reduceMediaEffects,
        relatedHighlight,
        resourceReferenceByNodeId,
        selectedNodeBounds,
        visibleNodes,
    } = renderModel;
    const {
        batchConnectionPreview,
        connectionApproach,
        connectionTargetAnchorRatio,
        connectionTargetNodeId,
        connectingParams,
        handleConnectStart,
        mouseWorld,
        startBatchConnection,
    } = connectionController;
    const {
        collapsingBatchIds,
        handleConfigNodeChange,
        handleFolderStyleChange,
        handleFolderThemeChange,
        handleFrameToggle,
        handleNodeContentChange,
        handleNodeResize,
        handleNodeTitleChange,
        openingBatchIds,
        saveNodeAsset,
        setBatchPrimary,
        toggleBatchExpanded,
        unpackFolder,
    } = nodeEditor;
    const {
        copyNodesToClipboard,
        copySelectedNodes,
        createFolder,
        createNode,
        deleteConnection,
        deleteNodes,
        duplicateNode,
        hasCopiedNodes,
        packSelectedIntoFolder,
        spreadSelectedNodes,
    } = nodeOperations;
    const {
        annotationNodeId,
        cropImageNode,
        cropNodeId,
        cropVideoNode,
        emotionNodeId,
        extractAudioFromVideo,
        inlineTrimRunning,
        maskEditImageNode,
        maskEditNodeId,
        saveAnnotatedImageNode,
        segmentRunningMode,
        videoCropNodeId,
    } = mediaTools;
    const {
        contextMenuHandlers,
        createDirectorShot,
        emptyCanvasState,
        handleCancelNodeTask,
        handleLodNodeContextMenu,
        handleLodNodeDoubleClick,
        handleLodNodePointerDown,
        mediaShareActions,
        openCanvasNodeVersions,
        openFrameAnalysisOrCreate,
        pasteAtPosition,
        renderCanvasNodeContent,
        retryCanvasNode,
        viewCanvasNodeImage,
    } = actions;

    return (
        <>
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
                                    nodeStackOrder={document.nodeStackOrder}
                                    selectedNodeIds={selectedNodeIds}
                                    pinnedNodeIds={lodPinnedNodeIds}
                                    theme={theme}
                                    onNodePointerDown={handleLodNodePointerDown}
                                    onNodeContextMenu={handleLodNodeContextMenu}
                                    onNodeDoubleClick={handleLodNodeDoubleClick}
                                    onHoverNodeChange={pageUi.getState().setLodHoverNodeId}
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
                        onContextMenu={contextMenuHandlers.handleCanvasContextMenu}
                        onDrop={uploads.handleDrop}
                        onFileDragEnter={uploads.handleFileDragEnter}
                        onFileDragLeave={uploads.handleFileDragLeave}
                        onFileDragOver={uploads.handleFileDragOver}
                    >
                        <CanvasNodeActionContext.Provider value={canvasNodeActions}>
                            <CanvasNodeGraphContext.Provider value={nodeGraphContext}>
                                <CanvasProjectWorldLayers
                                    containerRef={containerRef}
                                    connectionApproach={connectionApproach}
                                    projectId={projectId}
                                    readOnly={readOnly}
                                    viewportScale={viewport.k}
                                    displayConnections={renderedConnections}
                                    spotlightConnections={!showConnections}
                                    selectedConnectionId={selectedConnectionId}
                                    relatedConnectionIds={relatedHighlight.connectionIds}
                                    scriptScrollTopById={scriptScrollTopById}
                                    connectingParams={connectingParams}
                                    mouseWorld={mouseWorld}
                                    connectionTargetNodeId={connectionTargetNodeId}
                                    nodeById={nodeById}
                                    visibleNodes={visibleNodes}
                                    nodeStackOrder={document.nodeStackOrder}
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
                                    onConnectionSelect={contextMenuHandlers.handleConnectionSelect}
                                    onConnectionContextMenu={contextMenuHandlers.handleConnectionContextMenu}
                                    onNodeMouseDown={handleNodeMouseDown}
                                    onNodeHoverStart={toolbarHover.handleCanvasNodeHoverStart}
                                    onNodeHoverEnd={toolbarHover.handleCanvasNodeHoverEnd}
                                    onConnectStart={handleConnectStart}
                                    onNodeResize={handleNodeResize}
                                    onToggleFrame={handleFrameToggle}
                                    onUnpackFolder={unpackFolder}
                                    onFolderStyleChange={handleFolderStyleChange}
                                    onFolderThemeChange={handleFolderThemeChange}
                                    onNodeTitleChange={handleNodeTitleChange}
                                    onNodeContextMenu={contextMenuHandlers.handleNodeContextMenu}
                                    onNodeContentChange={handleNodeContentChange}
                                    onToggleBatch={toggleBatchExpanded}
                                    onSetBatchPrimary={setBatchPrimary}
                                    onRetry={retryCanvasNode}
                                    onReloadResource={reloadCanvasNodeResource}
                                    onOpenTaskDetails={generation.openNodeTaskDetails}
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

                    <CanvasActiveTaskPanel tasks={activeTasks} onCancelTask={generation.cancelCanvasTask} topInset={focusMode ? "var(--space-3)" : "var(--canvas-topbar-offset)"} />

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

                    <CanvasFileDropOverlay active={uploads.fileDropActive} theme={theme} />

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
                            onUpload={() => uploads.handleUploadRequest()}
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
                            onOpenMyAssets={() => timelineAssetInsert.openCanvasAssetLibrary()}
                            onOpenProjectCharacters={() => timelineAssetInsert.openProjectAssets("character")}
                            onOpenGenerationHistory={() => setGenerationHistoryOpen(true)}
                            shortcutRequestNonce={shortcutRequestNonce}
                        />
                    ) : null}
                </div>
            </div>

            <CanvasProjectStageOverlays
                currentProject={currentProject}
                workspaceMode={workspaceMode}
                readOnly={readOnly}
                assets={props.assets}
                searchParams={searchParams}
                pageUi={pageUi}
                workflowsRef={props.workflowsRef}
                preferences={preferences}
                viewportState={viewportState}
                viewportController={viewportController}
                document={document}
                dialogs={dialogs}
                generation={generation}
                uploads={uploads}
                mediaSelection={mediaSelection}
                actions={actions}
                askSelectedNodes={props.askSelectedNodes}
            />

            <CanvasProjectContextMenu
                menu={contextMenu}
                node={contextMenuNode}
                workspaceMode={workspaceMode}
                isProjectLinked={Boolean(currentProject?.projectId)}
                canUndo={historyState.canUndo}
                canRedo={historyState.canRedo}
                canPaste={hasCopiedNodes || Boolean(navigator.clipboard)}
                selectedCount={selectedNodeIds.size}
                nodes={nodes}
                selectedNodeIds={selectedNodeIds}
                screenToCanvas={screenToCanvas}
                onClose={() => setContextMenu(null)}
                onAddNode={(type, position) => createNode(type, position)}
                onAddFolder={createFolder}
                onChooseStyle={() => setStylePickerOpen(true)}
                onOpenDirector={(position) => createDirectorShot(position)}
                onUpload={(nodeId, position) => uploads.handleUploadRequest(nodeId, position)}
                onOpenAssets={timelineAssetInsert.openCanvasAssetLibrary}
                onOpenProjectCharacters={(position) => timelineAssetInsert.openProjectAssets("character", position)}
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
                onInfoNode={readOnly ? undefined : (node) => setInfoNodeId(node.id)}
                onEditText={openTextNodeEditor}
                onOpenDrawing={openDrawingNode}
                onGenerateImage={generation.generateImageFromTextNode}
                onCopyContent={(node) => void mediaShareActions.copyNodeContentToClipboard(node)}
                onCopyMediaUrl={(node) => void mediaShareActions.copyNodeMediaUrlToClipboard(node)}
                onUploadToArkPrivateAsset={mediaShareActions.confirmUploadNodeImageToArkPrivateAsset}
                onSetAssetCategory={readOnly ? undefined : (nodeId, assetCategory) => handleConfigNodeChange(nodeId, { assetCategory })}
                onToggleFrame={(node) => handleFrameToggle(node.id)}
                onUnpackFolder={unpackFolder}
                onSpreadSelection={spreadSelectedNodes}
                onPackSelectionToFolder={packSelectedIntoFolder}
                onCopySelection={copySelectedNodes}
                onDeleteSelection={() => deleteNodes(selectedNodeIds)}
                extractingAudio={segmentRunningMode === "audio"}
                trimmingVideo={inlineTrimRunning}
                onExtractAudioFromVideo={(node) => void extractAudioFromVideo(node)}
            />
        </>
    );
}
