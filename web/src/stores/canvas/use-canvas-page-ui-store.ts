import { create, type StoreApi, type UseBoundStore } from "zustand";

import type { ContextMenuState } from "@/types/canvas";

/**
 * 一个画布页面实例自己的选中、悬停和面板状态。
 *
 * 文档内容在 useCanvasStore。这里不按画布 id 做全局登记：每个 InfiniteCanvasPage
 * 自己创建一份，卸载即释放。同一个项目开两个窗口不会共用选中和菜单；异步回调
 * 拿到的是创建它的那个页面，账号切换后不会写进另一份。
 * 写入走 getState()，回调读到的是当前值，不依赖调用方当时抓住的那一份。
 */
export type CanvasPageUiState = {
    selectedNodeIds: Set<string>;
    selectedConnectionId: string | null;
    hoveredNodeId: string | null;
    lodHoverNodeId: string | null;
    activeMediaNodeId: string | null;
    contextMenu: ContextMenuState | null;
    toolbarNodeId: string | null;
    dialogNodeId: string | null;
    scriptScrollTopById: Record<string, number>;
    nodeImageSettingsOpen: boolean;
    workflowLibraryOpen: boolean;
};

type CanvasPageUiActions = {
    setSelectedNodeIds: (value: Set<string> | ((current: Set<string>) => Set<string>)) => void;
    setSelectedConnectionId: (value: string | null | ((current: string | null) => string | null)) => void;
    setHoveredNodeId: (value: string | null | ((current: string | null) => string | null)) => void;
    setLodHoverNodeId: (value: string | null | ((current: string | null) => string | null)) => void;
    setActiveMediaNodeId: (value: string | null | ((current: string | null) => string | null)) => void;
    setContextMenu: (value: ContextMenuState | null | ((current: ContextMenuState | null) => ContextMenuState | null)) => void;
    setToolbarNodeId: (value: string | null | ((current: string | null) => string | null)) => void;
    setDialogNodeId: (value: string | null | ((current: string | null) => string | null)) => void;
    setScriptScrollTopById: (value: Record<string, number> | ((current: Record<string, number>) => Record<string, number>)) => void;
    setNodeImageSettingsOpen: (value: boolean | ((current: boolean) => boolean)) => void;
    setWorkflowLibraryOpen: (value: boolean | ((current: boolean) => boolean)) => void;
    /** 切到另一张画布时清空选中和会跟着节点 id 走的面板，避免旧 id 进到新画布。 */
    resetForProject: () => void;
    /** 删除节点后清掉指向这些节点的悬停、面板、滚动位置和节点菜单。 */
    clearRemovedNodes: (removedIds: Set<string>) => void;
};

export type CanvasPageUiStore = CanvasPageUiState & CanvasPageUiActions;

export type CanvasPageUiStoreHook = UseBoundStore<StoreApi<CanvasPageUiStore>>;

export function emptyCanvasPageUiState(): CanvasPageUiState {
    return {
        selectedNodeIds: new Set(),
        selectedConnectionId: null,
        hoveredNodeId: null,
        lodHoverNodeId: null,
        activeMediaNodeId: null,
        contextMenu: null,
        toolbarNodeId: null,
        dialogNodeId: null,
        scriptScrollTopById: {},
        nodeImageSettingsOpen: false,
        workflowLibraryOpen: false,
    };
}

function resolve<T>(value: T | ((current: T) => T), current: T): T {
    return typeof value === "function" ? (value as (current: T) => T)(current) : value;
}

function sameId(next: string | null, current: string | null) {
    return next === current;
}

export function createCanvasPageUiStore() {
    return create<CanvasPageUiStore>((set) => ({
        ...emptyCanvasPageUiState(),
        setSelectedNodeIds: (value) => set((state) => {
            const next = resolve(value, state.selectedNodeIds);
            return next === state.selectedNodeIds ? state : { selectedNodeIds: next };
        }),
        setSelectedConnectionId: (value) => set((state) => {
            const next = resolve(value, state.selectedConnectionId);
            return sameId(next, state.selectedConnectionId) ? state : { selectedConnectionId: next };
        }),
        setHoveredNodeId: (value) => set((state) => {
            const next = resolve(value, state.hoveredNodeId);
            return sameId(next, state.hoveredNodeId) ? state : { hoveredNodeId: next };
        }),
        setLodHoverNodeId: (value) => set((state) => {
            const next = resolve(value, state.lodHoverNodeId);
            return sameId(next, state.lodHoverNodeId) ? state : { lodHoverNodeId: next };
        }),
        setActiveMediaNodeId: (value) => set((state) => {
            const next = resolve(value, state.activeMediaNodeId);
            return sameId(next, state.activeMediaNodeId) ? state : { activeMediaNodeId: next };
        }),
        setContextMenu: (value) => set((state) => {
            const next = resolve(value, state.contextMenu);
            return next === state.contextMenu ? state : { contextMenu: next };
        }),
        setToolbarNodeId: (value) => set((state) => {
            const next = resolve(value, state.toolbarNodeId);
            return sameId(next, state.toolbarNodeId) ? state : { toolbarNodeId: next };
        }),
        setDialogNodeId: (value) => set((state) => {
            const next = resolve(value, state.dialogNodeId);
            return sameId(next, state.dialogNodeId) ? state : { dialogNodeId: next };
        }),
        setScriptScrollTopById: (value) => set((state) => {
            const next = resolve(value, state.scriptScrollTopById);
            return next === state.scriptScrollTopById ? state : { scriptScrollTopById: next };
        }),
        setNodeImageSettingsOpen: (value) => set((state) => {
            const next = resolve(value, state.nodeImageSettingsOpen);
            return next === state.nodeImageSettingsOpen ? state : { nodeImageSettingsOpen: next };
        }),
        setWorkflowLibraryOpen: (value) => set((state) => {
            const next = resolve(value, state.workflowLibraryOpen);
            return next === state.workflowLibraryOpen ? state : { workflowLibraryOpen: next };
        }),
        resetForProject: () => set({
            selectedNodeIds: new Set(),
            selectedConnectionId: null,
            workflowLibraryOpen: false,
        }),
        clearRemovedNodes: (removedIds) => set((state) => {
            const clearId = (current: string | null) => (current && removedIds.has(current) ? null : current);
            const hoveredNodeId = clearId(state.hoveredNodeId);
            const toolbarNodeId = clearId(state.toolbarNodeId);
            const dialogNodeId = clearId(state.dialogNodeId);
            const contextMenu = state.contextMenu?.type === "node" && removedIds.has(state.contextMenu.nodeId) ? null : state.contextMenu;
            let scriptScrollChanged = false;
            const scriptScrollTopById: Record<string, number> = {};
            for (const [id, scrollTop] of Object.entries(state.scriptScrollTopById)) {
                if (removedIds.has(id)) scriptScrollChanged = true;
                else scriptScrollTopById[id] = scrollTop;
            }
            if (
                hoveredNodeId === state.hoveredNodeId
                && toolbarNodeId === state.toolbarNodeId
                && dialogNodeId === state.dialogNodeId
                && contextMenu === state.contextMenu
                && !scriptScrollChanged
            ) return state;
            return {
                hoveredNodeId,
                toolbarNodeId,
                dialogNodeId,
                contextMenu,
                scriptScrollTopById: scriptScrollChanged ? scriptScrollTopById : state.scriptScrollTopById,
                nodeImageSettingsOpen: dialogNodeId ? state.nodeImageSettingsOpen : false,
            };
        }),
    }));
}
