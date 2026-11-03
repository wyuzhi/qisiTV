import * as React from "react";
import { emitPluginEvent, onPluginEvent } from "@/lib/plugins/plugin-events";
import { getRegisteredPlugin } from "@/lib/plugins/plugin-registry";
import { pluginStorageFor } from "@/lib/plugins/plugin-storage";
import {
    PLUGIN_API_VERSION,
    type BeefTVPluginHost,
    type PluginInstallConfirmRequest,
    type PluginManifest,
    type PluginManifestV2,
} from "@/lib/plugins/plugin-types";
import { contributeSlot } from "@/lib/plugins/slot-registry";
import { executeWorkspaceOperation } from "@/services/api/operations";
import { useAssetStore } from "@/stores/use-asset-store";
import { usePluginStore } from "@/stores/use-plugin-store";

/** The host install confirmation listens for this event; plugins never install directly. */
export const PLUGIN_INSTALL_REQUEST_EVENT = "beeftv:plugin-install-request";

export function requestPluginInstall(request: PluginInstallConfirmRequest): void {
    const source = typeof request?.source === "string" ? request.source.trim() : "";
    if (!source || typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<PluginInstallConfirmRequest>(PLUGIN_INSTALL_REQUEST_EVENT, { detail: { ...request, source } }));
}

let customNavigator: ((path: string) => void) | null = null;

export function setPluginHostNavigator(fn: ((path: string) => void) | null): void {
    customNavigator = fn;
}

/** The open canvas is the one in the route; the canvas store keeps every loaded canvas. */
function currentCanvasId(): string | undefined {
    if (typeof window === "undefined") return undefined;
    const match = /^\/canvas\/([^/]+)/.exec(window.location.pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
}

function defaultManifestFor(pluginId: string): PluginManifest | PluginManifestV2 {
    const registered = getRegisteredPlugin(pluginId);
    if (registered) return registered.manifest;
    const installed = usePluginStore.getState().installations.find((item) => item.manifest.id === pluginId);
    if (installed) return installed.manifest;
    return { apiVersion: PLUGIN_API_VERSION, id: pluginId, name: pluginId, version: "", description: "", permissions: [], contributes: {} };
}

export function createBeefTVPluginHost(pluginId: string, manifest?: PluginManifest | PluginManifestV2): BeefTVPluginHost {
    const notify = (msg: string, level: "info" | "success" | "warning" | "error" = "info") => {
        void import("antd").then(({ message }) => message[level](msg));
    };
    const installation = () => usePluginStore.getState().installations.find((item) => item.manifest.id === pluginId);

    return {
        pluginId,
        manifest: manifest ?? defaultManifestFor(pluginId),
        React,
        contribute: (slot, payload) => contributeSlot(pluginId, slot, payload),
        events: {
            on: (event, handler) => onPluginEvent(pluginId, event, handler),
            emit: (event, payload) => emitPluginEvent(event, payload),
        },
        storage: pluginStorageFor(pluginId),
        config: {
            getAll: () => installation()?.config ?? {},
            get: <T extends string | number | boolean = string>(key: string, fallback?: T): T | undefined => {
                const value = installation()?.config?.[key];
                return value !== undefined ? (value as T) : fallback;
            },
            set: async (patch) => {
                await usePluginStore.getState().updateConfig(pluginId, patch);
            },
        },
        ui: {
            notify,
            navigate: (path) => {
                if (customNavigator) {
                    customNavigator(path);
                    return;
                }
                window.history.pushState({}, "", path);
                window.dispatchEvent(new PopStateEvent("popstate"));
            },
            requestInstallPlugin: requestPluginInstall,
        },
        ops: {
            call: async <T = unknown>(op: string, params?: Record<string, unknown>) =>
                (await executeWorkspaceOperation<T>(op, { params: params ?? {} })).result,
        },
        context: {
            getCanvasId: currentCanvasId,
        },
        assets: {
            list: () => useAssetStore.getState().assets ?? [],
        },
    };
}
