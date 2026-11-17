import { ArrowLeftRight } from "lucide-react";

import { localAssetToInsertPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasAssetTray } from "@/components/canvas/canvas-asset-tray";
import { CanvasEmotionWorkspace } from "@/components/canvas/canvas-emotion-workspace";
import { CanvasNodeAnglePanel } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeLightingPanel } from "@/components/canvas/canvas-node-lighting-dialog";
import { CanvasNodeToolbar } from "@/components/canvas/canvas-node-toolbar";
import { CanvasOverlayLayerContainer } from "@/components/canvas/canvas-overlay-layer";
import { CanvasVideoInlineTrimOverlay } from "@/components/canvas/canvas-video-inline-trim";
import { CanvasConnectionCreateMenu, CanvasNodePanelOverlay } from "@/components/canvas/canvas-workspace-overlays";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import type { CanvasImageEmotionPayload } from "@/components/canvas/canvas-node-emotion-panel";
import { AppModal } from "@/components/ui/product/app-modal";
import { isCanvasImageSourceNode } from "@/lib/canvas/canvas-image-source";
import { isFileUploadOverlayActive } from "@/lib/canvas/canvas-file-upload";
import { isCanvasMediaResultNode } from "@/lib/canvas/canvas-node-semantics";
import { CanvasNodeType } from "@/types/canvas";
import { CanvasProjectSelectionToolbar } from "./canvas-project-selection-toolbar";
import type { CanvasProjectStageProps } from "./canvas-project-stage";

export type CanvasProjectStageOverlaysProps = Pick<
    CanvasProjectStageProps,
    | "currentProject"
    | "workspaceMode"
    | "readOnly"
    | "assets"
    | "searchParams"
    | "pageUi"
    | "workflowsRef"
    | "preferences"
    | "viewportState"
    | "viewportController"
    | "document"
    | "dialogs"
    | "generation"
    | "uploads"
    | "mediaSelection"
    | "actions"
    | "askSelectedNodes"
>;

