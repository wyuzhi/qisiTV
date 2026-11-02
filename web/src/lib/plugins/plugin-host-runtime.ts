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
import { http } from "@/services/api/request";
import { commitModelConfig, flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, type ModelChannel } from "@/stores/use-config-store";
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
    const resolvedManifest = manifest ?? defaultManifestFor(pluginId);

    return {
        pluginId,
        manifest: resolvedManifest,
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
        channels: {
            list: () => {
                const perms = Array.isArray(resolvedManifest.permissions) ? resolvedManifest.permissions : [];
                if (!perms.includes("settings.write") || !resolvedManifest.trusted) {
                    throw new Error(`插件 ${pluginId} 缺少可信 settings.write 权限，无法读取模型渠道列表`);
                }
                return (useConfigStore.getState().config.channels ?? []).map((item) => ({
                    ...item,
                    apiKey: "",
                    secretKey: "",
                    hasApiKey: Boolean(item.apiKey || item.hasApiKey),
                })) as unknown as Array<Record<string, unknown>>;
            },
            upsert: async (rawChannel) => {
                const perms = Array.isArray(resolvedManifest.permissions) ? resolvedManifest.permissions : [];
                if (!perms.includes("settings.write") || !resolvedManifest.trusted) {
                    throw new Error(`插件 ${pluginId} 缺少可信 settings.write 权限，无法修改模型渠道`);
                }
                const incoming = rawChannel as unknown as ModelChannel;
                const targetId = String(incoming.id || "").trim();
                if (!targetId || targetId === "beefapi") {
                    throw new Error("不允许覆盖系统内置模型渠道");
                }
                const baseUrl = String(incoming.baseUrl || "").trim();
                if (!/^https?:\/\//i.test(baseUrl)) {
                    throw new Error("渠道接口地址必须以 http:// 或 https:// 开头");
                }
                const state = useConfigStore.getState();
                const latest = state.config;
                const existing = latest.channels.find((item) => item.id === targetId);
                if (existing?.scope === "system") {
                    throw new Error("不允许覆盖系统内置模型渠道");
                }
                const channel: ModelChannel = existing
                    ? { ...existing, ...incoming, id: targetId, baseUrl, scope: "user" }
                    : { ...incoming, id: targetId, baseUrl, scope: "user" };
                const { withChannels } = await import("@/pages/settings/channel-settings-pane");
                const nextChannels = existing
                    ? latest.channels.map((item) => (item.id === targetId ? channel : item))
                    : [...latest.channels, channel];
                const nextConfig = withChannels(latest, nextChannels);
                await commitModelConfig(nextConfig);
                await flushModelConfig();
                const persistence = getModelConfigPersistenceState();
                if (persistence.status === "error") {
                    throw new Error(persistence.error || "保存模型配置失败");
                }
                state.replaceConfig(nextConfig);
                return {
                    ...channel,
                    apiKey: "",
                    secretKey: "",
                    hasApiKey: Boolean(channel.apiKey || channel.hasApiKey),
                } as unknown as Record<string, unknown>;
            },
            fetchCatalog: async (params) => {
                const perms = Array.isArray(resolvedManifest.permissions) ? resolvedManifest.permissions : [];
                if (!perms.includes("settings.write") || !resolvedManifest.trusted) {
                    throw new Error(`插件 ${pluginId} 缺少可信 settings.write 权限，无法探测模型目录`);
                }
                const res = await http.post<{ models?: Array<string | { id?: string }> }>("/ai/models", {
                    baseUrl: params.baseUrl,
                    apiKey: params.apiKey,
                    apiFormat: params.apiFormat || "openai",
                });
                const rawModels = Array.isArray(res?.models) ? res.models : [];
                const models = rawModels
                    .map((item) => (typeof item === "string" ? item : item?.id || ""))
                    .filter(Boolean);
                return { models };
            },
        },
    };
}
