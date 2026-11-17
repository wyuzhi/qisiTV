import { beforeEach, describe, expect, mock, test } from "bun:test";
import { App as AntdApp } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { resolvePromptDialogNode } from "@/pages/canvas/canvas-pointer-chrome";
import { canOpenCanvasNodePromptPanel } from "@/lib/canvas/canvas-node-semantics";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasProjectEditorDialogsProps } from "@/pages/canvas/canvas-project-editor-dialogs";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasStageOverlayProps, makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const panelOverlayCalls: Array<Record<string, unknown>> = [];
const scriptEditorCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-workspace-overlays", () => ({
    CanvasNodePanelOverlay: (props: Record<string, unknown>) => {
        panelOverlayCalls.push(props);
        return null;
    },
    CanvasConnectionCreateMenu: () => null,
    CanvasSelectionToolbar: () => null,
}));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({
    CanvasNodeToolbar: () => null,
    CanvasNodeInfoModal: () => null,
}));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({ CanvasOverlayLayerContainer: () => null }));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));
mock.module("@/components/canvas/canvas-script-editor", () => ({
    CanvasScriptEditor: (props: Record<string, unknown>) => {
        scriptEditorCalls.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-node-search-modal", () => ({ CanvasNodeSearchModal: () => null }));
mock.module("@/components/canvas/canvas-folder-browser-modal", () => ({ CanvasFolderBrowserModal: () => null }));
mock.module("@/components/canvas/canvas-generation-history-picker", () => ({ CanvasGenerationHistoryPicker: () => null }));
mock.module("@/pages/canvas/components/libtv-import-dialog", () => ({ LibTVImportDialog: () => null }));
mock.module("@/pages/canvas/components/tapnow-import-dialog", () => ({ TapNowImportDialog: () => null }));
mock.module("@/components/canvas/canvas-style-picker-modal", () => ({ CanvasStylePickerModal: () => null }));
mock.module("@/components/canvas/canvas-subtitle-dialog", () => ({ CanvasSubtitleDialog: () => null }));
mock.module("@/components/canvas/video-subtitle-erase-dialog", () => ({ CanvasVideoSubtitleEraseDialog: () => null }));
mock.module("@/components/canvas/canvas-video-frame-dialog", () => ({ CanvasVideoFrameDialog: () => null }));
mock.module("@/components/canvas/canvas-timeline-dialog", () => ({ CanvasTimelineDialog: () => null }));
mock.module("@/components/canvas/canvas-character-reference-modal", () => ({ CanvasCharacterReferenceModal: () => null }));
mock.module("@/components/canvas/canvas-text-editor-modal", () => ({ CanvasTextEditorModal: () => null }));
mock.module("@/components/canvas/canvas-panorama-config-modal", () => ({ CanvasPanoramaConfigModal: () => null }));
mock.module("@/components/canvas/canvas-version-compare-modal", () => ({ CanvasVersionCompareModal: () => null }));
mock.module("@/pages/canvas/canvas-project-media-dialogs", () => ({ CanvasProjectMediaDialogs: () => null }));
mock.module("@/pages/canvas/canvas-project-status-dialogs", () => ({ CanvasProjectStatusDialogs: () => null }));
mock.module("@/components/canvas/asset-picker-modal", () => ({
    AssetPickerModal: () => null,
    localAssetToInsertPayload: (asset: unknown) => asset,
}));
mock.module("@/components/canvas/canvas-project-asset-modal", () => ({ CanvasProjectAssetModal: () => null }));

const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");
const { CanvasProjectEditorDialogs } = await import("@/pages/canvas/canvas-project-editor-dialogs");

beforeEach(() => {
    panelOverlayCalls.length = 0;
    scriptEditorCalls.length = 0;
});

function buildEditorDialogProps(activeScriptNode: CanvasNodeData | null): CanvasProjectEditorDialogsProps {
    const noop = () => undefined;
    const nodes = activeScriptNode ? [activeScriptNode] : [];
    return {
        projectId: "canvas-1",
        readOnly: false,
        theme: canvasThemes.dark,
        config: {},
        document: { nodes, connections: [], setNodes: noop },
        dialogs: {
            setScriptEditorNodeId: noop,
            setInfoNodeId: noop,
            setPreviewNodeId: noop,
            setNodeSearchOpen: noop,
            setGenerationHistoryOpen: noop,
            setLibTVImportOpen: noop,
            setTapNowImportOpen: noop,
            setStylePickerOpen: noop,
            setSubtitleNodeId: noop,
            setTimelineNodeId: noop,
            setCharacterReferenceNodeId: noop,
            setTextEditorNodeId: noop,
            setDrawingNodeId: noop,
            setDirectorNodeId: noop,
            setVersionCompareRootId: noop,
            setClearConfirmOpen: noop,
            openTextNodeEditor: noop,
            openDrawingNode: noop,
        },
        renderModel: {
            nodeById: new Map(nodes.map((node) => [node.id, node])),
            frameChildrenById: new Map(),
            versionCompareNodes: [],
            infoNode: null,
            previewNode: null,
            activeScriptNode,
            activeDirectorScene: null,
            upscaleNode: null,
            activeStylePresetId: undefined,
        },
        generation: { setTaskDetail: noop, cancelCanvasTask: noop, retrieveTaskResult: async () => undefined },
        nodeEditor: { handleConfigNodeChange: noop },
        mediaTools: { setPanoramaConfigNodeId: noop, setUpscaleNodeId: noop, closeFrameDialog: noop },
        styles: { styleApplying: false, selectCanvasStyle: noop },
        director: { saveDirectorScene: noop },
        viewport: { x: 0, y: 0, k: 1 },
        viewportSize: { width: 1280, height: 800 },
        onFocusNode: noop,
        onSearchFocusNode: noop,
        imports: { onApplyLibTV: async () => undefined, onApplyTapNow: async () => undefined },
        timeline: {
            project: null,
            onSave: noop,
            onUpdate: noop,
            onOpenAssetLibrary: noop,
            onOpenProjectAssets: noop,
            onUploadLocalFiles: async () => [],
            addNodeToTimelineRef: { current: null },
            addMediaToTimelineRef: { current: null },
            onCreateAssembledNode: async () => null,
        },
        directorOnboardingScope: "guest",
        onDeleteNodes: noop,
        onAddDirectorImage: async () => undefined,
        onFlush: noop,
        onClearCanvas: noop,
        onSetPrimaryVersion: noop,
        assets: {
            pickerOpen: false,
            multiple: true,
            onInsertLibrary: noop,
            onClosePicker: noop,
            projectOpen: false,
            onCloseProject: noop,
            onInsertProject: noop,
        },
    } as unknown as CanvasProjectEditorDialogsProps;
}

describe("storyboard prompt panel rules", () => {
    test("prompt helper and overlays never open prompt panels for script, batch table, drawing, or panorama nodes", () => {
        for (const type of [
            CanvasNodeType.Script,
            CanvasNodeType.BatchTable,
            CanvasNodeType.Drawing,
            CanvasNodeType.Panorama,
        ]) {
            const node = makeCanvasNode(`node-${type}`, type);
            expect(canOpenCanvasNodePromptPanel(node)).toBe(false);
            expect(resolvePromptDialogNode(node)).toBeNull();

            panelOverlayCalls.length = 0;
            renderToStaticMarkup(
                createElement(CanvasProjectStageOverlays, createCanvasStageOverlayProps({ dialogNode: node })),
            );
            expect(panelOverlayCalls).toHaveLength(0);
        }
    });

    test("script node routes to dedicated storyboard editor dialog instead of prompt panel", () => {
        const scriptNode = makeCanvasNode("script-1", CanvasNodeType.Script, { scriptRows: [] });
        expect(resolvePromptDialogNode(scriptNode)).toBeNull();

        renderToStaticMarkup(createElement(AntdApp, null, createElement(CanvasProjectEditorDialogs, buildEditorDialogProps(null))));
        expect(scriptEditorCalls).toHaveLength(1);
        expect(scriptEditorCalls[0]?.open).toBe(false);
        expect(scriptEditorCalls[0]?.node).toBeNull();

        scriptEditorCalls.length = 0;
        renderToStaticMarkup(createElement(AntdApp, null, createElement(CanvasProjectEditorDialogs, buildEditorDialogProps(scriptNode))));
        expect(scriptEditorCalls).toHaveLength(1);
        expect(scriptEditorCalls[0]?.open).toBe(true);
        expect(scriptEditorCalls[0]?.node).toBe(scriptNode);
    });
});
