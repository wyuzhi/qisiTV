import { Blocks } from "lucide-react";
import { createElement, useSyncExternalStore } from "react";
import {
    type CanvasNodeDefinition,
    registerNodeDefinitions,
    registerPluginCanvasNodes,
    unregisterNodeDefinitions,
} from "@/lib/canvas/node-registry";
import {
    registerAddNodeMenuCommands,
    registerToolbarTools,
    type ToolbarId,
} from "@/lib/canvas/tool-registry";
import { registerEditorSlot, unregisterPluginSlots } from "@/lib/plugins/editor-slot-registry";
import { disposePluginEvents } from "@/lib/plugins/plugin-events";
import { getRegisteredPlugin } from "@/lib/plugins/plugin-registry";
import { usePluginStore } from "@/stores/use-plugin-store";
import type {
    EditorSlotKind,
    GenerationSubmitContext,
    GenerationSubmitPatch,
    PluginCanvasNodeSlotContribution,
    PluginSlotMap,
    PluginSlotName,
} from "@/lib/plugins/plugin-types";

export type SlotContributionEntry<K extends PluginSlotName = PluginSlotName> = {
    entryId: string;
    pluginId: string;
    slot: K;
    payload: PluginSlotMap[K];
    order: number;
};

const entriesBySlot = new Map<PluginSlotName, Array<SlotContributionEntry<any>>>();
const snapshotBySlot = new Map<PluginSlotName, ReadonlyArray<SlotContributionEntry<any>>>();
const EMPTY_ENTRIES: ReadonlyArray<SlotContributionEntry<any>> = Object.freeze([]);

const activeEntryIds = new Set<string>();
const cleanupByEntryId = new Map<string, () => void>();
const canvasNodeRenderersByType = new Map<
    string,
    { entryId: string; pluginId: string; contribution: PluginCanvasNodeSlotContribution }
>();
const listeners = new Set<() => void>();
let nextEntrySeq = 1;

const EDITOR_SLOT_MAP: Record<
    | "editor.leftSidebar.panels"
    | "editor.rightInspector.sections"
    | "editor.bottomDock.tabs"
    | "editor.previewOverlay"
    | "editor.timeline.trackHeaders"
    | "editor.timeline.clipOverlays"
    | "editor.toolbar.actions"
    | "editor.contextMenu.items"
    | "editor.timeline-panel"
    | "editor.preview-renderer"
    | "editor.inspector"
    | "editor.asset-ingest"
    | "editor.subtitle-tool"
    | "editor.transcription-provider"
    | "editor.export-renderer"
    | "editor.ai-assistant",
    EditorSlotKind
> = {
    "editor.leftSidebar.panels": "asset-ingest",
    "editor.rightInspector.sections": "inspector",
    "editor.bottomDock.tabs": "timeline-panel",
    "editor.previewOverlay": "preview-renderer",
    "editor.timeline.trackHeaders": "subtitle-tool",
    "editor.timeline.clipOverlays": "transcription-provider",
    "editor.toolbar.actions": "export-renderer",
    "editor.contextMenu.items": "ai-assistant",
    "editor.timeline-panel": "timeline-panel",
    "editor.preview-renderer": "preview-renderer",
    "editor.inspector": "inspector",
    "editor.asset-ingest": "asset-ingest",
    "editor.subtitle-tool": "subtitle-tool",
    "editor.transcription-provider": "transcription-provider",
    "editor.export-renderer": "export-renderer",
    "editor.ai-assistant": "ai-assistant",
};

function notifyListeners(): void {
    for (const listener of listeners) {
        try {
            listener();
        } catch (err) {
            console.warn("[slot-registry] Listener failed:", err);
        }
    }
}

function updateSlotSnapshot(slot: PluginSlotName): void {
    const bucket = entriesBySlot.get(slot);
    if (!bucket || bucket.length === 0) {
        snapshotBySlot.delete(slot);
        return;
    }
    const sorted = [...bucket].sort((a, b) => {
        const orderA = typeof (a.payload as { order?: number })?.order === "number" ? (a.payload as { order: number }).order : 0;
        const orderB = typeof (b.payload as { order?: number })?.order === "number" ? (b.payload as { order: number }).order : 0;
        if (orderA !== orderB) return orderA - orderB;
        return a.order - b.order;
    });
    snapshotBySlot.set(slot, Object.freeze(sorted));
}

