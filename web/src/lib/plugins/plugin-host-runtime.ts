import type { ComponentType } from "react";
import { emitPluginEvent, onPluginEvent } from "@/lib/plugins/plugin-events";
import { getRegisteredPlugin } from "@/lib/plugins/plugin-registry";
import { pluginStorageFor } from "@/lib/plugins/plugin-storage";
import {
    PLUGIN_API_VERSION,
    type BeefTVPluginHost,
    type PluginCanvasNodeProps,
    type PluginCanvasNodeSlotContribution,
    type PluginManifest,
    type PluginManifestV2,
} from "@/lib/plugins/plugin-types";
import { contributeSlot } from "@/lib/plugins/slot-registry";
import { http } from "@/services/api/request";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { usePluginStore } from "@/stores/use-plugin-store";

type GlobalBeefTVPluginHost = {
    registerNodeRenderer: (
        type: string,
        fn: ComponentType<PluginCanvasNodeProps>,
        options?: Partial<PluginCanvasNodeSlotContribution> & { pluginId?: string },
    ) => () => void;
    createHost: (pluginId: string, manifest?: PluginManifest | PluginManifestV2) => BeefTVPluginHost;
    contribute: typeof contributeSlot;
    events: {
        on: typeof onPluginEvent;
        emit: typeof emitPluginEvent;
    };
};

declare global {
    interface Window {
        __BEEFTV_PLUGIN_HOST__?: GlobalBeefTVPluginHost;
    }
}

let customNavigator: ((path: string) => void) | null = null;

export function setPluginHostNavigator(fn: ((path: string) => void) | null): void {
    customNavigator = fn;
}

function defaultManifestFor(pluginId: string): PluginManifest | PluginManifestV2 {
    const registered = getRegisteredPlugin(pluginId);
    if (registered) return registered.manifest;
    const installed = usePluginStore.getState().installations.find((item) => item.manifest.id === pluginId);
    if (installed) return installed.manifest;
    return {
        apiVersion: PLUGIN_API_VERSION,
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        description: "",
        permissions: [],
        contributes: {},
    };
}

export function createBeefTVPluginHost(
    pluginId: string,
    manifest?: PluginManifest | PluginManifestV2,
): BeefTVPluginHost {
    const resolvedManifest = manifest ?? defaultManifestFor(pluginId);

    return {
        pluginId,
        manifest: resolvedManifest,
        contribute: (slot, payload) => contributeSlot(pluginId, slot, payload),
        events: {
            on: (event, handler) => onPluginEvent(pluginId, event, handler),
            emit: (event, payload) => emitPluginEvent(event, payload),
        },
        storage: pluginStorageFor(pluginId),
        config: {
            getAll: () => {
                const inst = usePluginStore
                    .getState()
                    .installations.find((item) => item.manifest.id === pluginId);
                return inst?.config ?? {};
            },
            get: <T extends string | number | boolean = string>(key: string, fallback?: T): T | undefined => {
                const inst = usePluginStore
                    .getState()
                    .installations.find((item) => item.manifest.id === pluginId);
                const val = inst?.config?.[key];
                return (val !== undefined ? (val as T) : fallback);
            },
            set: async (patch) => {
                await usePluginStore.getState().updateConfig(pluginId, patch);
            },
        },
        ui: {
            notify: (msg, level = "info") => {
                if (typeof window !== "undefined") {
                    import("antd")
                        .then(({ message }) => {
                            const handler = message[level] ?? message.info;
                            handler(msg);
                        })
                        .catch(() => {
                            console.info(`[plugin:${pluginId}:${level}] ${msg}`);
                        });
                }
            },
            navigate: (path) => {
                if (customNavigator) {
                    customNavigator(path);
                    return;
                }
                if (typeof window !== "undefined") {
                    window.history.pushState({}, "", path);
                    window.dispatchEvent(new PopStateEvent("popstate"));
                }
            },
        },
        ai: {
            generateText: async (input) => {
                const res = await http.post<{ text: string; model: string }>("/ai/text", {
                    prompt: input.prompt,
                    systemPrompt: input.systemPrompt,
                    model: input.model,
                    pluginId,
                });
                return {
                    text: res?.text ?? "",
                    model: res?.model ?? input.model ?? "default",
                };
            },
        },
        canvas: {
            getNodes: () => useCanvasStore.getState().projects[0]?.nodes ?? [],
            getSelectedNodeIds: () => [],
            updateNode: (nodeId, patch) => {
                const state = useCanvasStore.getState();
                const proj = state.projects.find((p) => p.nodes.some((n) => n.id === nodeId));
                if (proj) {
                    state.updateProject(proj.id, {
                        nodes: proj.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
                    });
                }
            },
        },
        assets: {
            list: () => useAssetStore.getState().assets ?? [],
        },
    };
}

export function ensureGlobalPluginHost(): GlobalBeefTVPluginHost {
    const globalHost: GlobalBeefTVPluginHost = {
        registerNodeRenderer: (type, fn, options) => {
            const ownerPluginId = options?.pluginId ?? "global-plugin";
            return contributeSlot(ownerPluginId, "canvas.node", {
                type,
                label: options?.label ?? type,
                defaultTitle: options?.defaultTitle ?? options?.label ?? type,
                defaultSize: options?.defaultSize ?? { width: 320, height: 220 },
                icon: options?.icon,
                ports: options?.ports,
                schema: options?.schema,
                category: options?.category,
                allowCreateFromMenu: options?.allowCreateFromMenu,
                acceptsInputKind: options?.acceptsInputKind,
                maxInputCount: options?.maxInputCount,
                showOutputConnection: options?.showOutputConnection,
                component: fn,
            });
        },
        createHost: createBeefTVPluginHost,
        contribute: contributeSlot,
        events: {
            on: onPluginEvent,
            emit: emitPluginEvent,
        },
    };

    if (typeof window !== "undefined") {
        window.__BEEFTV_PLUGIN_HOST__ = globalHost;
    }
    return globalHost;
}

ensureGlobalPluginHost();
