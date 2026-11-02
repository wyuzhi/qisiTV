import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { useCanvasDocumentState } from "../../src/pages/canvas/use-canvas-document-state";
import { useCanvasImport } from "../../src/pages/canvas/use-canvas-import";
import { useCanvasProjectDialogs } from "../../src/pages/canvas/use-canvas-project-dialogs";
import { createCanvasPageUiStore } from "../../src/stores/canvas/use-canvas-page-ui-store";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

const fixture: any = { done: false, error: null };
(window as any).__documentTest = fixture;
setActiveUserScope("document-owner-a");
const node = (title = "original"): CanvasNodeData => ({ id: "shared-id", type: CanvasNodeType.Video, title, width: 320, height: 180, position: { x: 0, y: 0 }, metadata: {} });
function Harness() {
    const [projectId, setProjectId] = useState("canvas-a");
    const document = useCanvasDocumentState(projectId);
    const [pageUi] = useState(createCanvasPageUiStore);
    const dialogs = useCanvasProjectDialogs(pageUi);
    const imports = useCanvasImport({ projectId, document, saveCanvasProject: () => new Promise<boolean>(resolve => { fixture.releaseSave = resolve; }) });
    useLayoutEffect(() => document.setNodes([node()]), []);
    useLayoutEffect(() => {
        fixture.snapshot = () => ({ projectId, nodes: document.nodes, connections: document.connections,
            textEditor: dialogs.textEditorNodeId, characterEditor: dialogs.characterReferenceNodeId,
            drawing: dialogs.drawingNodeId, selection: [...pageUi.getState().selectedNodeIds] });
        fixture.queueMedia = () => {
            document.updateMediaNodeFromContent("shared-id", current => ({ ...current, metadata: { ...current.metadata, durationMs: 1200 } }));
            document.updateMediaNodeFromContent("shared-id", current => ({ ...current, metadata: { ...current.metadata, hasAudio: true } }));
        };
        fixture.startImport = () => {
            imports.applyLibTVImport([{ ...node("imported"), id: "imported" }], []).catch(error => { fixture.error = error.name; }).finally(() => { fixture.done = true; });
        };
        fixture.openText = (character: boolean) => dialogs.openTextNodeEditor({ ...node(), type: CanvasNodeType.Text, metadata: character ? { workflowKind: "character", characterAssetId: "character" } : {} });
        fixture.openDrawing = () => dialogs.openDrawingNode({ ...node(), type: CanvasNodeType.Drawing });
        fixture.switchOwner = (mode: string) => {
            if (mode === "canvas") setProjectId("canvas-b");
            if (mode === "canvas-return") setProjectId("canvas-a");
            if (mode === "account") setActiveUserScope("document-owner-b");
            if (mode === "account-return") { setActiveUserScope("document-owner-b"); setActiveUserScope("document-owner-a"); }
            document.setNodes([node("new-owner")]);
            document.setConnections([]);
        };
    });
    return <output>{document.nodes.length}</output>;
}
const root = createRoot(document.getElementById("root")!);
fixture.unmount = () => root.unmount();
root.render(<App><Harness /></App>);