function toCanvasNodeDefinition(pluginId: string, contribution: PluginCanvasNodeSlotContribution): CanvasNodeDefinition {
    const defaultSize = contribution.defaultSize ?? { width: 320, height: 220 };
    return {
        type: contribution.type,
        label: contribution.label,
        defaultTitle: contribution.defaultTitle || contribution.label,
        defaultSize,
        minSize: {
            width: Math.min(240, defaultSize.width),
            height: Math.min(180, defaultSize.height),
        },
        icon: contribution.icon ?? createElement(Blocks, { "aria-hidden": true }),
        showInCreateMenu: contribution.allowCreateFromMenu ?? true,
        acceptsInputKind: contribution.acceptsInputKind,
        maxInputCount: contribution.maxInputCount,
        showOutputConnection: contribution.showOutputConnection ?? true,
        plugin: {
            pluginId,
            renderer: contribution.component ? "client" : "declarative",
            schema: contribution.schema ?? {},
        },
    };
}

function syncPluginCanvasNodeDefinitions(pluginId: string): void {
    unregisterNodeDefinitions(pluginId);
    const registered = getRegisteredPlugin(pluginId);
    if (registered?.manifest.contributes.canvasNodes?.length) {
        registerPluginCanvasNodes(pluginId, registered.manifest.contributes.canvasNodes);
    }
    const nodeEntries = (entriesBySlot.get("canvas.node") ?? []) as Array<SlotContributionEntry<"canvas.node">>;
    const defs = nodeEntries
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => toCanvasNodeDefinition(pluginId, entry.payload));
    if (defs.length > 0) {
        registerNodeDefinitions(defs, pluginId);
    }
}

export function isSlotEntryActive(entryId: string): boolean {
    return activeEntryIds.has(entryId);
}

