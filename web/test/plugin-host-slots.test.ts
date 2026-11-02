import { beforeEach, describe, expect, test } from "bun:test";
import "../src/lib/plugins/builtin";
import { ART_CRITIQUE_NODE_TYPE, ART_CRITIQUE_PLUGIN_ID } from "../src/lib/art-critique/contracts";
import { getNodeDefinition } from "../src/lib/canvas/node-registry";
import { getAddNodeMenuCommands, getToolbarTools, resolveAddNodeMenuCommands, resolveToolbarTools, type AddNodeMenuContext } from "../src/lib/canvas/tool-registry";
import { EAGLE_PLUGIN_ID } from "../src/lib/plugins/builtin/eagle";
import { PROMPT_OPTIMIZER_PLUGIN_ID } from "../src/lib/plugins/builtin/prompt-optimizer";
import { getEditorSlots } from "../src/lib/plugins/editor-slot-registry";
import {
    activateClientPluginModule,
    deactivateAllClientPlugins,
    deactivateClientPlugin,
    syncActiveClientPlugins,
} from "../src/lib/plugins/plugin-client-loader";
import {
    clearAllPluginEvents,
    disposePluginEvents,
    emitPluginEvent,
    getPluginEventListenerCount,
    onPluginEvent,
} from "../src/lib/plugins/plugin-events";
import { createBeefTVPluginHost } from "../src/lib/plugins/plugin-host-runtime";
import {
    clearAllPluginContributions,
    contributeSlot,
    disposePluginContributions,
    getPluginCanvasNodeRenderer,
    getPluginSlotEntries,
    getPluginSlotItems,
    runGenerationBeforeSubmitHooks,
} from "../src/lib/plugins/slot-registry";
import { resolveInstallConfirmCopy } from "../src/pages/plugins/plugin-install-confirm-modal";
import { usePluginStore } from "../src/stores/use-plugin-store";

const DummyComponent = () => null;

const emptyMenuContext: AddNodeMenuContext = {
    handlers: {
        onAddTextNode: () => undefined,
        onAddImageNode: () => undefined,
        onAddVideoNode: () => undefined,
        onAddAudioNode: () => undefined,
        onAddTableNode: () => undefined,
        onAddShortDramaNode: () => undefined,
        onAddStoryboardNode: () => undefined,
        onAddExtensionNode: () => undefined,
        onOpenAssetLibrary: () => undefined,
        onOpenUploadPicker: () => undefined,
        onOpenStylePicker: () => undefined,
        onOpenTemplateLibrary: () => undefined,
    },
};

