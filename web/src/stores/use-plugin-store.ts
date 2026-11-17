import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getRegisteredPlugin } from "@/lib/plugins/plugin-registry";
import { PLUGIN_API_VERSION, type PluginInstallation, type PluginManifest, type PluginManifestV2 } from "@/lib/plugins/plugin-types";
import type { PluginState } from "@/services/api/plugins";

export const PLUGIN_STORE_KEY = "infinite-canvas:plugin-store";

export const LEGACY_PLUGIN_ID_MAP: Readonly<Record<string, string>> = Object.freeze({
    "eagle-asset-connector": "beeftv-plugin-eagle-asset-connector",
    "prompt-optimizer": "beeftv-plugin-prompt-optimizer",
    "ai-art-critique": "beeftv-plugin-ai-art-critique",
    "media-conversion": "beeftv-plugin-media-conversion",
});

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

function hasNonEmptyConfigValue(value: unknown): value is string | number | boolean {
    if (typeof value === "string") return value.trim().length > 0;
    return typeof value === "number" || typeof value === "boolean";
}

function mergeLegacyConfig(
    legacyConfig: Record<string, string | number | boolean> | undefined,
    canonicalConfig: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
    const merged: Record<string, string | number | boolean> = { ...(canonicalConfig ?? {}) };
    for (const [key, value] of Object.entries(legacyConfig ?? {})) {
        if (!hasNonEmptyConfigValue(value)) continue;
        if (!hasNonEmptyConfigValue(merged[key])) {
            merged[key] = value;
        }
    }
    return merged;
}

export function migrateLegacyPluginInstallations(installations: readonly PluginInstallation[]): PluginInstallation[] {
    if (!installations.some((item) => item.manifest.id in LEGACY_PLUGIN_ID_MAP)) {
        return [...installations];
    }
    const byId = new Map<string, PluginInstallation>();
    const legacyEntries: PluginInstallation[] = [];
    for (const item of installations) {
        if (item.manifest.id in LEGACY_PLUGIN_ID_MAP) {
            legacyEntries.push(item);
        } else {
            byId.set(item.manifest.id, item);
        }
    }
    for (const legacy of legacyEntries) {
        const canonicalId = LEGACY_PLUGIN_ID_MAP[legacy.manifest.id];
        if (!canonicalId) continue;
        const existing = byId.get(canonicalId);
        if (existing) {
            byId.set(canonicalId, {
                ...existing,
                config: mergeLegacyConfig(legacy.config, existing.config),
            });
        } else if (Object.keys(legacy.config ?? {}).some((key) => hasNonEmptyConfigValue(legacy.config?.[key]))) {
            // Preserve user-configured settings (such as Eagle baseUrl / generatedFolderId)
            // without marking an uninstalled external package as installed unless it has user config;
            // keep enabled=false until the package is installed or synced from the backend.
            byId.set(canonicalId, {
                ...legacy,
                manifest: { ...legacy.manifest, id: canonicalId },
                enabled: false,
                config: mergeLegacyConfig(legacy.config, {}),
            });
        }
    }
    return [...byId.values()];
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
                    const canonicalId = LEGACY_PLUGIN_ID_MAP[manifest.id] ?? manifest.id;
                    const normalizedManifest = canonicalId === manifest.id ? manifest : { ...manifest, id: canonicalId };
                    const migrated = migrateLegacyPluginInstallations(state.installations);
                    const current = migrated.find((item) => item.manifest.id === canonicalId);
                    if (current && sameManifestRevision(current.manifest, normalizedManifest) && migrated.length === state.installations.length) {
                        return { hydrated: true };
                    }
                    const timestamp = now();
                    const next: PluginInstallation = current
                        ? { ...current, manifest: normalizedManifest, updatedAt: timestamp }
                        : { manifest: normalizedManifest, enabled: false, config: {}, installedAt: timestamp, updatedAt: timestamp };
                    return { hydrated: true, installations: [...migrated.filter((item) => item.manifest.id !== canonicalId), next] };
                });
                notifyLifecycle(manifest.id);
            },
            // 整张表一次写完。每次写入都会把所有清单存一遍，逐个插件写会让页面卡住好几秒。
            syncBackendPlugins: (plugins, states) => {
                set((state) => {
                    const migrated = migrateLegacyPluginInstallations(state.installations);
                    const installations = new Map(migrated.map((item) => [item.manifest.id, item]));
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
                const canonicalId = LEGACY_PLUGIN_ID_MAP[pluginId] ?? pluginId;
                set((state) => {
                    const migrated = migrateLegacyPluginInstallations(state.installations);
                    const exists = migrated.some((item) => item.manifest.id === canonicalId);
                    const timestamp = now();
                    const installations = exists
                        ? migrated.map((item) =>
                              item.manifest.id === canonicalId ? { ...item, enabled, updatedAt: timestamp, lastError: undefined } : item,
                          )
                        : [
                              ...migrated,
                              {
                                  manifest: fallbackManifest(canonicalId),
                                  enabled,
                                  config: {},
                                  installedAt: timestamp,
                                  updatedAt: timestamp,
                              },
                          ];
                    return { installations };
                });
                notifyLifecycle(canonicalId);
            },
            setRuntimeStatuses: (runtimeStatuses) => {
                set({ runtimeStatuses });
                notifyLifecycle();
            },
            setPluginStates: (pluginStates) => {
                set({ pluginStates });
                notifyLifecycle();
            },
            updateConfig: (pluginId, config) => {
                const canonicalId = LEGACY_PLUGIN_ID_MAP[pluginId] ?? pluginId;
                set((state) => {
                    const migrated = migrateLegacyPluginInstallations(state.installations);
                    return {
                        installations: migrated.map((item) =>
                            item.manifest.id === canonicalId ? { ...item, config: { ...item.config, ...config }, updatedAt: now() } : item,
                        ),
                    };
                });
            },
            setError: (pluginId, error) => {
                const canonicalId = LEGACY_PLUGIN_ID_MAP[pluginId] ?? pluginId;
                set((state) => ({
                    installations: migrateLegacyPluginInstallations(state.installations).map((item) =>
                        item.manifest.id === canonicalId ? { ...item, lastError: error, updatedAt: now() } : item,
                    ),
                }));
            },
            removePlugin: (pluginId) => {
                const canonicalId = LEGACY_PLUGIN_ID_MAP[pluginId] ?? pluginId;
                set((state) => ({
                    installations: migrateLegacyPluginInstallations(state.installations).filter(
                        (item) => item.manifest.id !== canonicalId && item.manifest.id !== pluginId,
                    ),
                }));
                notifyLifecycle(canonicalId);
            },
        }),
        {
            name: PLUGIN_STORE_KEY,
            storage: createJSONStorage(() => localForageStorageForScope()),
            partialize: (state) => ({ installations: state.installations }),
            onRehydrateStorage: () => (state) => {
                if (state) {
                    const hasLegacy = state.installations.some((item) => item.manifest.id in LEGACY_PLUGIN_ID_MAP);
                    usePluginStore.setState(
                        hasLegacy
                            ? { hydrated: true, installations: migrateLegacyPluginInstallations(state.installations) }
                            : { hydrated: true },
                    );
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