export function contributeSlot<K extends PluginSlotName>(
    pluginId: string,
    slot: K,
    rawPayload: PluginSlotMap[K],
): () => void {
    const entryId = `${pluginId}:${slot}:${nextEntrySeq++}`;
    const order = nextEntrySeq;
    const raw = (rawPayload ?? {}) as Record<string, unknown>;
    const normalized: Record<string, unknown> = { ...raw };
    if (!normalized.component && typeof normalized.render === "function") {
        normalized.component = normalized.render;
    }
    if (!normalized.render && typeof normalized.component === "function") {
        normalized.render = normalized.component;
    }
    if (!normalized.label && typeof normalized.title === "string") {
        normalized.label = normalized.title;
    }
    if (!normalized.title && typeof normalized.label === "string") {
        normalized.title = normalized.label;
    }
    if (!normalized.handler && typeof (normalized.onSelect ?? normalized.run ?? normalized.onClick) === "function") {
        normalized.handler = normalized.onSelect ?? normalized.run ?? normalized.onClick;
    }
    if (!normalized.onSelect && typeof (normalized.handler ?? normalized.run ?? normalized.onClick) === "function") {
        normalized.onSelect = normalized.handler ?? normalized.run ?? normalized.onClick;
    }
    const payload = normalized as PluginSlotMap[K];
    const entry: SlotContributionEntry<K> = {
        entryId,
        pluginId,
        slot,
        payload,
        order,
    };

    let bucket = entriesBySlot.get(slot);
    if (!bucket) {
        bucket = [];
        entriesBySlot.set(slot, bucket);
    }
    bucket.push(entry);
    activeEntryIds.add(entryId);

    const bridgeDisposers: Array<() => void> = [];

    if (slot === "canvas.node") {
        const nodePayload = payload as PluginSlotMap["canvas.node"];
        canvasNodeRenderersByType.set(nodePayload.type, {
            entryId,
            pluginId,
            contribution: nodePayload,
        });
        syncPluginCanvasNodeDefinitions(pluginId);
        bridgeDisposers.push(() => {
            const current = canvasNodeRenderersByType.get(nodePayload.type);
            if (current?.entryId === entryId) {
                canvasNodeRenderersByType.delete(nodePayload.type);
            }
            syncPluginCanvasNodeDefinitions(pluginId);
        });
    } else if (slot === "canvas.addNodeMenu") {
        const menuPayload = payload as PluginSlotMap["canvas.addNodeMenu"];
        registerAddNodeMenuCommands([
            {
                id: `plugin:${pluginId}:addNodeMenu:${menuPayload.id}`,
                label: menuPayload.label,
                icon: menuPayload.icon ?? createElement(Blocks, { className: "h-4 w-4", "aria-hidden": true }),
                section: "node",
                defaultOrder: menuPayload.order ?? 1100,
                applicable: (ctx) =>
                    activeEntryIds.has(entryId) && (!ctx.enabledPluginIds || ctx.enabledPluginIds.has(pluginId)),
                run: (ctx) => {
                    void menuPayload.onSelect({
                        ...ctx,
                        position: { x: 0, y: 0 },
                        createNode: (input) => {
                            ctx.handlers.onAddExtensionNode(input.type);
                            return null;
                        },
                    } as Parameters<typeof menuPayload.onSelect>[0]);
                },
            },
        ]);
    } else if (
        slot === "canvas.toolbar.main" ||
        slot === "canvas.toolbar.selection" ||
        slot === "canvas.toolbar.nodeHover"
    ) {
        const toolPayload = payload as PluginSlotMap["canvas.toolbar.main"];
        const toolbarId: ToolbarId =
            slot === "canvas.toolbar.main"
                ? "main"
                : slot === "canvas.toolbar.selection"
                  ? "selection"
                  : "node-hover";
        registerToolbarTools([
            {
                id: `plugin:${pluginId}:${toolbarId}:${toolPayload.id}`,
                toolbar: toolbarId,
                category: "create",
                label: toolPayload.label,
                icon: toolPayload.icon ?? createElement(Blocks, { className: "h-4 w-4", "aria-hidden": true }),
                defaultVisible: true,
                defaultOrder: toolPayload.order ?? 950,
                applicable: (ctx) => {
                    if (!activeEntryIds.has(entryId)) return false;
                    if (!toolPayload.when) return true;
                    return toolPayload.when({
                        selectedNodeIds: ctx.node ? [ctx.node.id] : [],
                        selectedNodes: ctx.node ? [ctx.node] : [],
                        hoveredNode: ctx.node ?? null,
                    });
                },
                run: (ctx) => {
                    void toolPayload.onClick?.({
                        selectedNodeIds: ctx.node ? [ctx.node.id] : [],
                        selectedNodes: ctx.node ? [ctx.node] : [],
                        hoveredNode: ctx.node ?? null,
                    });
                },
            },
        ]);
    } else if (slot in EDITOR_SLOT_MAP) {
        const editorPayload = payload as PluginSlotMap["editor.leftSidebar.panels"];
        const mappedKind = EDITOR_SLOT_MAP[slot as keyof typeof EDITOR_SLOT_MAP];
        const disposeEditor = registerEditorSlot({
            pluginId,
            slot: mappedKind,
            priority: -(editorPayload.order ?? 0),
            render: () => editorPayload.render({ projectId: "", currentTimeMs: 0 }),
        });
        bridgeDisposers.push(disposeEditor);
    }

    const cleanup = () => {
        if (!activeEntryIds.has(entryId)) return;
        activeEntryIds.delete(entryId);
        cleanupByEntryId.delete(entryId);
        const currentBucket = entriesBySlot.get(slot);
        if (currentBucket) {
            const idx = currentBucket.findIndex((item) => item.entryId === entryId);
            if (idx >= 0) {
                currentBucket.splice(idx, 1);
            }
            if (currentBucket.length === 0) {
                entriesBySlot.delete(slot);
            }
        }
        for (const dispose of bridgeDisposers) {
            try {
                dispose();
            } catch (err) {
                console.warn("[slot-registry] Bridge disposer failed:", err);
            }
        }
        updateSlotSnapshot(slot);
        notifyListeners();
    };

    cleanupByEntryId.set(entryId, cleanup);
    updateSlotSnapshot(slot);
    notifyListeners();

    return cleanup;
}

export function disposePluginContributions(pluginId: string): void {
    const entriesToDispose: Array<() => void> = [];
    for (const bucket of entriesBySlot.values()) {
        for (const entry of bucket) {
            if (entry.pluginId === pluginId) {
                const fn = cleanupByEntryId.get(entry.entryId);
                if (fn) entriesToDispose.push(fn);
            }
        }
    }
    for (const fn of entriesToDispose) {
        fn();
    }
    syncPluginCanvasNodeDefinitions(pluginId);
    unregisterPluginSlots(pluginId);
    disposePluginEvents(pluginId);
}