describe("plugin host slots, events, and lifecycle", () => {
    beforeEach(() => {
        deactivateAllClientPlugins();
        clearAllPluginContributions();
        clearAllPluginEvents();
        usePluginStore.setState({
            installations: [],
            runtimeStatuses: {},
            pluginStates: {},
        });
        syncActiveClientPlugins();
    });

    test("built-in plugins register contributions via setup(host) and clean up when disabled", () => {
        usePluginStore.getState().setEnabled(PROMPT_OPTIMIZER_PLUGIN_ID, true);
        usePluginStore.getState().setEnabled(EAGLE_PLUGIN_ID, true);
        usePluginStore.getState().setEnabled(ART_CRITIQUE_PLUGIN_ID, true);

        const promptActions = getPluginSlotEntries("canvas.promptActions");
        expect(promptActions.some((entry) => entry.pluginId === PROMPT_OPTIMIZER_PLUGIN_ID)).toBe(true);

        const appPages = getPluginSlotEntries("app.page");
        expect(appPages.some((entry) => entry.pluginId === EAGLE_PLUGIN_ID)).toBe(true);

        const appSidebar = getPluginSlotEntries("app.sidebar");
        expect(
            appSidebar.some(
                (entry) => entry.pluginId === EAGLE_PLUGIN_ID && entry.payload.path === "/p/eagle-asset-connector",
            ),
        ).toBe(true);

        const appSettings = getPluginSlotEntries("app.settings");
        expect(appSettings.some((entry) => entry.pluginId === EAGLE_PLUGIN_ID)).toBe(true);

        const assetSources = getPluginSlotEntries("assets.source");
        expect(assetSources.some((entry) => entry.pluginId === EAGLE_PLUGIN_ID)).toBe(true);

        const canvasNodes = getPluginSlotEntries("canvas.node");
        expect(
            canvasNodes.some(
                (entry) => entry.pluginId === ART_CRITIQUE_PLUGIN_ID && entry.payload.type === ART_CRITIQUE_NODE_TYPE,
            ),
        ).toBe(true);

        // Disable Eagle and verify immediate removal from all 4 slots
        usePluginStore.getState().setEnabled(EAGLE_PLUGIN_ID, false);
        expect(getPluginSlotEntries("app.page").some((entry) => entry.pluginId === EAGLE_PLUGIN_ID)).toBe(false);
        expect(getPluginSlotEntries("app.sidebar").some((entry) => entry.pluginId === EAGLE_PLUGIN_ID)).toBe(false);
        expect(getPluginSlotEntries("app.settings").some((entry) => entry.pluginId === EAGLE_PLUGIN_ID)).toBe(false);
        expect(getPluginSlotEntries("assets.source").some((entry) => entry.pluginId === EAGLE_PLUGIN_ID)).toBe(false);

        // Re-enable Eagle and verify immediate restoration
        usePluginStore.getState().setEnabled(EAGLE_PLUGIN_ID, true);
        expect(getPluginSlotEntries("app.sidebar").some((entry) => entry.pluginId === EAGLE_PLUGIN_ID)).toBe(true);
    });

    test("supports all 21 UI slots and bridges canvas/editor registries with automatic disposal", () => {
        const pluginId = "slot-probe-plugin";
        usePluginStore.getState().ensurePlugin({
            id: pluginId,
            name: "挂点测试插件",
            version: "1.0.0",
            description: "测试全部 21 个挂点",
            permissions: [],
            contributes: {},
        });
        usePluginStore.getState().setEnabled(pluginId, true);

        const host = createBeefTVPluginHost(pluginId);

        // 1. canvas.node
        host.contribute("canvas.node", {
            type: "plugin:slot-probe:sticky",
            label: "便签节点",
            component: DummyComponent,
        });
        expect(getPluginCanvasNodeRenderer("plugin:slot-probe:sticky")?.pluginId).toBe(pluginId);
        expect(getNodeDefinition("plugin:slot-probe:sticky")?.label).toBe("便签节点");

        // 2. canvas.addNodeMenu
        host.contribute("canvas.addNodeMenu", {
            id: "probe-add-node",
            label: "新建便签",
            onSelect: () => {},
        });
        expect(getAddNodeMenuCommands().some((t) => t.id === `plugin:${pluginId}:addNodeMenu:probe-add-node`)).toBe(true);
        expect(
            resolveAddNodeMenuCommands(emptyMenuContext).some(
                (t) => t.id === `plugin:${pluginId}:addNodeMenu:probe-add-node`,
            ),
        ).toBe(true);

        // 3-5. canvas.toolbar.main, canvas.toolbar.selection, canvas.toolbar.nodeHover
        host.contribute("canvas.toolbar.main", { id: "probe-tb-main", label: "主工具栏动作", onClick: () => {} });
        host.contribute("canvas.toolbar.selection", { id: "probe-tb-sel", label: "多选动作", onClick: () => {} });
        host.contribute("canvas.toolbar.nodeHover", { id: "probe-tb-hover", label: "悬停动作", onClick: () => {} });
        expect(getToolbarTools("main").some((t) => t.id === `plugin:${pluginId}:main:probe-tb-main`)).toBe(true);
        expect(getToolbarTools("selection").some((t) => t.id === `plugin:${pluginId}:selection:probe-tb-sel`)).toBe(true);
        expect(getToolbarTools("node-hover").some((t) => t.id === `plugin:${pluginId}:node-hover:probe-tb-hover`)).toBe(true);

        // 6-13. canvas.contextMenu, canvas.nodePanel, canvas.sidePanel, canvas.promptActions,
        // generation.beforeSubmit, assistant.toolCard, assets.source, assets.itemActions
        host.contribute("canvas.contextMenu", { id: "probe-ctx", label: "右键动作", onSelect: () => {} });
        host.contribute("canvas.nodePanel", { id: "probe-panel", title: "节点面板", component: DummyComponent });
        host.contribute("canvas.sidePanel", { id: "probe-side", title: "插件侧栏", component: DummyComponent });
        host.contribute("canvas.promptActions", { id: "probe-prompt", label: "提示词动作", onClick: () => {} });
        host.contribute("generation.beforeSubmit", {
            id: "probe-hook",
            transform: (ctx) => ({ prompt: `${ctx.prompt} [probe]` }),
        });
        host.contribute("assistant.toolCard", { toolName: "probe_tool", component: DummyComponent });
        host.contribute("assets.source", {
            id: "probe-source",
            name: "测试素材源",
            provider: {
                list: async () => [],
            },
        });
        host.contribute("assets.itemActions", { id: "probe-asset-act", label: "素材动作", onSelect: () => {} });

        // 14. All 8 editor slots
        const editorSlotMappings = [
            ["editor.leftSidebar.panels", "asset-ingest"],
            ["editor.rightInspector.sections", "inspector"],
            ["editor.bottomDock.tabs", "timeline-panel"],
            ["editor.previewOverlay", "preview-renderer"],
            ["editor.timeline.trackHeaders", "subtitle-tool"],
            ["editor.timeline.clipOverlays", "transcription-provider"],
            ["editor.toolbar.actions", "export-renderer"],
            ["editor.contextMenu.items", "ai-assistant"],
        ] as const;

        for (const [slotName, mappedKind] of editorSlotMappings) {
            host.contribute(slotName, {
                id: `probe-${slotName}`,
                title: `测试 ${slotName}`,
                render: () => null,
            });
            expect(getEditorSlots(mappedKind).some((entry) => entry.pluginId === pluginId)).toBe(true);
        }

        // 15-21. app.page, app.sidebar, app.command, app.settings, project.view, pluginCenter.section
        host.contribute("app.page", { title: "测试页面", component: DummyComponent });
        host.contribute("app.sidebar", { id: "probe-nav", label: "测试导航", path: "/p/slot-probe-plugin" });
        host.contribute("app.command", { id: "probe-cmd", title: "测试命令", handler: () => {} });
        host.contribute("app.settings", { title: "测试设置", component: DummyComponent });
        host.contribute("project.view", { id: "probe-proj-view", label: "插件视图", component: DummyComponent });
        host.contribute("pluginCenter.section", { id: "probe-market", label: "插件市场", component: DummyComponent });

        expect(getPluginSlotItems("canvas.contextMenu")).toHaveLength(1);
        expect(getPluginSlotItems("canvas.nodePanel")).toHaveLength(1);
        expect(getPluginSlotItems("canvas.sidePanel")).toHaveLength(1);
        expect(getPluginSlotItems("assistant.toolCard")).toHaveLength(1);
        expect(getPluginSlotItems("assets.itemActions")).toHaveLength(1);
        expect(getPluginSlotItems("app.command")).toHaveLength(1);
        expect(getPluginSlotItems("project.view")).toHaveLength(1);
        expect(getPluginSlotItems("pluginCenter.section")).toHaveLength(1);

        // Disable plugin and verify every single slot and bridged registry entry disappears immediately
        usePluginStore.getState().setEnabled(pluginId, false);
        expect(getPluginCanvasNodeRenderer("plugin:slot-probe:sticky")).toBeUndefined();
        expect(getNodeDefinition("plugin:slot-probe:sticky")).toBeUndefined();
        expect(
            resolveAddNodeMenuCommands(emptyMenuContext).some(
                (t) => t.id === `plugin:${pluginId}:addNodeMenu:probe-add-node`,
            ),
        ).toBe(false);
        expect(
            resolveToolbarTools("main", { handlers: emptyMenuContext.handlers }).some(
                (t) => t.id === `plugin:${pluginId}:main:probe-tb-main`,
            ),
        ).toBe(false);
        for (const [, mappedKind] of editorSlotMappings) {
            expect(getEditorSlots(mappedKind).some((entry) => entry.pluginId === pluginId)).toBe(false);
        }
        expect(getPluginSlotEntries("canvas.contextMenu").some((e) => e.pluginId === pluginId)).toBe(false);
        expect(getPluginSlotEntries("project.view").some((e) => e.pluginId === pluginId)).toBe(false);
        expect(getPluginSlotEntries("pluginCenter.section").some((e) => e.pluginId === pluginId)).toBe(false);
    });

    test("runGenerationBeforeSubmitHooks transforms payload and records plugin attribution", async () => {
        const pluginId = "watermark-guard";
        usePluginStore.getState().ensurePlugin({
            apiVersion: "beeftv.plugin/v1",
            id: pluginId,
            name: "提示词增强器",
            version: "1.0.0",
            description: "测试生成前钩子",
            permissions: [],
            contributes: {},
        });

        contributeSlot(pluginId, "generation.beforeSubmit", {
            id: "append-tag",
            transform: async (ctx) => ({
                prompt: `${ctx.prompt}, cinematic lighting`,
                params: { ...ctx.params, quality: "hd" },
            }),
        });

        const result = await runGenerationBeforeSubmitHooks({
            nodeId: "node-1",
            nodeType: "image",
            prompt: "a cute cat",
            model: "gpt-image-1",
            params: {},
        });

        expect(result.prompt).toBe("a cute cat, cinematic lighting");
        expect(result.params).toEqual({ quality: "hd" });
        expect(result.adjustedByPlugins).toEqual([{ pluginId, pluginName: "提示词增强器" }]);
        expect(result.notifications).toEqual(["已由插件「提示词增强器」调整生成参数"]);

        disposePluginContributions(pluginId);
    });

    test("plugin event bus supports all 8 events, isolates listener errors, and disposes on disable", async () => {
        const pluginId = "event-listener-plugin";
        usePluginStore.getState().ensurePlugin({
            id: pluginId,
            name: "事件监听插件",
            version: "1.0.0",
            description: "测试事件总线",
            permissions: [],
            contributes: {},
        });

        const received: string[] = [];
        onPluginEvent(pluginId, "canvas.opened", (p) => {
            received.push(`opened:${p.projectId}`);
        });
        onPluginEvent(pluginId, "canvas.changed", () => {
            throw new Error("boom in listener");
        });
        onPluginEvent(pluginId, "canvas.changed", (p) => {
            received.push(`changed:${p.nodeCount}`);
        });
        onPluginEvent(pluginId, "canvas.selectionChanged", (p) => {
            received.push(`sel:${p.selectedNodeIds.join(",")}`);
        });
        onPluginEvent(pluginId, "generation.submitted", (p) => {
            received.push(`sub:${p.nodeId}`);
        });
        onPluginEvent(pluginId, "generation.succeeded", (p) => {
            received.push(`ok:${p.nodeId}`);
        });
        onPluginEvent(pluginId, "generation.failed", (p) => {
            received.push(`fail:${p.nodeId}`);
        });
        onPluginEvent(pluginId, "assets.imported", (p) => {
            received.push(`assets:${p.assets.length}`);
        });
        onPluginEvent(pluginId, "assistant.turnCompleted", (p) => {
            received.push(`turn:${p.turnId}`);
        });

        emitPluginEvent("canvas.opened", { projectId: "p1", canvasId: "c1" });
        emitPluginEvent("canvas.changed", { projectId: "p1", canvasId: "c1", nodeCount: 3, connectionCount: 2 });
        emitPluginEvent("canvas.selectionChanged", { selectedNodeIds: ["n1", "n2"] });
        emitPluginEvent("generation.submitted", { nodeId: "n1", nodeType: "image", prompt: "cat" });
        emitPluginEvent("generation.succeeded", {
            nodeId: "n1",
            nodeType: "image",
            resultUrls: ["https://example.com/1.png"],
        });
        emitPluginEvent("generation.failed", { nodeId: "n1", nodeType: "image", error: "timeout" });
        emitPluginEvent("assets.imported", {
            assets: [{ id: "a1", name: "1.png", type: "image", url: "https://example.com/1.png" }],
        });
        emitPluginEvent("assistant.turnCompleted", { sessionId: "s1", turnId: "t1", status: "completed" });

        expect(received).toEqual([
            "opened:p1",
            "changed:3",
            "sel:n1,n2",
            "sub:n1",
            "ok:n1",
            "fail:n1",
            "assets:1",
            "turn:t1",
        ]);

        disposePluginEvents(pluginId);
        expect(getPluginEventListenerCount("canvas.opened")).toBe(0);
    });

    test("activateClientPluginModule isolates faulty plugins, rolls back partial slots, and marks invalid", async () => {
        const brokenPluginId = "broken-client-plugin";
        usePluginStore.getState().ensurePlugin({
            id: brokenPluginId,
            name: "损坏的前端插件",
            version: "1.0.0",
            description: "用于测试错误隔离",
            permissions: [],
            contributes: {},
        });

        const ok = await activateClientPluginModule(
            brokenPluginId,
            {
                activate(host) {
                    host.contribute("app.command", {
                        id: "broken-cmd",
                        title: "半途而废的命令",
                        handler: () => {},
                    });
                    throw new Error("activate crashed after partial contribution");
                },
            },
            { reportBackendError: false },
        );

        expect(ok).toBe(false);
        // Partial contribution must be rolled back
        expect(getPluginSlotEntries("app.command").some((e) => e.pluginId === brokenPluginId)).toBe(false);
        // Runtime status marked invalid and error recorded
        expect(usePluginStore.getState().runtimeStatuses[brokenPluginId]).toBe("invalid");
        const installation = usePluginStore.getState().installations.find((i) => i.manifest.id === brokenPluginId);
        expect(installation?.lastError).toContain("activate crashed after partial contribution");

        deactivateClientPlugin(brokenPluginId);
    });

    test("resolveInstallConfirmCopy produces required risk copy and trust tier gating", () => {
        const communityCopy = resolveInstallConfirmCopy({
            id: "community-demo",
            name: "社区插件",
            version: "1.0.0",
            source: "market",
            trustTier: "community",
            permissions: ["canvas.write"],
            hasClientCode: true,
            hasNativeHostCode: true,
        });
        expect(communityCopy.trustMeta.requiresExplicitTrust).toBe(true);
        expect(communityCopy.clientWarning).toBe("此插件包含前端界面代码，将在当前应用界面中运行。");
        expect(communityCopy.nativeWarning).toBe(
            "此插件包含本地扩展代码，可在你的电脑上读写文件、访问网络或调用外部程序。",
        );
        expect(communityCopy.checkboxLabel).toBe("我确认信任此插件来源并了解其本地执行权限");

        const officialCopy = resolveInstallConfirmCopy({
            id: "official-demo",
            name: "官方插件",
            version: "1.0.0",
            source: "bundled",
            trustTier: "official",
            permissions: [],
            hasClientCode: true,
            hasNativeHostCode: false,
        });
        expect(officialCopy.trustMeta.requiresExplicitTrust).toBe(false);
        expect(officialCopy.checkboxLabel).toBeNull();
        expect(officialCopy.nativeWarning).toBeNull();
    });
});
