import { createBeefTVPluginHost } from "@/lib/plugins/plugin-host-runtime";
import { getRegisteredPlugin, listRegisteredPlugins } from "@/lib/plugins/plugin-registry";
import type { BeefTVPluginHost, PluginManifest, PluginManifestV2 } from "@/lib/plugins/plugin-types";
import { disposePluginContributions } from "@/lib/plugins/slot-registry";
import { reportPluginLoadError } from "@/services/api/plugins";
import {
    isPluginEffectivelyEnabled,
    onPluginStoreLifecycleChange,
    usePluginStore,
} from "@/stores/use-plugin-store";

export type ClientPluginModule = {
    activate?: (host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void;
    deactivate?: () => Promise<void> | void;
    default?:
        | ((host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void)
        | {
              activate?: (host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void;
              deactivate?: () => Promise<void> | void;
          };
};

const activeCleanups = new Map<string, () => void>();
const activatingPromises = new Map<string, Promise<boolean>>();

function resolveModuleActivator(
    mod: ClientPluginModule,
): ((host: BeefTVPluginHost) => Promise<(() => void) | void> | (() => void) | void) | null {
    if (typeof mod.activate === "function") return mod.activate;
    if (typeof mod.default === "function") return mod.default;
    if (mod.default && typeof mod.default === "object" && typeof mod.default.activate === "function") {
        return mod.default.activate;
    }
    return null;
}

function resolveModuleDeactivator(mod: ClientPluginModule): (() => Promise<void> | void) | null {
    if (typeof mod.deactivate === "function") return mod.deactivate;
    if (mod.default && typeof mod.default === "object" && typeof mod.default.deactivate === "function") {
        return mod.default.deactivate;
    }
    return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, pluginId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`插件 "${pluginId}" 客户端入口激活超时（>${timeoutMs}ms）`));
        }, timeoutMs);
        promise.then(
            (val) => {
                clearTimeout(timer);
                resolve(val);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

export async function activateClientPluginModule(
    pluginId: string,
    mod: ClientPluginModule,
    options?: {
        manifest?: PluginManifest | PluginManifestV2;
        timeoutMs?: number;
        reportBackendError?: boolean;
    },
): Promise<boolean> {
    if (activeCleanups.has(pluginId)) {
        deactivateClientPlugin(pluginId);
    }

    const timeoutMs = options?.timeoutMs ?? 3000;
    const host = createBeefTVPluginHost(pluginId, options?.manifest);
    const activator = resolveModuleActivator(mod);
    const deactivator = resolveModuleDeactivator(mod);

    if (!activator) {
        return false;
    }

    try {
        const maybeDisposer = await withTimeout(
            Promise.resolve().then(() => activator(host)),
            timeoutMs,
            pluginId,
        );

        activeCleanups.set(pluginId, () => {
            try {
                if (typeof maybeDisposer === "function") {
                    maybeDisposer();
                } else if (deactivator) {
                    void deactivator();
                }
            } catch (err) {
                console.warn(`[plugin-client-loader] Error during cleanup of "${pluginId}":`, err);
            } finally {
                disposePluginContributions(pluginId);
            }
        });
        usePluginStore.getState().setError(pluginId, undefined);
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        disposePluginContributions(pluginId);
        activeCleanups.delete(pluginId);
        usePluginStore.getState().setError(pluginId, message);
        const state = usePluginStore.getState();
        state.setRuntimeStatuses({
            ...state.runtimeStatuses,
            [pluginId]: "invalid",
        });
        if (options?.reportBackendError !== false) {
            void reportPluginLoadError(pluginId, message).catch(() => {
                // ignore network error in offline/test environments
            });
        }
        return false;
    }
}

export async function loadAndActivateClientPlugin(
    pluginId: string,
    options?: {
        clientUrl?: string;
        manifest?: PluginManifest | PluginManifestV2;
        timeoutMs?: number;
    },
): Promise<boolean> {
    if (activeCleanups.has(pluginId)) return true;
    const existingPromise = activatingPromises.get(pluginId);
    if (existingPromise) return existingPromise;

    const run = (async () => {
        const registered = getRegisteredPlugin(pluginId);
        const manifest = options?.manifest ?? registered?.manifest;

        if (registered?.setup) {
            return activateClientPluginModule(
                pluginId,
                { activate: registered.setup },
                { manifest, timeoutMs: options?.timeoutMs, reportBackendError: false },
            );
        }

        const clientEntry = options?.clientUrl || (manifest?.client ? `/api/plugins/${encodeURIComponent(pluginId)}/client.js` : undefined);
        if (!clientEntry) {
            return false;
        }

        try {
            const timeoutMs = options?.timeoutMs ?? 3000;
            const mod = await withTimeout(
                import(/* @vite-ignore */ clientEntry) as Promise<ClientPluginModule>,
                timeoutMs,
                pluginId,
            );
            return await activateClientPluginModule(pluginId, mod, {
                manifest,
                timeoutMs,
                reportBackendError: true,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            disposePluginContributions(pluginId);
            usePluginStore.getState().setError(pluginId, message);
            const state = usePluginStore.getState();
            state.setRuntimeStatuses({
                ...state.runtimeStatuses,
                [pluginId]: "invalid",
            });
            void reportPluginLoadError(pluginId, message).catch(() => {});
            return false;
        }
    })();

    activatingPromises.set(pluginId, run);
    try {
        return await run;
    } finally {
        activatingPromises.delete(pluginId);
    }
}

export function deactivateClientPlugin(pluginId: string): void {
    const cleanup = activeCleanups.get(pluginId);
    activeCleanups.delete(pluginId);
    if (cleanup) {
        cleanup();
    } else {
        disposePluginContributions(pluginId);
    }
}

export function deactivateAllClientPlugins(): void {
    for (const pluginId of Array.from(activeCleanups.keys())) {
        deactivateClientPlugin(pluginId);
    }
}

export function isClientPluginActive(pluginId: string): boolean {
    return activeCleanups.has(pluginId);
}

export function activateRegisteredSetupSync(pluginId: string): boolean {
    if (activeCleanups.has(pluginId)) return true;
    const registered = getRegisteredPlugin(pluginId);
    if (!registered?.setup) return false;
    const host = createBeefTVPluginHost(pluginId, registered.manifest);
    try {
        const result = registered.setup(host);
        if (result && typeof (result as Promise<unknown>).then === "function") {
            void (result as Promise<(() => void) | void>).then(
                (disposer) => {
                    activeCleanups.set(pluginId, () => {
                        try {
                            if (typeof disposer === "function") disposer();
                        } finally {
                            disposePluginContributions(pluginId);
                        }
                    });
                },
                (err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    disposePluginContributions(pluginId);
                    activeCleanups.delete(pluginId);
                    usePluginStore.getState().setError(pluginId, message);
                },
            );
            activeCleanups.set(pluginId, () => {
                disposePluginContributions(pluginId);
            });
            return true;
        }
        activeCleanups.set(pluginId, () => {
            try {
                if (typeof result === "function") result();
            } catch (err) {
                console.warn(`[plugin-client-loader] Error during cleanup of "${pluginId}":`, err);
            } finally {
                disposePluginContributions(pluginId);
            }
        });
        usePluginStore.getState().setError(pluginId, undefined);
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        disposePluginContributions(pluginId);
        activeCleanups.delete(pluginId);
        usePluginStore.getState().setError(pluginId, message);
        return false;
    }
}

export function syncActiveClientPlugins(changedPluginId?: string): void {
    const storeState = usePluginStore.getState();
    const installationsById = new Map(storeState.installations.map((inst) => [inst.manifest.id, inst]));

    if (changedPluginId) {
        const inst = installationsById.get(changedPluginId);
        const localEnabled = inst ? inst.enabled : false;
        if (!isPluginEffectivelyEnabled(changedPluginId, localEnabled)) {
            if (activeCleanups.has(changedPluginId)) {
                deactivateClientPlugin(changedPluginId);
            } else {
                disposePluginContributions(changedPluginId);
            }
        }
    }

    for (const plugin of listRegisteredPlugins()) {
        const pluginId = plugin.manifest.id;
        const inst = installationsById.get(pluginId);
        const localEnabled = inst ? inst.enabled : false;
        const effective = isPluginEffectivelyEnabled(pluginId, localEnabled);

        if (effective) {
            if (!activeCleanups.has(pluginId)) {
                if (plugin.setup) {
                    activateRegisteredSetupSync(pluginId);
                } else if (plugin.manifest.client) {
                    void loadAndActivateClientPlugin(pluginId, { manifest: plugin.manifest });
                }
            }
        } else {
            if (activeCleanups.has(pluginId)) {
                deactivateClientPlugin(pluginId);
            } else {
                disposePluginContributions(pluginId);
            }
        }
    }
}

onPluginStoreLifecycleChange((changedPluginId) => {
    syncActiveClientPlugins(changedPluginId);
});
