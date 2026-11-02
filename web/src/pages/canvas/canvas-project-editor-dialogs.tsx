import { lazy, Suspense, type MutableRefObject } from "react";
import { App } from "antd";
import { syncNodeSubtitlesToTimeline } from "@/lib/timeline/timeline-build";
import { CanvasNodeType } from "@/types/canvas";
import type { useCanvasDocumentState } from "./use-canvas-document-state";
import type { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import type { useCanvasRenderModel } from "./use-canvas-render-model";
import type { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import type { useCanvasNodeEditor } from "./use-canvas-node-editor";
import type { useCanvasMediaTools } from "./use-canvas-media-tools";
import type { useCanvasDirector } from "./use-canvas-director";
import type { useCanvasStyleWorkflow } from "./use-canvas-style-workflow";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { AiArtCritiqueModal } from "@/components/canvas/art-critique/ai-art-critique-modal";
import { CanvasCharacterReferenceModal } from "@/components/canvas/canvas-character-reference-modal";
import type { uploadImage } from "@/services/image-storage";
import { CanvasGenerationHistoryPicker } from "@/components/canvas/canvas-generation-history-picker";
import { CanvasNodeInfoModal } from "@/components/canvas/canvas-node-toolbar";
import { CanvasNodeSearchModal } from "@/components/canvas/canvas-node-search-modal";
import { CanvasPanoramaConfigModal, type PanoramaGenerateConfig } from "@/components/canvas/canvas-panorama-config-modal";
import { CanvasProjectAssetModal } from "@/components/canvas/canvas-project-asset-modal";
import { CanvasScriptEditor } from "@/components/canvas/canvas-script-node";
import { CanvasStylePickerModal } from "@/components/canvas/canvas-style-picker-modal";
import { CanvasSubtitleDialog } from "@/components/canvas/canvas-subtitle-dialog";
import { CanvasTextEditorModal } from "@/components/canvas/canvas-text-editor-modal";
import { CanvasTimelineDialog } from "@/components/canvas/canvas-timeline-dialog";
import { CanvasVersionCompareModal } from "@/components/canvas/canvas-version-compare-modal";
import { CanvasVideoFrameDialog } from "@/components/canvas/canvas-video-frame-dialog";
import type { CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import type { CanvasVideoFrameParams } from "@/components/canvas/canvas-video-frame-dialog";
import { WorkspaceState } from "@/components/layout/workspace-state";
import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import { canvasThemes } from "@/lib/canvas-theme";
import type { ProjectDetail } from "@/services/api/projects";
import type { AiConfig } from "@/stores/use-config-store";
import { type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type ViewportTransform } from "@/types/canvas";
import type { TimelineDirectMedia, TimelineProject } from "@/types/timeline";

import { LibTVImportDialog } from "./components/libtv-import-dialog";
import { TapNowImportDialog } from "./components/tapnow-import-dialog";
import { CanvasProjectMediaDialogs } from "./canvas-project-media-dialogs";
import { CanvasProjectStatusDialogs } from "./canvas-project-status-dialogs";

const CanvasDirectorWorkbench = lazy(() => import("@/components/canvas/director/canvas-director-workbench").then((module) => ({ default: module.CanvasDirectorWorkbench })));
const CanvasDrawingEditorModal = lazy(() => import("@/components/canvas/canvas-drawing-editor-modal").then((module) => ({ default: module.CanvasDrawingEditorModal })));

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export type CanvasProjectEditorDialogsProps = {
    projectId: string;
    theme: CanvasTheme;
    config: AiConfig;
    document: ReturnType<typeof useCanvasDocumentState>;
    dialogs: ReturnType<typeof useCanvasProjectDialogs>;
    renderModel: ReturnType<typeof useCanvasRenderModel>;
    generation: ReturnType<typeof useCanvasGenerationOrchestration>;
    nodeEditor: ReturnType<typeof useCanvasNodeEditor>;
    mediaTools: ReturnType<typeof useCanvasMediaTools>;
    styles: ReturnType<typeof useCanvasStyleWorkflow>;
    director: ReturnType<typeof useCanvasDirector>;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    onFocusNode: (nodeId: string) => void;
    onSearchFocusNode: (nodeId: string) => void;
    imports: {
        onApplyLibTV: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => Promise<void>;
        onApplyTapNow: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => Promise<void>;
    };
    timeline: {
        project: TimelineProject | null;
        onSave: (next: TimelineProject) => void | Promise<void>;
        onUpdate: (next: TimelineProject) => void;
        onOpenAssetLibrary: () => void;
        onOpenProjectAssets: () => void;
        onUploadLocalFiles: (files: File[]) => Promise<TimelineDirectMedia[]>;
        addNodeToTimelineRef: MutableRefObject<((node: CanvasNodeData) => void) | null>;
        addMediaToTimelineRef: MutableRefObject<((media: TimelineDirectMedia) => void) | null>;
        onCreateAssembledNode: (blob: Blob, title: string) => Promise<CanvasNodeData | null>;
    };
    directorOnboardingScope: string;
    onDeleteNodes: (nodeIds: Set<string>) => void;
    onAddDirectorImage: (image: Awaited<ReturnType<typeof uploadImage>>, title: string, signal: AbortSignal) => Promise<{ assetId?: string; persisted?: boolean } | void>;
    onFlush: () => void | Promise<void>;
    onClearCanvas: () => void;
    onSetPrimaryVersion: (nodeId: string) => void;
    assets: {
        pickerOpen: boolean;
        multiple: boolean;
        onInsertLibrary: (payloads: InsertAssetPayload[]) => void | Promise<void>;
        onClosePicker: () => void;
        projectOpen: boolean;
        detail?: ProjectDetail;
        initialCategory?: string;
        initialFolderId?: string;
        onCloseProject: () => void;
        onInsertProject: (payloads: InsertAssetPayload[]) => void | Promise<void>;
        onInsertFolder?: (folderId: string) => Promise<void> | void;
    };
};

export function CanvasProjectEditorDialogs({
    projectId, theme, config, document, dialogs, renderModel, generation,
    nodeEditor, mediaTools, styles, director, viewport, viewportSize, onFocusNode, onSearchFocusNode,
    imports, timeline, directorOnboardingScope, onDeleteNodes, onAddDirectorImage,
    onFlush, onClearCanvas, onSetPrimaryVersion, assets,
}: CanvasProjectEditorDialogsProps) {
    const { message } = App.useApp();
    const { nodes, connections, setNodes } = document;
    const { nodeById, infoNode, previewNode, activeScriptNode, activeDirectorScene, versionCompareNodes } = renderModel;
    const findNode = (id: string | null) => id ? nodeById.get(id) || null : null;
    const subtitleNode = findNode(dialogs.subtitleNodeId);
    const timelineNode = findNode(dialogs.timelineNodeId);
    const frameNode = findNode(mediaTools.frameDialogNodeId);
    const characterNode = findNode(dialogs.characterReferenceNodeId);
    const textNode = findNode(dialogs.textEditorNodeId);
    const drawingNode = findNode(dialogs.drawingNodeId);
    const artCritiqueNode = findNode(dialogs.artCritiqueNodeId);
    const artCritiqueInputs = artCritiqueNode
        ? connections.filter(connection => connection.toNodeId === artCritiqueNode.id)
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(connection => nodeById.get(connection.fromNodeId))
            .filter((node): node is CanvasNodeData => Boolean(node))
        : [];
    const saveText = (nodeId: string, title: string, content: string, richText: Record<string, unknown>) => {
        setNodes(current => current.map(node => node.id === nodeId ? { ...node, title, metadata: { ...node.metadata, content, richText } } : node));
    };
    const saveDrawing = (nodeId: string, summary: { engine: CanvasDrawingEngine; revision: number; updatedAt: string; shapeCount: number; pageCount: number }) => {
        setNodes(current => current.map(node => node.id === nodeId ? { ...node, metadata: { ...node.metadata,
            drawingEngine: summary.engine, drawingRevision: summary.revision, drawingUpdatedAt: summary.updatedAt,
            drawingShapeCount: summary.shapeCount, drawingPageCount: summary.pageCount,
        } } : node));
        message.success("绘图已保存");
    };
    const saveSubtitles = (nodeId: string, patch: Partial<CanvasNodeMetadata>) => {
        nodeEditor.handleConfigNodeChange(nodeId, patch);
        if (timeline.project) {
            const next = syncNodeSubtitlesToTimeline(timeline.project, nodeId, patch.subtitleEntries || []);
            if (next !== timeline.project) timeline.onUpdate(next);
        }
    };
    return (
        <>
            <CanvasNodeSearchModal open={dialogs.nodeSearchOpen} nodes={nodes} onClose={() => dialogs.setNodeSearchOpen(false)} onFocus={onSearchFocusNode} />
            <CanvasGenerationHistoryPicker projectId={projectId} open={dialogs.generationHistoryOpen} onClose={() => dialogs.setGenerationHistoryOpen(false)} onSelect={task => void generation.insertGenerationHistoryTask(task)} />
            <LibTVImportDialog open={dialogs.libTVImportOpen} projectId={projectId} viewport={viewport} viewportSize={viewportSize} onClose={() => dialogs.setLibTVImportOpen(false)} onApply={imports.onApplyLibTV} />
            <TapNowImportDialog open={dialogs.tapNowImportOpen} projectId={projectId} viewport={viewport} viewportSize={viewportSize} onClose={() => dialogs.setTapNowImportOpen(false)} onApply={imports.onApplyTapNow} />
            <CanvasStylePickerModal open={dialogs.stylePickerOpen} value={renderModel.activeStylePresetId} applying={styles.styleApplying} onClose={() => dialogs.setStylePickerOpen(false)} onSelect={styles.selectCanvasStyle} />
            <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => dialogs.setInfoNodeId(null)} onMetadataChange={nodeEditor.handleConfigNodeChange} />
            {subtitleNode ? <CanvasSubtitleDialog node={subtitleNode} open={Boolean(subtitleNode)} projectId={projectId} config={config} onClose={() => dialogs.setSubtitleNodeId(null)} onSave={saveSubtitles} /> : null}
            {frameNode ? <CanvasVideoFrameDialog node={frameNode} open={Boolean(frameNode)} onClose={mediaTools.closeFrameDialog} onConfirm={params => { if (frameNode) void mediaTools.extractVideoFrames(frameNode, params); }} /> : null}
            {timelineNode ? (
                <CanvasTimelineDialog
                    node={timelineNode}
                    open={Boolean(timelineNode)}
                    nodes={nodes}
                    timeline={timeline.project}
                    onClose={() => dialogs.setTimelineNodeId(null)}
                    onOpenSubtitleDialog={nodeId => { dialogs.setTimelineNodeId(null); dialogs.setSubtitleNodeId(nodeId); }}
                    onSave={timeline.onSave}
                    onSaveSubtitles={(nodeId, entries) => nodeEditor.handleConfigNodeChange(nodeId, { subtitleEntries: entries, ...(entries.length ? {} : { subtitleHighlights: [] }), subtitleUpdatedAt: new Date().toISOString() })}
                    onOpenAssetLibrary={timeline.onOpenAssetLibrary}
                    onOpenProjectAssets={timeline.onOpenProjectAssets}
                    onUploadLocalFiles={timeline.onUploadLocalFiles}
                    addNodeToTimelineRef={timeline.addNodeToTimelineRef}
                    addMediaToTimelineRef={timeline.addMediaToTimelineRef}
                    onCreateAssembledNode={timeline.onCreateAssembledNode}
                />
            ) : null}
            <CanvasCharacterReferenceModal node={characterNode} open={Boolean(characterNode)} onClose={() => dialogs.setCharacterReferenceNodeId(null)} />
            <CanvasTextEditorModal node={textNode} open={Boolean(textNode)} onClose={() => dialogs.setTextEditorNodeId(null)} onSave={saveText} />
            {drawingNode ? (
                <Suspense
                    fallback={
                        <div className="fixed inset-0 z-[var(--z-toast)] grid place-items-center px-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
                            <WorkspaceState icon="loading" title="正在加载绘图编辑器" description="正在准备绘图画布。" />
                        </div>
                    }
                >
                    <CanvasDrawingEditorModal node={drawingNode} projectId={projectId} open={Boolean(drawingNode)} onClose={() => dialogs.setDrawingNodeId(null)} onSaved={saveDrawing} />
                </Suspense>
            ) : null}
            <AiArtCritiqueModal
                startRequestId={dialogs.artCritiqueStartRequest?.nodeId === artCritiqueNode?.id ? dialogs.artCritiqueStartRequest?.id : undefined}
                restartRequested={Boolean(dialogs.artCritiqueStartRequest?.nodeId === artCritiqueNode?.id && dialogs.artCritiqueStartRequest?.restart)}
                onRunningChange={running => { dialogs.artCritiqueRunningRef.current = running; }}
                node={artCritiqueNode}
                upstreamNodes={artCritiqueInputs}
                open={Boolean(artCritiqueNode)}
                onClose={() => dialogs.setArtCritiqueNodeId(null)}
                onUpdateState={(nodeId, state) => nodeEditor.handleConfigNodeChange(nodeId, { artCritique: state })}
            />
            <CanvasPanoramaConfigModal
                open={Boolean(mediaTools.panoramaConfigNodeId)}
                onCancel={() => mediaTools.setPanoramaConfigNodeId(null)}
                onConfirm={(prompt, config) => { const node = findNode(mediaTools.panoramaConfigNodeId); if (node) mediaTools.createPanoramaViewerWithConfig(node, prompt, config); }}
                onCopyPrompt={prompt => { void navigator.clipboard?.writeText(prompt).then(() => message.success("已复制全景提示词")); }}
                previewImageUrl={mediaTools.panoramaConfigNodeId ? nodes.find((node) => node.id === mediaTools.panoramaConfigNodeId)?.metadata?.content : undefined}
                nodes={nodes}
            />
            <CanvasScriptEditor
                node={activeScriptNode}
                nodes={nodes}
                open={Boolean(activeScriptNode)}
                onClose={() => dialogs.setScriptEditorNodeId(null)}
                onUpdateRows={rows => { if (activeScriptNode) generation.replaceScriptRows(activeScriptNode.id, rows); }}
                onVisibleColumnsChange={visibleColumns => { if (!activeScriptNode || !visibleColumns.length) return; setNodes(current => current.map(node => node.id === activeScriptNode.id ? { ...node, metadata: { ...node.metadata, storyboardVisibleColumnsCustomized: true, storyboard: { rows: node.metadata?.storyboard?.rows || [], visibleColumns, referenceNodeIds: node.metadata?.storyboard?.referenceNodeIds || [] } } } : node)); }}
                onGenerateImages={rowIds => { if (activeScriptNode) void generation.generateScriptImages(activeScriptNode.id, rowIds); }}
                onGenerateVideos={rowIds => { if (!activeScriptNode) return; if (activeScriptNode.metadata?.storyboardVideoInputMode === "keyframe") void generation.generateScriptVideos(activeScriptNode.id, rowIds); else void generation.createAndGenerateScriptVideos(activeScriptNode.id, rowIds); }}
                onVideoInputModeChange={storyboardVideoInputMode => { if (activeScriptNode) nodeEditor.handleConfigNodeChange(activeScriptNode.id, { storyboardVideoInputMode }); }}
            />
            {dialogs.directorNodeId && activeDirectorScene ? (
                <Suspense
                    fallback={
                        <div className="fixed inset-0 z-[var(--z-toast)] grid place-items-center px-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
                            <WorkspaceState icon="loading" title="正在加载 3D 导演台" description="准备场景、镜头与空间控制。" />
                        </div>
                    }
                >
                    <CanvasDirectorWorkbench
                        open
                        scene={activeDirectorScene}
                        projectId={projectId}
                        imageNodes={nodes.filter(node => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content))}
                        onClose={() => dialogs.setDirectorNodeId(null)}
                        onChange={director.saveDirectorScene}
                        onApply={director.applyDirectorOutput}
                        onShouldCaptureCover={director.shouldCaptureCover}
                        onCaptureCover={director.captureDirectorCover}
                        onDeleteImageNode={nodeId => onDeleteNodes(new Set([nodeId]))}
                        onAddCanvasImage={onAddDirectorImage}
                        onFlush={onFlush}
                        onboardingScope={directorOnboardingScope}
                    />
                </Suspense>
            ) : null}
            <CanvasVersionCompareModal open={Boolean(dialogs.versionCompareRootId)} versions={versionCompareNodes} onClose={() => dialogs.setVersionCompareRootId(null)} onSetPrimary={onSetPrimaryVersion} onFocus={nodeId => { dialogs.setVersionCompareRootId(null); onFocusNode(nodeId); }} />
            <CanvasProjectMediaDialogs upscaleNode={renderModel.upscaleNode} onCloseUpscale={() => mediaTools.setUpscaleNodeId(null)} onUpscale={(node, params) => void mediaTools.upscaleImageNode(node, params)} config={config} />
            <CanvasProjectStatusDialogs
                theme={theme}
                task={generation.taskDetail}
                taskLogs={generation.taskDetailLogs}
                taskLoading={generation.taskDetailLoading}
                taskError={generation.taskDetailError}
                onCloseTask={() => generation.setTaskDetail(null)}
                onCancelTask={generation.cancelCanvasTask}
                onRetrieveTask={task => void generation.retrieveTaskResult(task)}
                retrievingTaskId={generation.retrievingTaskId}
                previewNode={previewNode}
                onClosePreview={() => dialogs.setPreviewNodeId(null)}
                clearConfirmOpen={dialogs.clearConfirmOpen}
                onCancelClear={() => dialogs.setClearConfirmOpen(false)}
                onConfirmClear={onClearCanvas}
            />
            <AssetPickerModal open={assets.pickerOpen} multiple={assets.multiple} onInsert={assets.onInsertLibrary} onClose={assets.onClosePicker} />
            <CanvasProjectAssetModal
                open={assets.projectOpen}
                detail={assets.detail}
                initialCategory={assets.initialCategory}
                initialFolderId={assets.initialFolderId}
                onClose={assets.onCloseProject}
                onInsert={assets.onInsertProject}
                onInsertFolder={assets.onInsertFolder}
            />
        </>
    );
}

export type { PanoramaGenerateConfig, CanvasImageUpscaleParams, CanvasVideoFrameParams };