export function clearAllPluginContributions(): void {
    const allFns = Array.from(cleanupByEntryId.values());
    for (const fn of allFns) {
        fn();
    }
    entriesBySlot.clear();
    snapshotBySlot.clear();
    activeEntryIds.clear();
    cleanupByEntryId.clear();
    canvasNodeRenderersByType.clear();
    notifyListeners();
}

export function getPluginSlotEntries<K extends PluginSlotName>(slot: K): ReadonlyArray<SlotContributionEntry<K>> {
    return (snapshotBySlot.get(slot) as ReadonlyArray<SlotContributionEntry<K>> | undefined) ?? EMPTY_ENTRIES;
}

export function getPluginSlotItems<K extends PluginSlotName>(slot: K): Array<PluginSlotMap[K]> {
    return getPluginSlotEntries(slot).map((entry) => entry.payload);
}

export function subscribePluginSlots(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function usePluginSlot<K extends PluginSlotName>(slot: K): ReadonlyArray<SlotContributionEntry<K>> {
    return useSyncExternalStore(
        subscribePluginSlots,
        () => getPluginSlotEntries(slot),
        () => getPluginSlotEntries(slot),
    );
}

export function getPluginCanvasNodeRenderer(
    nodeType: string,
): { pluginId: string; contribution: PluginCanvasNodeSlotContribution } | undefined {
    const found = canvasNodeRenderersByType.get(nodeType);
    if (!found || !activeEntryIds.has(found.entryId)) return undefined;
    return {
        pluginId: found.pluginId,
        contribution: found.contribution,
    };
}

export async function runGenerationBeforeSubmitHooks(
    initialCtx: GenerationSubmitContext,
): Promise<{
    prompt: string;
    params: Record<string, unknown>;
    metadata: Record<string, unknown>;
    adjustedByPlugins: Array<{ pluginId: string; pluginName: string }>;
    notifications: string[];
}> {
    const entries = getPluginSlotEntries("generation.beforeSubmit");
    let prompt = initialCtx.prompt;
    let params = { ...initialCtx.params };
    let metadata = { ...(initialCtx.metadata ?? {}) };
    const adjustedByPlugins: Array<{ pluginId: string; pluginName: string }> = [];
    const notifications: string[] = [];

    for (const entry of entries) {
        if (entry.payload.nodeTypes?.length && !entry.payload.nodeTypes.includes(initialCtx.nodeType)) {
            continue;
        }
        try {
            const patch = await entry.payload.transform({
                ...initialCtx,
                prompt,
                params: { ...params },
                parameters: { ...params },
                metadata: { ...metadata },
            } as GenerationSubmitContext);
            if (!patch) continue;
            const rawPatch = patch as GenerationSubmitPatch & { parameters?: Record<string, unknown>; reason?: string };
            let modified = false;
            if (typeof rawPatch.prompt === "string" && rawPatch.prompt !== prompt) {
                prompt = rawPatch.prompt;
                modified = true;
            }
            const nextParams = rawPatch.params ?? rawPatch.parameters;
            if (nextParams && Object.keys(nextParams).length > 0) {
                params = { ...params, ...nextParams };
                modified = true;
            }
            if (rawPatch.metadata && Object.keys(rawPatch.metadata).length > 0) {
                metadata = { ...metadata, ...rawPatch.metadata };
                modified = true;
            }
            if (typeof rawPatch.reason === "string" && rawPatch.reason.trim()) {
                modified = true;
            }
            if (modified) {
                const pluginName =
                    getRegisteredPlugin(entry.pluginId)?.manifest.name ||
                    usePluginStore.getState().installations.find((item) => item.manifest.id === entry.pluginId)?.manifest.name ||
                    entry.pluginId;
                adjustedByPlugins.push({ pluginId: entry.pluginId, pluginName });
                notifications.push(`已由插件「${pluginName}」调整生成参数`);
            }
        } catch (err) {
            console.warn(`[slot-registry] generation.beforeSubmit hook error (${entry.pluginId}):`, err);
        }
    }

    return {
        prompt,
        params,
        metadata,
        adjustedByPlugins,
        notifications,
    };
}