export function CanvasProjectStageOverlays(props: CanvasProjectStageOverlaysProps) {
    const {
        currentProject,
        workspaceMode,
        readOnly,
        assets,
        searchParams,
        pageUi,
        workflowsRef,
        preferences,
        viewportState,
        viewportController,
        document,
        dialogs,
        generation,
        uploads,
        mediaSelection,
        actions,
        askSelectedNodes,
    } = props;
    const { containerRef, viewport, size } = viewportState;
    const { fitCanvasContent, handleViewportChange, previewViewport, setZoomScale } = viewportController;
    const { nodes } = document;
    const selectedNodeIds = pageUi((state) => state.selectedNodeIds);
    const nodeImageSettingsOpen = pageUi((state) => state.nodeImageSettingsOpen);
    const setDialogNodeId = pageUi((state) => state.setDialogNodeId);
    const {
        changeSnapToGrid,
        focusMode,
        isMiniMapOpen,
        showConnections,
        snapToGrid,
        toggleConnections,
        toggleMiniMap,
    } = preferences;
    const {
        openTextNodeEditor,
        setInfoNodeId,
        setPreviewNodeId,
        setSubtitleNodeId,
        setTimelineNodeId,
        textEditorNodeId,
    } = dialogs;
    const {
        mediaTools,
        createUpscaleProcessingNode,
        setAngleNodeId,
        setLightingNodeId,
        setEmotionNodeId,
        nodeOperations,
        connectionController,
        selectionController,
        toolbarHover,
        nodeEditor,
        renderModel,
        dialogNode,
        isCanvasNodeMoving,
        inlineTrimNode,
        canCreateDrawingFromConnection,
    } = mediaSelection;
    const { dragPreview, isNodeDragging, selectionBoundsElementRef, selectionBox } = selectionController;
    const {
        angleNode,
        canvasImageNodes,
        emotionNode,
        lightingNode,
        selectedNodeBounds,
        selectedVideoNodes,
        toolbarNode,
    } = renderModel;
    const {
        beginBatchConnectionMode,
        cancelPendingConnectionCreate,
        connectionReplaceHover,
        createConnectedNode,
        getConnectionCreateDisabledReason,
        openQuickConnectionMenu,
        pendingConnectionCreate,
    } = connectionController;
    const {
        downloadNodeImage,
        handleFontSizeChange,
        saveNodeAsset,
        toggleNodeFreeResize,
    } = nodeEditor;
    const {
        alignSelectedNodes,
        arrangeSelectedNodes,
        createReferenceGroup,
        createStoryboardGroup,
        deleteNodes,
        packSelectedIntoFolder,
        toggleNodeLocked,
    } = nodeOperations;
    const {
        angleNodeId,
        annotationNodeId,
        closeInlineVideoTrim,
        confirmInlineVideoTrim,
        depthCaptureNode,
        emotionNodeId,
        extractAudioFromVideo,
        extractVideoFrameAt,
        extractingVideoFramesNodeId,
        generateAngleNode,
        generateEmotionNode,
        generateLightingNode,
        inlineTrimRunning,
        maskEditNodeId,
        mergeSelectedVideos,
        mergeVideoProgress,
        openInlineVideoTrim,
        openPanoramaConfig,
        openPortraitTextureEditor,
        openVideoCrop,
        segmentRunningMode,
        setAnnotationNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setUpscaleNodeId,
        splitImageNode,
    } = mediaTools;
    const { renderCanvasNodePanel, retryCanvasNode } = actions;

    return (
        <>
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
            !isFileUploadOverlayActive(dialogNode.metadata) &&
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
                    onPackToFolder={packSelectedIntoFolder}
                    onCreateStoryboard={createStoryboardGroup}
                    onCreateReferenceGroup={createReferenceGroup}
                    onBatchConnect={() => beginBatchConnectionMode(Array.from(selectedNodeIds))}
                    onMergeVideos={() => void mergeSelectedVideos()}
                    onAskAssistant={askSelectedNodes}
                    onSaveWorkflow={readOnly ? undefined : () => workflowsRef.current?.saveSelection()}
                />
            ) : null}

            <CanvasNodeToolbar
                node={isCanvasNodeMoving || nodeImageSettingsOpen || annotationNodeId || maskEditNodeId || emotionNodeId || angleNodeId || (dialogNode && !isCanvasMediaResultNode(dialogNode)) || textEditorNodeId ? null : toolbarNode}
                workspaceMode={workspaceMode}
                viewport={viewport}
                containerRef={containerRef}
                onKeep={toolbarHover.keepNodeToolbar}
                onLeave={toolbarHover.hideNodeToolbar}
                onInfo={(node) => (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId ? openTextNodeEditor(node) : setInfoNodeId(node.id))}
                onEditText={openTextNodeEditor}
                onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                onGenerateImage={generation.generateImageFromTextNode}
                onUpload={(node) => uploads.handleUploadRequest(node.id)}
                onDownload={downloadNodeImage}
                onSaveAsset={(node) => void saveNodeAsset(node)}
                onAnnotate={(node) => setAnnotationNodeId(node.id)}
                onMaskEdit={(node) => { setDialogNodeId(null); setMaskEditNodeId(node.id); }}
                onEmotion={(node) => { setDialogNodeId(null); setEmotionNodeId((current) => (current === node.id ? null : node.id)); }}
                onPortraitTexture={openPortraitTextureEditor}
                onCrop={(node) => node.type === CanvasNodeType.Video ? openVideoCrop(node) : setCropNodeId(node.id)}
                onSplit={(node, params) => void splitImageNode(node, params)}
                onUpscale={(node) => setUpscaleNodeId(node.id)}
                onSuperResolve={createUpscaleProcessingNode}
                onDraftToFinal={generation.generateFinalVideoFromDraftNode}
                onVideoEditOperation={generation.createVideoEditNodeFromVideo}
                onAngle={(node) => { setDialogNodeId(null); setAngleNodeId((current) => (current === node.id ? null : node.id)); }}
                onLighting={(node) => { setDialogNodeId(null); setLightingNodeId((current) => (current === node.id ? null : node.id)); }}
                onPanorama={openPanoramaConfig}
                onViewImage={(node) => setPreviewNodeId(node.id)}
                onExtractVideoFrames={extractVideoFrameAt}
                onExtractAudioFromVideo={(node) => void extractAudioFromVideo(node)}
                // 视频剪辑使用视频节点下方的内嵌时间轴，不再打开旧的片段重拍弹窗。
                onTrimVideoSegments={openInlineVideoTrim}
                onSubtitleErase={mediaTools.openVideoSubtitleErase}
                onDepthCapture={(node) => void depthCaptureNode(node)}
                onSubtitles={(node) => setSubtitleNodeId(node.id)}
                onTimeline={(node) => setTimelineNodeId(node.id)}
                extractingVideoFrames={toolbarNode?.id === extractingVideoFramesNodeId}
                extractingAudio={segmentRunningMode === "audio"}
                trimmingVideo={inlineTrimRunning}
                onReversePrompt={mediaTools.createImageReversePromptNodes}
                onRetry={retryCanvasNode}
                onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                onToggleLocked={(node) => toggleNodeLocked(node.id)}
                onQuickReference={readOnly ? undefined : (node) => openQuickConnectionMenu(node, "source")}
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
                        onInsertAsset={(asset) => void uploads.handleAssetsInsert([localAssetToInsertPayload(asset)])}
                        onFocusCanvasImage={viewportController.focusCanvasImageNode}
                    />
                    <CanvasZoomControls
                        scale={viewport.k}
                        libtvChrome={searchParams.get("libtvChrome") === "1"}
                        containerRef={containerRef}
                        onScaleChange={setZoomScale}
                        onFitContent={fitCanvasContent}
                        onAutoArrange={nodeOperations.autoArrangeCanvasNodes}
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
        </>
    );
}
