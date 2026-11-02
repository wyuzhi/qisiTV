import { useRef } from "react";
import { App } from "antd";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasCharacterReferenceNodeContent } from "@/components/canvas/canvas-character-reference-node";
import { CanvasScriptNodeContent } from "@/components/canvas/canvas-script-node";
import { CanvasBatchTableNodeContent } from "@/components/canvas/canvas-batch-table-node";
import { CanvasDirectorNodePanel } from "@/components/canvas/director/canvas-director-node-panel";
import { CanvasStoryInputNodeContent, CanvasStylePlaceholderNodeContent } from "@/components/canvas/canvas-short-drama-entry";
import { ReusableWorkflowNode } from "@/components/canvas/nodes/reusable-workflow-node";
import { storyboardMinNodeHeight } from "@/lib/canvas/canvas-storyboard-layout";
import { deriveStoryboardPipelineProgress } from "@/lib/canvas/canvas-storyboard-progress";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { getInputSummary } from "@/lib/canvas/canvas-project-domain";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import { CanvasNodeType, type CanvasNodeData, type StoryboardShotCount, type StoryboardShotDuration } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";
import type { useCanvasDocumentState } from "./use-canvas-document-state";
import type { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import type { useCanvasRenderModel } from "./use-canvas-render-model";
import type { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import type { useCanvasNodeEditor } from "./use-canvas-node-editor";
import type { useCanvasMediaTools } from "./use-canvas-media-tools";
import type { useCanvasConnectionController } from "./use-canvas-connection-controller";
import type { useCanvasUpload } from "./use-canvas-upload";
import type { useCanvasSelectionController } from "./use-canvas-selection-controller";
import type { useCanvasWorkflowInstances } from "./use-canvas-workflow-instances";
import { useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import { createCanvasMediaOperation } from "./canvas-media-operation";

const EMPTY_RESOURCE_REFERENCES: CanvasResourceReference[] = [];
function visibleGenerationBatch(node: CanvasNodeData) {
    const batches = node.metadata?.generationBatches || [];
    for (let index = batches.length - 1; index >= 0; index -= 1) {
        if (batches[index].status === "queued" || batches[index].status === "running") return batches[index];
    }
    return batches.at(-1);
}

type Props = {
    node: CanvasNodeData;
    projectId: string;
    readOnly: boolean;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    viewportScale: number;
    document: ReturnType<typeof useCanvasDocumentState>;
    dialogs: ReturnType<typeof useCanvasProjectDialogs>;
    renderModel: ReturnType<typeof useCanvasRenderModel>;
    generation: ReturnType<typeof useCanvasGenerationOrchestration>;
    nodeEditor: ReturnType<typeof useCanvasNodeEditor>;
    mediaTools: ReturnType<typeof useCanvasMediaTools>;
    connectionController: ReturnType<typeof useCanvasConnectionController>;
    uploads: ReturnType<typeof useCanvasUpload>;
    workflowInstances: ReturnType<typeof useCanvasWorkflowInstances>;
    pageUi: CanvasPageUiStoreHook;
    nodeDropTargetId?: string | null;
    directorScenes?: DirectorScene[];
    onFocusImage: (nodeId: string) => void;
    onOpenDirector: (nodeId: string) => void;
    onOpenStory: (nodeId: string) => void;
    onNodeMouseDown: ReturnType<typeof useCanvasSelectionController>["handleNodeMouseDown"];
};

export function CanvasProjectNodeContent({ node: contentNode, projectId, readOnly, theme, viewportScale,
    document, dialogs, renderModel, generation, nodeEditor, mediaTools, connectionController,
    uploads, workflowInstances, pageUi, nodeDropTargetId, directorScenes,
    onFocusImage: focusCanvasImageNode, onOpenDirector: openDirectorWorkbench,
    onOpenStory: openStoryInput, onNodeMouseDown: handleNodeMouseDown,
}: Props) {
    const { message } = App.useApp();
    const { nodesRef, connectionsRef, connections } = document;
    const { setStylePickerOpen, setScriptEditorNodeId } = dialogs;
    const { configInputsById, mentionReferencesByNodeId } = renderModel;
    const { handleConfigNodeChange, handleNodeResize } = nodeEditor;
    const { mergeVideosByIds } = mediaTools;
    const { handleConnectStart, handleConnectDrop } = connectionController;
    const { replaceNodeMedia, createFileNode } = uploads;
    const { setDialogNodeId, setScriptScrollTopById } = pageUi.getState();
    const { addBatchReferenceColumn, addBatchRow, addScriptRow, createAndGenerateScriptVideos,
        createScriptActionBoards, createScriptImageNodes, createScriptVideoNodes, fillRowsFromConnections,
        generateBatchRows, generateScriptImages, generateScriptRows, generateScriptVideos,
        handleGenerateNode, moveBatchReferenceCell, patchBatchTable, removeBatchReferenceColumn,
        removeBatchRow, removeScriptRow, reorderBatchReferenceColumns, retryFailedBatchItems,
        runningNodeId, stopRemainingBatchItems, updateBatchRow, updateScriptRow } = generation;
    const workspaceMode = "professional";
    const canvasIdRef = useRef(projectId);
    canvasIdRef.current = projectId;
    const { lifetime, mountedRef } = useCanvasOwnerLifetime(projectId);
    if (contentNode.metadata?.reusableWorkflow || contentNode.metadata?.workflowSlot) {
        return <ReusableWorkflowNode node={contentNode} nodes={nodesRef.current} readOnly={readOnly} onResultDrag={handleNodeMouseDown} onUpdate={workflowInstances.update} dropTarget={nodeDropTargetId === contentNode.id} onAction={workflowInstances.action} onValue={workflowInstances.setValue} onUploadBusy={workflowInstances.uploadBusy} onError={error => { void message.error(error); }} />;
    }
    if (contentNode.metadata?.workflowKind === "character" && contentNode.metadata.characterAssetId) {
        return <CanvasCharacterReferenceNodeContent node={contentNode} />;
    }
    if (contentNode.metadata?.workflowKind === "styleboard" && !contentNode.metadata.content) {
        return <CanvasStylePlaceholderNodeContent onChoose={() => setStylePickerOpen(true)} />;
    }
    if (contentNode.metadata?.workflowKind === "story_input") {
        return <CanvasStoryInputNodeContent node={contentNode} onEdit={() => openStoryInput(contentNode.id)} />;
    }
    if (contentNode.type === CanvasNodeType.BatchTable) {
        return (
            <CanvasBatchTableNodeContent
                node={contentNode}
                nodes={nodesRef.current}
                connections={connections}
                batch={visibleGenerationBatch(contentNode)}
                theme={theme}
                onPatchTable={(patch) => patchBatchTable(contentNode.id, patch)}
                onAddRow={() => addBatchRow(contentNode.id)}
                onRemoveRow={(rowId) => removeBatchRow(contentNode.id, rowId)}
                onUpdateRow={(rowId, patch) => updateBatchRow(contentNode.id, rowId, patch)}
                onFillRows={() => fillRowsFromConnections(contentNode.id)}
                onGenerate={(rowIds) => void generateBatchRows(contentNode.id, rowIds)}
                onRetryItem={(batchId, itemId) => retryFailedBatchItems(contentNode.id, batchId, itemId)}
                onAddReferenceColumn={() => addBatchReferenceColumn(contentNode.id)}
                onRemoveReferenceColumn={() => removeBatchReferenceColumn(contentNode.id)}
                onFocusOutput={(nodeId) => focusCanvasImageNode(nodeId)}
                onReorderReferenceColumns={(fromColumnId, toColumnId) => reorderBatchReferenceColumns(contentNode.id, fromColumnId, toColumnId)}
                onMoveReferenceCell={(sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex) => moveBatchReferenceCell(contentNode.id, sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex)}
                onUploadReference={(rowId, columnIndex, file) => {
                    const row = contentNode.metadata?.batchTable?.rows.find((item) => item.id === rowId);
                    const existingId = row?.inputNodeIds[columnIndex];
                    if (existingId) {
                        void replaceNodeMedia(existingId, file);
                        return;
                    }
                    const operation = createCanvasMediaOperation(lifetime, projectId, () => canvasIdRef.current, () => mountedRef.current);
                    void createFileNode(file, { x: contentNode.position.x - 180, y: contentNode.position.y + columnIndex * 90 }).then((insertedId) => {
                        if (!operation.isCurrent() || !insertedId) return;
                        const currentRow = nodesRef.current.find((item) => item.id === contentNode.id)?.metadata?.batchTable?.rows.find((item) => item.id === rowId);
                        const ids = [...(currentRow?.inputNodeIds || [])];
                        while (ids.length <= columnIndex) ids.push("");
                        ids[columnIndex] = insertedId;
                        updateBatchRow(contentNode.id, rowId, { inputNodeIds: ids });
                    }).catch(error => { if (operation.isCurrent()) void message.error(error instanceof Error ? error.message : "参考素材上传失败"); });
                }}
                onConnectStart={(event, handleId) => handleConnectStart(event, contentNode.id, "target", handleId)}
                onConnectDrop={(event, handleId) => handleConnectDrop(event, contentNode.id, handleId)}
            />
        );
    }
    if (contentNode.type === CanvasNodeType.Script) {
        const pipeline = deriveStoryboardPipelineProgress(contentNode, nodesRef.current, connectionsRef.current);
        return (
            <CanvasScriptNodeContent
                node={contentNode}
                nodes={nodesRef.current}
                batch={visibleGenerationBatch(contentNode)}
                pipeline={pipeline}
                scale={viewportScale}
                mentionReferences={mentionReferencesByNodeId.get(contentNode.id) || EMPTY_RESOURCE_REFERENCES}
                onOpen={() => setScriptEditorNodeId(contentNode.id)}
                onCreateImageNodes={() => createScriptImageNodes(contentNode.id)}
                onCreateVideoNodes={() => createScriptVideoNodes(contentNode.id)}
                onGenerateImages={(rowIds) => void generateScriptImages(contentNode.id, rowIds)}
                onGenerateVideos={(rowIds) => (contentNode.metadata?.storyboardVideoInputMode === "keyframe" ? void generateScriptVideos(contentNode.id, rowIds) : void createAndGenerateScriptVideos(contentNode.id, rowIds))}
                onVideoInputModeChange={(storyboardVideoInputMode) => handleConfigNodeChange(contentNode.id, { storyboardVideoInputMode })}
                onMergeVideos={() => void mergeVideosByIds(pipeline.successfulVideoNodeIds)}
                onCreateActionBoards={() => void createScriptActionBoards(contentNode.id)}
                onRetryBatch={(batchId) => retryFailedBatchItems(contentNode.id, batchId)}
                onRetryBatchItem={(batchId, itemId) => retryFailedBatchItems(contentNode.id, batchId, itemId)}
                onStopBatch={(batchId) => stopRemainingBatchItems(contentNode.id, batchId)}
                onAddRow={() => addScriptRow(contentNode.id)}
                onRemoveRow={(rowId) => removeScriptRow(contentNode.id, rowId)}
                onUpdateRow={(rowId, patch) => updateScriptRow(contentNode.id, rowId, patch)}
                onPromptChange={(composerContent) => handleConfigNodeChange(contentNode.id, { composerContent })}
                onGenerateScript={(prompt) => void generateScriptRows(contentNode.id, prompt)}
                onModelChange={(model) => handleConfigNodeChange(contentNode.id, { model })}
                onShotDurationChange={(duration: StoryboardShotDuration) => handleConfigNodeChange(contentNode.id, { storyboardShotDuration: duration })}
                onShotCountChange={(count: StoryboardShotCount) => handleConfigNodeChange(contentNode.id, { storyboardShotCount: count })}
                workspaceMode={workspaceMode}
                onComposerHeightChange={(height) => {
                    if (contentNode.metadata?.storyboardComposerHeight === height) return;
                    handleConfigNodeChange(contentNode.id, { storyboardComposerHeight: height });
                    const minHeight = storyboardMinNodeHeight(height);
                    if (contentNode.height < minHeight) handleNodeResize(contentNode.id, contentNode.width, minHeight);
                }}
                onConnectStart={(event, rowId, handleType) => handleConnectStart(event, contentNode.id, handleType, rowId === "context" ? "storyboard:context" : `row:${rowId}`)}
                onScrollTopChange={(scrollTop) => setScriptScrollTopById((current) => (current[contentNode.id] === scrollTop ? current : { ...current, [contentNode.id]: scrollTop }))}
            />
        );
    }
    if (contentNode.type === CanvasNodeType.Director || contentNode.metadata?.directorSceneId) {
        return (
            <CanvasDirectorNodePanel
                node={contentNode}
                scene={directorScenes?.find((scene) => scene.id === contentNode.metadata?.directorSceneId) || null}
                readNodeContent={(nodeId) => (nodeId ? nodesRef.current.find((item) => item.id === nodeId)?.metadata?.content : undefined)}
                readNodeStorageKey={(nodeId) => (nodeId ? nodesRef.current.find((item) => item.id === nodeId)?.metadata?.storageKey : undefined)}
                professional={workspaceMode === "professional"}
                onOpen={() => openDirectorWorkbench(contentNode.id)}
            />
        );
    }
    return (
        <CanvasConfigNodePanel
            node={contentNode}
            isRunning={isCanvasNodeGenerating(contentNode, runningNodeId)}
            inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
            onConfigChange={handleConfigNodeChange}
            onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
            onGenerate={(nodeId) => {
                const target = nodesRef.current.find((item) => item.id === nodeId);
                void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
            }}
            workspaceMode={workspaceMode}
        />
    );
}
