import { appHref, appPathname } from "@/lib/app-routing";
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
    const match = /^\/canvas\/([^/]+)/.exec(appPathname());
    return match ? decodeURIComponent(match[1]) : undefined;
}

function defaultManifestFor(pluginId: string): PluginManifest | PluginManifestV2 {
    const registered = getRegisteredPlugin(pluginId);
    if (registered) return registered.manifest;
    const installed = usePluginStore.getState().installations.find((item) => item.manifest.id === pluginId);
    if (installed) return installed.manifest;
    return { apiVersion: PLUGIN_API_VERSION, id: pluginId, name: pluginId, version: "", description: "", permissions: [], contributes: {} };
}

const READ_ONLY_OPS = new Set([
    "canvas.get",
    "canvas.search",
    "asset.list",
    "asset.get",
    "task.get",
    "canvas.generation.propose",
    "model.catalog",
    "generation.estimate",
    "media.overview",
    "media.inspect",
    "media.check",
    "media.review",
    "skill.catalog",
    "skill.get",
    "skill.file",
    "skill.market.search",
    "skill.market.get",
    "skill.market.file",
    "skill.publish.status",
    "project.media.search",
    "project.canvas.search",
]);

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
                window.history.pushState({}, "", appHref(path));
                window.dispatchEvent(new PopStateEvent("popstate"));
            },
            requestInstallPlugin: requestPluginInstall,
        },
        ops: {
            call: async <T = unknown>(op: string, params?: Record<string, unknown>) => {
                const rawParams = { ...(params ?? {}) };
                const explicitOpId = typeof rawParams.opId === "string" ? rawParams.opId.trim() : "";
                if ("opId" in rawParams) delete rawParams.opId;
                const isReadOnly = READ_ONLY_OPS.has(op);
                const opId = isReadOnly
                    ? undefined
                    : explicitOpId ||
                      (typeof rawParams.operationId === "string" && rawParams.operationId.trim()
                          ? undefined
                          : `plugin-${pluginId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
                const targetCanvasId = typeof rawParams.canvasId === "string" ? rawParams.canvasId.trim() : "";
                let result: T;
                try {
                    const res = await executeWorkspaceOperation<T>(op, { ...(opId ? { opId } : {}), params: rawParams });
                    result = res.result;
                } catch (err) {
                    const isInitialCommit =
                        op === "canvas.document.commit" &&
                        rawParams.expectedRevision === 0 &&
                        Boolean(targetCanvasId) &&
                        Boolean(rawParams.document && typeof rawParams.document === "object");
                    const isNotFound =
                        (typeof (err as { status?: number })?.status === "number" && (err as { status: number }).status === 404) ||
                        String((err as Error)?.message || "").includes("画布不存在");
                    if (!isInitialCommit || !isNotFound) throw err;
                    const created = await http.put<{
                        project?: { id?: string; revision?: number; title?: string; updatedAt?: string };
                    }>(`/canvas-projects/${encodeURIComponent(targetCanvasId)}`, {
                        project: rawParams.document,
                    });
                    const docObj = rawParams.document as { title?: string; updatedAt?: string };
                    result = {
                        canvasId: created?.project?.id || targetCanvasId,
                        revision: created?.project?.revision ?? 1,
                        title: created?.project?.title ?? docObj.title ?? "",
                        updatedAt: created?.project?.updatedAt ?? docObj.updatedAt ?? new Date().toISOString(),
                    } as unknown as T;
                }
                if (!isReadOnly && targetCanvasId) {
                    void import("@/services/local-workspace-repository").then(({ refreshLocalCanvasProjectIfChanged }) =>
                        refreshLocalCanvasProjectIfChanged(targetCanvasId),
                    );
                }
                return result;
            },
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
                    headers: undefined,
                    hasApiKey: Boolean(item.apiKey || item.hasApiKey),
                })) as unknown as Array<Record<string, unknown>>;
            },
            upsert: async (rawChannel) => {
                const perms = Array.isArray(resolvedManifest.permissions) ? resolvedManifest.permissions : [];
                if (!perms.includes("settings.write") || !resolvedManifest.trusted) {
                    throw new Error(`插件 ${pluginId} 缺少可信 settings.write 权限，无法修改模型渠道`);
                }
                const incoming = rawChannel as unknown as Partial<ModelChannel>;
                const targetId = String(incoming.id || "").trim();
                const allowedPrefix = pluginId.replace(/^beeftv-plugin-/, "");
                const isPluginOwnedId =
                    Boolean(targetId) &&
                    targetId !== "beeftv" &&
                    (targetId === allowedPrefix ||
                        targetId === `${allowedPrefix}-channel` ||
                        targetId.startsWith(`${pluginId}:`));
                if (!isPluginOwnedId) {
                    throw new Error(`插件 ${pluginId} 仅允许写入自身命名空间下的模型渠道`);
                }
                const baseUrl = String(incoming.baseUrl || "").trim();
                if (!/^https?:\/\//i.test(baseUrl)) {
                    throw new Error("渠道接口地址必须以 http:// 或 https:// 开头");
                }
                const buildNextConfig = async () => {
                    const { servicePresetFor } = await import("@/lib/model-service-presets");
                    const latest = useConfigStore.getState().config;
                    const existing = latest.channels.find((item) => item.id === targetId)
                        || latest.channels.find((item) => item.scope !== "system" && !item.pinned && !item.credentialRef && servicePresetFor(item) === allowedPrefix);
                    if (existing?.scope === "system" || existing?.pinned || existing?.credentialRef) {
                        throw new Error("不允许覆盖系统内置或受管凭证渠道");
                    }
                    const effectiveId = existing?.id || targetId;
                    const nextApiKey = typeof incoming.apiKey === "string" && incoming.apiKey.trim()
                        ? incoming.apiKey.trim()
                        : existing?.apiKey ?? "";
                    const channel: ModelChannel = {
                        id: effectiveId,
                        name: String(incoming.name || existing?.name || targetId).trim(),
                        baseUrl,
                        apiKey: nextApiKey,
                        hasApiKey: Boolean(nextApiKey || existing?.hasApiKey),
                        apiFormat: incoming.apiFormat || existing?.apiFormat || "openai",
                        enabled: typeof incoming.enabled === "boolean" ? incoming.enabled : (existing?.enabled ?? true),
                        pinned: false,
                        scope: "user",
                        credentialRef: undefined,
                        headers: existing?.headers,
                        models: Array.isArray(incoming.models) ? incoming.models.filter((m): m is string => typeof m === "string" && Boolean(m.trim())) : (existing?.models ?? []),
                        modelProfiles: Array.isArray(incoming.modelProfiles) ? incoming.modelProfiles : existing?.modelProfiles,
                    };
                    const { withChannels } = await import("@/pages/settings/channel-settings-pane");
                    const nextChannels = existing
                        ? latest.channels.map((item) => (item.id === existing.id ? channel : item))
                        : [...latest.channels, channel];
                    return { channel, nextConfig: withChannels(latest, nextChannels) };
                };
                const { channel, nextConfig } = await buildNextConfig();
                await commitModelConfig(nextConfig);
                await flushModelConfig();
                const persistence = getModelConfigPersistenceState();
                if (persistence.status === "error") {
                    throw new Error(persistence.error || "保存模型配置失败");
                }
                const refreshed = await buildNextConfig();
                useConfigStore.getState().replaceConfig(refreshed.nextConfig);
                return {
                    ...channel,
                    apiKey: "",
                    secretKey: "",
                    headers: undefined,
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
