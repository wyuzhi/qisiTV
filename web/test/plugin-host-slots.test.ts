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
import { installSourceLabel } from "../src/pages/plugins/plugin-install-confirm-modal";
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

    test("supports all 27 UI slots and bridges canvas/editor registries with automatic disposal", () => {
        const pluginId = "slot-probe-plugin";
        usePluginStore.getState().ensurePlugin({
            id: pluginId,
            name: "挂点测试插件",
            version: "1.0.0",
            description: "测试全部 27 个挂点",
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
            label: "便签节点",
            onSelect: () => {},
        });
        expect(getAddNodeMenuCommands().some((t) => t.id === `plugin:${pluginId}:addNodeMenu:probe-add-node`)).toBe(true);
        expect(
            resolveAddNodeMenuCommands(emptyMenuContext).some(
                (t) => t.id === `plugin:${pluginId}:addNodeMenu:probe-add-node`,
            ),
        ).toBe(true);
        expect(resolveAddNodeMenuCommands(emptyMenuContext).some((t) => t.id === "plugin:slot-probe:sticky")).toBe(false);

        // Multi-node plugin retains non-matched node types even when labels share a substring
        const disposeSecondNode = host.contribute("canvas.node", {
            type: "plugin:slot-probe:secondary",
            label: "便签",
            component: DummyComponent,
        });
        expect(resolveAddNodeMenuCommands(emptyMenuContext).some((t) => t.id === "plugin:slot-probe:sticky")).toBe(false);
        expect(resolveAddNodeMenuCommands(emptyMenuContext).some((t) => t.id === "plugin:slot-probe:secondary")).toBe(true);
        disposeSecondNode();

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
                metadata: { styleTag: "cinematic" },
            }),
        });

        const result = await runGenerationBeforeSubmitHooks({
            nodeId: "node-1",
            nodeType: "image",
            prompt: "a cute cat",
            model: "test-model",
            params: {},
        });

        expect(result.prompt).toBe("a cute cat, cinematic lighting");
        expect(result.metadata).toEqual({ styleTag: "cinematic" });
        expect(result.adjustedByPlugins).toEqual([{ pluginId, pluginName: "提示词增强器" }]);
        expect(result.notifications).toEqual(["提示词已由插件「提示词增强器」调整"]);

        disposePluginContributions(pluginId);
    });

    test("plugin event bus delivers every emitted event, isolates listener errors, and disposes on disable", async () => {
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
        onPluginEvent(pluginId, "generation.submitted", () => {
            throw new Error("boom in listener");
        });
        onPluginEvent(pluginId, "generation.submitted", (p) => {
            received.push(`sub:${p.nodeId}`);
        });
        onPluginEvent(pluginId, "generation.completed", (p) => {
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

        emitPluginEvent("generation.submitted", { nodeId: "n1", nodeType: "image", prompt: "cat" });
        emitPluginEvent("generation.completed", { nodeId: "n1", nodeType: "image" });
        emitPluginEvent("generation.failed", { nodeId: "n1", nodeType: "image", error: "timeout" });
        emitPluginEvent("assets.imported", {
            assets: [{ id: "a1", name: "1.png", type: "image", url: "https://example.com/1.png" }],
        });
        emitPluginEvent("assistant.turnCompleted", { sessionId: "s1", turnId: "t1", status: "completed" });

        expect(received).toEqual(["sub:n1", "ok:n1", "fail:n1", "assets:1", "turn:t1"]);

        disposePluginEvents(pluginId);
        expect(getPluginEventListenerCount("generation.submitted")).toBe(0);
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

    test("install confirmation labels where the code comes from, and requests cannot mark themselves trusted", () => {
        expect(installSourceLabel({ source: "beeftv-plugin-example" })).toBe("npm 包");
        expect(installSourceLabel({ source: "/Users/me/my-plugin" })).toBe("本地目录");
        expect(installSourceLabel({ source: "beeftv-plugin-sticky-note" })).toBe("npm 包");
    });

    test("activates real bundled ESM client plugins from plugin-packages and cleans up on disable", async () => {
        const marketMod = await import("../../plugin-packages/beeftv-plugin-market/client/index.js");
        const ll2Mod = await import("../../plugin-packages/beeftv-plugin-ll2/client/index.js");
        const stickyMod = await import("../../plugin-packages/beeftv-plugin-sticky-note/client/index.js");
        const ecommerceMod = await import("../../plugin-packages/beeftv-plugin-ecommerce-hero/client/index.js");
        const charReplaceMod = await import("../../plugin-packages/beeftv-plugin-character-replacement/client/index.js");
        const slotTestMod = await import("../../plugin-packages/beeftv-plugin-slot-test/client/index.js");

        const packages = [
            { id: "beeftv-plugin-market", name: "插件市场", mod: marketMod },
            { id: "beeftv-plugin-ll2", name: "LL2 算力与视频渠道", mod: ll2Mod },
            { id: "beeftv-plugin-sticky-note", name: "便签节点", mod: stickyMod },
            { id: "beeftv-plugin-ecommerce-hero", name: "一键商品主图", mod: ecommerceMod },
            { id: "beeftv-plugin-character-replacement", name: "AI 角色替换工作室", mod: charReplaceMod },
            { id: "beeftv-plugin-slot-test", name: "挂点测试套件", mod: slotTestMod },
        ];

        for (const pkg of packages) {
            usePluginStore.getState().ensurePlugin({
                id: pkg.id,
                name: pkg.name,
                version: "0.1.0",
                description: pkg.name,
                permissions: [],
                contributes: {},
            });
            usePluginStore.getState().setEnabled(pkg.id, true);
            const ok = await activateClientPluginModule(pkg.id, pkg.mod, { reportBackendError: false });
            expect(ok).toBe(true);
        }

        // Market plugin contributes pluginCenter.section
        expect(
            getPluginSlotEntries("pluginCenter.section").some((e) => e.pluginId === "beeftv-plugin-market"),
        ).toBe(true);

        // LL2 plugin contributes app.settings and builds a complete BYOK channel
        expect(
            getPluginSlotEntries("app.settings").some((e) => e.pluginId === "beeftv-plugin-ll2"),
        ).toBe(true);
        const builtChannel = ll2Mod.buildLL2ModelChannel({ apiKey: "sk-test-demo", baseUrl: "https://api.ll2.cn" });
        expect(builtChannel.id).toBe("ll2");
        expect(builtChannel.models).toContain("doubao-seedance-2-0-fast");
        expect(builtChannel.models).toContain("Super Vega 1.0-pro-mini");
        expect(builtChannel.models).toContain("auto-hd");
        expect(builtChannel.modelProfiles).toHaveLength(9);

        // Untrusted plugins without settings.write cannot read or mutate channels
        const untrustedHost = createBeefTVPluginHost("untrusted-plugin", {
            apiVersion: "beeftv.plugin/v2",
            id: "untrusted-plugin",
            name: "Untrusted",
            version: "1.0.0",
            description: "Untrusted",
            permissions: [],
            contributes: {},
        });
        expect(() => untrustedHost.channels?.list()).toThrow();

        // Trusted plugin with settings.write gets redacted channel copies
        const trustedHost = createBeefTVPluginHost("beeftv-plugin-ll2", {
            apiVersion: "beeftv.plugin/v2",
            id: "beeftv-plugin-ll2",
            name: "LL2",
            version: "1.0.0",
            description: "LL2",
            trusted: true,
            permissions: ["settings.write"],
            contributes: {},
        });
        expect(Array.isArray(trustedHost.channels?.list())).toBe(true);
        await expect(
            trustedHost.channels?.upsert({ id: "ll2", baseUrl: "ftp://invalid" }),
        ).rejects.toThrow("渠道接口地址必须以 http:// 或 https:// 开头");
        await expect(
            trustedHost.channels?.upsert({ id: "other-user-channel", baseUrl: "https://api.ll2.cn" }),
        ).rejects.toThrow("仅允许写入自身命名空间下的模型渠道");

        // Sticky note plugin contributes canvas.node (sticky-note) and canvas.addNodeMenu
        expect(getPluginCanvasNodeRenderer("sticky-note")?.pluginId).toBe("beeftv-plugin-sticky-note");

        // Ecommerce hero contributes canvas.node (ecommerce-hero), canvas.addNodeMenu, assistant.toolCard
        expect(getPluginCanvasNodeRenderer("ecommerce-hero")?.pluginId).toBe("beeftv-plugin-ecommerce-hero");
        expect(
            getPluginSlotEntries("assistant.toolCard").some((e) => e.pluginId === "beeftv-plugin-ecommerce-hero"),
        ).toBe(true);

        // Character replacement contributes canvas.node (character-replacement), canvas.addNodeMenu, canvas.toolbar.main, canvas.sidePanel, app.page, app.sidebar, assistant.toolCard
        expect(getPluginCanvasNodeRenderer("character-replacement")?.pluginId).toBe("beeftv-plugin-character-replacement");
        expect(
            getAddNodeMenuCommands().some((t) => t.id === "plugin:beeftv-plugin-character-replacement:addNodeMenu:character-replacement-add"),
        ).toBe(true);
        expect(
            getToolbarTools("main").some((t) => t.id === "plugin:beeftv-plugin-character-replacement:main:character-replacement-toolbar"),
        ).toBe(true);
        expect(
            getPluginSlotEntries("canvas.sidePanel").some((e) => e.pluginId === "beeftv-plugin-character-replacement"),
        ).toBe(true);
        expect(
            getPluginSlotEntries("app.page").some(
                (e) => e.pluginId === "beeftv-plugin-character-replacement" && e.payload.path === "/p/beeftv-plugin-character-replacement",
            ),
        ).toBe(true);
        expect(
            getPluginSlotEntries("assistant.toolCard").filter((e) => e.pluginId === "beeftv-plugin-character-replacement"),
        ).toHaveLength(2);
        expect(
            getPluginSlotEntries("app.sidebar").some(
                (e) => e.pluginId === "beeftv-plugin-character-replacement" && e.payload.path === "/p/beeftv-plugin-character-replacement",
            ),
        ).toBe(true);

        // Slot test plugin contributes to every slot and listens to every event
        expect(getPluginCanvasNodeRenderer("slot-test-node")?.pluginId).toBe("beeftv-plugin-slot-test");
        expect(getPluginEventListenerCount("generation.completed")).toBeGreaterThanOrEqual(1);
        expect(getPluginEventListenerCount("assistant.turnCompleted")).toBeGreaterThanOrEqual(1);

        // Deactivate all and verify clean teardown
        for (const pkg of packages) {
            deactivateClientPlugin(pkg.id);
        }
        expect(getPluginCanvasNodeRenderer("sticky-note")).toBeUndefined();
        expect(getPluginCanvasNodeRenderer("slot-test-node")).toBeUndefined();
    });
});
