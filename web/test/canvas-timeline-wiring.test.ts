import { beforeEach, describe, expect, mock, test } from "bun:test";
import { App as AntdApp } from "antd";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";

import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasProjectEditorDialogsProps } from "@/pages/canvas/canvas-project-editor-dialogs";

const timelineDialogCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-timeline-dialog", () => ({
    CanvasTimelineDialog: (props: Record<string, unknown>) => {
        timelineDialogCalls.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-node-search-modal", () => ({ CanvasNodeSearchModal: () => null }));
mock.module("@/components/canvas/canvas-folder-browser-modal", () => ({ CanvasFolderBrowserModal: () => null }));
mock.module("@/components/canvas/canvas-generation-history-picker", () => ({ CanvasGenerationHistoryPicker: () => null }));
mock.module("@/pages/canvas/components/libtv-import-dialog", () => ({ LibTVImportDialog: () => null }));
mock.module("@/pages/canvas/components/tapnow-import-dialog", () => ({ TapNowImportDialog: () => null }));
mock.module("@/components/canvas/canvas-style-picker-modal", () => ({ CanvasStylePickerModal: () => null }));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({ CanvasNodeInfoModal: () => null }));
mock.module("@/components/canvas/canvas-subtitle-dialog", () => ({ CanvasSubtitleDialog: () => null }));
mock.module("@/components/canvas/video-subtitle-erase-dialog", () => ({ CanvasVideoSubtitleEraseDialog: () => null }));
mock.module("@/components/canvas/canvas-video-frame-dialog", () => ({ CanvasVideoFrameDialog: () => null }));
mock.module("@/components/canvas/canvas-character-reference-modal", () => ({ CanvasCharacterReferenceModal: () => null }));
mock.module("@/components/canvas/canvas-text-editor-modal", () => ({ CanvasTextEditorModal: () => null }));
mock.module("@/components/canvas/canvas-panorama-config-modal", () => ({ CanvasPanoramaConfigModal: () => null }));
mock.module("@/components/canvas/canvas-script-editor", () => ({ CanvasScriptEditor: () => null }));
mock.module("@/components/canvas/canvas-version-compare-modal", () => ({ CanvasVersionCompareModal: () => null }));
mock.module("@/pages/canvas/canvas-project-media-dialogs", () => ({ CanvasProjectMediaDialogs: () => null }));
mock.module("@/pages/canvas/canvas-project-status-dialogs", () => ({ CanvasProjectStatusDialogs: () => null }));
mock.module("@/components/canvas/asset-picker-modal", () => ({ AssetPickerModal: () => null }));
mock.module("@/components/canvas/canvas-project-asset-modal", () => ({ CanvasProjectAssetModal: () => null }));

const { CanvasProjectEditorDialogs } = await import("@/pages/canvas/canvas-project-editor-dialogs");

beforeEach(() => {
    timelineDialogCalls.length = 0;
});

test("timeline media actions are required and wired back to the canvas", async () => {
    const timelineNode: CanvasNodeData = {
        id: "tl-node",
        type: CanvasNodeType.Timeline,
        title: "时间线",
        position: { x: 0, y: 0 },
        width: 300,
        height: 200,
        metadata: {},
    };
    const onUploadLocalFiles = async () => [];
    const onCreateAssembledNode = async () => null;
    const noop = () => undefined;

    const props = {
        projectId: "canvas-1",
        readOnly: false,
        theme: canvasThemes.dark,
        config: {},
        document: { nodes: [timelineNode], connections: [], setNodes: noop },
        dialogs: { timelineNodeId: "tl-node", setTimelineNodeId: noop, openTextNodeEditor: noop, openDrawingNode: noop, setScriptEditorNodeId: noop, setInfoNodeId: noop, setPreviewNodeId: noop, setNodeSearchOpen: noop, setGenerationHistoryOpen: noop, setLibTVImportOpen: noop, setTapNowImportOpen: noop, setStylePickerOpen: noop, setSubtitleNodeId: noop, setCharacterReferenceNodeId: noop, setTextEditorNodeId: noop, setDrawingNodeId: noop, setDirectorNodeId: noop, setVersionCompareRootId: noop, setClearConfirmOpen: noop },
        renderModel: { nodeById: new Map([[timelineNode.id, timelineNode]]), frameChildrenById: new Map(), versionCompareNodes: [], infoNode: null, previewNode: null, activeScriptNode: null, activeDirectorScene: null, upscaleNode: null, activeStylePresetId: undefined },
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
            onUploadLocalFiles,
            addNodeToTimelineRef: { current: null },
            addMediaToTimelineRef: { current: null },
            onCreateAssembledNode,
        },
        directorOnboardingScope: "guest",
        onDeleteNodes: noop,
        onAddDirectorImage: async () => undefined,
        onFlush: noop,
        onClearCanvas: noop,
        onSetPrimaryVersion: noop,
        assets: { pickerOpen: false, multiple: true, onInsertLibrary: noop, onClosePicker: noop, projectOpen: false, onCloseProject: noop, onInsertProject: noop },
    } as unknown as CanvasProjectEditorDialogsProps;

    const stream = await renderToReadableStream(createElement(AntdApp, null, createElement(CanvasProjectEditorDialogs, props)));
    await stream.allReady;
    expect(timelineDialogCalls).toHaveLength(1);
    expect(timelineDialogCalls[0]?.onUploadLocalFiles).toBe(onUploadLocalFiles);
    expect(timelineDialogCalls[0]?.onCreateAssembledNode).toBe(onCreateAssembledNode);
});
