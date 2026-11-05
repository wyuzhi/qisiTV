import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getRegisteredPlugin } from "@/lib/plugins/plugin-registry";
import { PLUGIN_API_VERSION, type PluginInstallation, type PluginManifest, type PluginManifestV2 } from "@/lib/plugins/plugin-types";
import type { PluginState } from "@/services/api/plugins";

export const PLUGIN_STORE_KEY = "infinite-canvas:plugin-store";

type PluginLifecycleListener = (pluginId?: string) => void;
const lifecycleListeners = new Set<PluginLifecycleListener>();

export function onPluginStoreLifecycleChange(listener: PluginLifecycleListener): () => void {
    lifecycleListeners.add(listener);
    return () => {
        lifecycleListeners.delete(listener);
    };
}

function notifyLifecycle(pluginId?: string): void {
    for (const listener of lifecycleListeners) {
        try {
            listener(pluginId);
        } catch (err) {
            console.warn("[use-plugin-store] Lifecycle listener failed:", err);
        }
    }
}

type BackendPluginEntry = { manifest: PluginManifest | PluginManifestV2; enabled: boolean };

type PluginStore = {
    hydrated: boolean;
    installations: PluginInstallation[];
    runtimeStatuses: Record<string, string>;
    pluginStates: Record<string, PluginState>;
    ensurePlugin: (manifest: PluginManifest | PluginManifestV2) => void;
    syncBackendPlugins: (plugins: BackendPluginEntry[], states: Record<string, PluginState>) => void;
    setRuntimeStatuses: (statuses: Record<string, string>) => void;
    setPluginStates: (states: Record<string, PluginState>) => void;
    setEnabled: (pluginId: string, enabled: boolean) => void;
    updateConfig: (pluginId: string, config: Record<string, string | number | boolean>) => void;
    setError: (pluginId: string, error?: string) => void;
    removePlugin: (pluginId: string) => void;
};

function now() {
    return new Date().toISOString();
}

function sameManifestRevision(a: PluginManifest | PluginManifestV2, b: PluginManifest | PluginManifestV2) {
    return a.version === b.version && a.revision === b.revision && a.trusted === b.trusted;
}

function fallbackManifest(pluginId: string): PluginManifest | PluginManifestV2 {
    return (
        getRegisteredPlugin(pluginId)?.manifest ?? {
            apiVersion: PLUGIN_API_VERSION,
            id: pluginId,
            name: pluginId,
            version: "1.0.0",
            description: "",
            permissions: [],
            contributes: {},
        }
    );
}

export const usePluginStore = create<PluginStore>()(
    persist(
        (set) => ({
            hydrated: false,
            installations: [],
            runtimeStatuses: {},
            pluginStates: {},
            ensurePlugin: (manifest) => {
                set((state) => {
                    const current = state.installations.find((item) => item.manifest.id === manifest.id);
                    if (current && sameManifestRevision(current.manifest, manifest)) return { hydrated: true };
                    const timestamp = now();
                    const next: PluginInstallation = current
                        ? { ...current, manifest, updatedAt: timestamp }
                        : { manifest, enabled: false, config: {}, installedAt: timestamp, updatedAt: timestamp };
                    return { hydrated: true, installations: [...state.installations.filter((item) => item.manifest.id !== manifest.id), next] };
                });
                notifyLifecycle(manifest.id);
            },
            // 整张表一次写完。每次写入都会把所有清单存一遍，逐个插件写会让页面卡住好几秒。
            syncBackendPlugins: (plugins, states) => {
                set((state) => {
                    const installations = new Map(state.installations.map((item) => [item.manifest.id, item]));
                    const timestamp = now();
                    for (const { manifest, enabled } of plugins) {
                        const current = installations.get(manifest.id);
                        installations.set(
                            manifest.id,
                            current
                                ? { ...current, manifest: sameManifestRevision(current.manifest, manifest) ? current.manifest : manifest, enabled, updatedAt: timestamp, lastError: undefined }
                                : { manifest, enabled, config: {}, installedAt: timestamp, updatedAt: timestamp },
                        );
                    }
                    return { hydrated: true, pluginStates: states, installations: [...installations.values()] };
                });
                notifyLifecycle();
            },
            setEnabled: (pluginId, enabled) => {
                set((state) => {
                    const exists = state.installations.some((item) => item.manifest.id === pluginId);
                    const timestamp = now();
                    const installations = exists
                        ? state.installations.map((item) =>
                              item.manifest.id === pluginId ? { ...item, enabled, updatedAt: timestamp, lastError: undefined } : item,
                          )
                        : [
                              ...state.installations,
                              {
                                  manifest: fallbackManifest(pluginId),
                                  enabled,
                                  config: {},
                                  installedAt: timestamp,
                                  updatedAt: timestamp,
                              },
                          ];
                    return { installations };
                });
                notifyLifecycle(pluginId);
            },
            setRuntimeStatuses: (runtimeStatuses) => {
                set({ runtimeStatuses });
                notifyLifecycle();
            },
            setPluginStates: (pluginStates) => {
                set({ pluginStates });
                notifyLifecycle();
            },
            updateConfig: (pluginId, config) =>
                set((state) => ({
                    installations: state.installations.map((item) => item.manifest.id === pluginId ? { ...item, config: { ...item.config, ...config }, updatedAt: now() } : item),
                })),
            setError: (pluginId, error) =>
                set((state) => ({
                    installations: state.installations.map((item) => item.manifest.id === pluginId ? { ...item, lastError: error, updatedAt: now() } : item),
                })),
            removePlugin: (pluginId) => {
                set((state) => ({ installations: state.installations.filter((item) => item.manifest.id !== pluginId) }));
                notifyLifecycle(pluginId);
            },
        }),
        {
            name: PLUGIN_STORE_KEY,
            storage: createJSONStorage(() => localForageStorageForScope()),
            partialize: (state) => ({ installations: state.installations }),
            onRehydrateStorage: () => (state) => {
                if (state) {
                    usePluginStore.setState({ hydrated: true });
                    notifyLifecycle();
                }
            },
        },
    ),
);

export function isPluginEffectivelyEnabled(pluginId: string, fallbackEnabled?: boolean) {
    const state = usePluginStore.getState();
    const serverState = state.pluginStates[pluginId];
    if (serverState) return serverState.effectiveEnabled;
    if (pluginId in state.runtimeStatuses) return state.runtimeStatuses[pluginId] === "enabled";
    if (fallbackEnabled !== undefined) return fallbackEnabled;
    return Boolean(state.installations.find((item) => item.manifest.id === pluginId)?.enabled);
}
