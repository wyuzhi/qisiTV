import { useMemo, useRef } from "react";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { buildCanvasResourceReferences, isCanvasTextResourceNode, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { useCanvasDocumentState } from "./use-canvas-document-state";
import type { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import type { useCanvasRenderModel } from "./use-canvas-render-model";
import type { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import type { useCanvasNodeEditor } from "./use-canvas-node-editor";
import type { useCanvasNodeOperations } from "./use-canvas-node-operations";
import type { useCanvasSelectionController } from "./use-canvas-selection-controller";
import type { useCanvasNodeReferences } from "./use-canvas-node-references";
const EMPTY_RESOURCE_REFERENCES: CanvasResourceReference[] = [];
const EMPTY_TEXT_NODES: CanvasNodeData[] = [];

type Props = {
    node: CanvasNodeData;
    projectId: string;
    videoModel: string;
    document: ReturnType<typeof useCanvasDocumentState>;
    dialogs: ReturnType<typeof useCanvasProjectDialogs>;
    renderModel: ReturnType<typeof useCanvasRenderModel>;
    generation: ReturnType<typeof useCanvasGenerationOrchestration>;
    nodeEditor: ReturnType<typeof useCanvasNodeEditor>;
    pageUi: CanvasPageUiStoreHook;
    referenceActions: ReturnType<typeof useCanvasNodeReferences>;
    onFocusNode: (id: string) => void;
    onCreateReplacement: ReturnType<typeof useCanvasNodeOperations>["createGenerationReplacement"];
    onNodeMouseDown: ReturnType<typeof useCanvasSelectionController>["handleNodeMouseDown"];
};

export function CanvasProjectNodePrompt({ node: panelNode, projectId, videoModel, document, dialogs,
    renderModel, generation, nodeEditor, pageUi, referenceActions, onFocusNode: focusCanvasNode,
    onCreateReplacement: createGenerationReplacement, onNodeMouseDown: handleNodeMouseDown,
}: Props) {
    const { connections, nodesRef, connectionsRef } = document;
    const { configInputsById, mentionReferencesByNodeId, semanticNodes, skillMentionReferences } = renderModel;
    const { handleConfigNodeChange, handleNodePromptChange } = nodeEditor;
    const { handleGenerateNode, runningNodeId } = generation;
    const { setDialogNodeId, setNodeImageSettingsOpen, setToolbarNodeId } = pageUi.getState();
    const { setGenerationHistoryOpen } = dialogs;
    const { handleRemoveNodeReference, handleReorderNodeReferences, handleReplaceNodeReference, handleReplaceNodeReferenceFiles } = referenceActions;
    const workspaceMode = "professional";
    const activeMentionReferences = mentionReferencesByNodeId.get(panelNode.id) || EMPTY_RESOURCE_REFERENCES;
    const usesPromptPanel = panelNode.type !== CanvasNodeType.Config && panelNode.type !== CanvasNodeType.Script && panelNode.type !== CanvasNodeType.Drawing;
    const panelNodeIsTextResource = usesPromptPanel && isCanvasTextResourceNode(panelNode);
    const otherTextNodesRef = useRef<CanvasNodeData[]>(EMPTY_TEXT_NODES);
    const otherTextNodes = useMemo(() => {
        if (!usesPromptPanel) {
            otherTextNodesRef.current = EMPTY_TEXT_NODES;
            return EMPTY_TEXT_NODES;
        }
        const next = semanticNodes.filter((node) => node.id !== panelNode.id && isCanvasTextResourceNode(node));
        const previous = otherTextNodesRef.current;
        if (previous.length === next.length && next.every((node, index) => node === previous[index])) {
            return previous;
        }
        otherTextNodesRef.current = next;
        return next;
    }, [panelNode.id, semanticNodes, usesPromptPanel]);
    const mentionReferences = useMemo(
        () => usesPromptPanel
            ? [
                ...activeMentionReferences,
                ...buildCanvasResourceReferences(nodesRef.current, connections).filter((reference) => reference.kind === "text" && reference.nodeId !== panelNode.id && !activeMentionReferences.some((active) => active.nodeId === reference.nodeId)),
            ]
            : EMPTY_RESOURCE_REFERENCES,
        [activeMentionReferences, connections, nodesRef, otherTextNodes, panelNode.id, panelNodeIsTextResource, usesPromptPanel],
    );
    if (panelNode.type === CanvasNodeType.Script || panelNode.type === CanvasNodeType.Drawing) return null;
    return panelNode.type === CanvasNodeType.Config ? (
        <CanvasConfigComposer
            model={panelNode.metadata?.model || videoModel}
            value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
            inputs={configInputsById.get(panelNode.id) || []}
            skillReferences={skillMentionReferences}
            generationMode={panelNode.metadata?.generationMode}
            metadata={panelNode.metadata}
            workspaceMode={workspaceMode}
            onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
            onMetadataChange={(patch) => handleConfigNodeChange(panelNode.id, patch)}
            onClose={() => setDialogNodeId(null)}
        />
    ) : (
        <CanvasNodePromptPanel
            projectId={projectId}
            node={panelNode}
            referenceNodes={nodesRef.current}
            referenceConnections={connectionsRef.current}
            onLocateReferenceNode={focusCanvasNode}
            isRunning={isCanvasNodeGenerating(panelNode, runningNodeId)}
            mentionReferences={mentionReferences}
            onAddReference={referenceActions.addTextReference}
            onPromptChange={handleNodePromptChange}
            onConfigChange={handleConfigNodeChange}
            onGenerate={handleGenerateNode}
            onOpenGenerationHistory={() => setGenerationHistoryOpen(true)}
            onCreateGenerationReplacement={createGenerationReplacement}
            onRemoveReference={handleRemoveNodeReference}
            onReorderReferences={handleReorderNodeReferences}
            onReplaceReference={handleReplaceNodeReference}
            onReplaceReferenceFiles={handleReplaceNodeReferenceFiles}
            onClose={() => setDialogNodeId(null)}
            onNodeMouseDown={handleNodeMouseDown}
            workspaceMode={workspaceMode}
            onImageSettingsOpenChange={(open) => {
                setNodeImageSettingsOpen(open);
                if (open) setToolbarNodeId(null);
            }}
        />
    );
}
