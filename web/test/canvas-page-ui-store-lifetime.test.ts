import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { createCanvasPageUiStore } from "../src/stores/canvas/use-canvas-page-ui-store";

function fill(store: ReturnType<typeof createCanvasPageUiStore>) {
    const state = store.getState();
    state.setSelectedNodeIds(new Set(["node-a"]));
    state.setSelectedConnectionId("edge-a");
    state.setWorkflowLibraryOpen(true);
    state.setDialogNodeId("node-a");
    state.setContextMenu({ type: "node", x: 1, y: 2, nodeId: "node-a" });
    state.setActiveMediaNodeId("node-a");
    state.setHoveredNodeId("node-a");
    state.setToolbarNodeId("node-a");
    state.setScriptScrollTopById({ "node-a": 40 });
}

describe("canvas page ui store lifetime", () => {
    test("a new page instance starts with empty dialog, menu, media and selection", () => {
        const page = createCanvasPageUiStore().getState();
        expect(page.dialogNodeId).toBeNull();
        expect(page.contextMenu).toBeNull();
        expect(page.activeMediaNodeId).toBeNull();
        expect(page.selectedNodeIds.size).toBe(0);
        expect(page.selectedConnectionId).toBeNull();
        expect(page.workflowLibraryOpen).toBe(false);
    });

    test("two page instances for the same project do not share state", () => {
        const first = createCanvasPageUiStore();
        const second = createCanvasPageUiStore();
        fill(first);
        expect(second.getState().selectedNodeIds.size).toBe(0);
        expect(second.getState().dialogNodeId).toBeNull();
        expect(second.getState().contextMenu).toBeNull();
        expect(second.getState().activeMediaNodeId).toBeNull();
        first.getState().setDialogNodeId("node-b");
        expect(second.getState().dialogNodeId).toBeNull();
    });

    test("changing project only resets selection, connection and the workflow library", () => {
        const page = createCanvasPageUiStore();
        fill(page);
        page.getState().resetForProject();
        const state = page.getState();
        expect(state.selectedNodeIds.size).toBe(0);
        expect(state.selectedConnectionId).toBeNull();
        expect(state.workflowLibraryOpen).toBe(false);
        expect(state.dialogNodeId).toBe("node-a");
        expect(state.contextMenu).toEqual({ type: "node", x: 1, y: 2, nodeId: "node-a" });
        expect(state.activeMediaNodeId).toBe("node-a");
        expect(state.hoveredNodeId).toBe("node-a");
        expect(state.toolbarNodeId).toBe("node-a");
        expect(state.scriptScrollTopById).toEqual({ "node-a": 40 });

        const project = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
        const effect = project.slice(project.indexOf("pageUi.getState().resetForProject()"), project.indexOf("pageUi.getState().resetForProject()") + 180);
        expect(effect).toContain("[pageUi, projectId]");
    });
});
