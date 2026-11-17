import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { WorkspaceStartupError } from "@/components/workspace/workspace-startup-error";
import { appPathname } from "@/lib/app-routing";
import { isEmbeddedRuntime } from "@/lib/embedded-runtime";
import { preloadWorkspaceRoute } from "@/lib/workspace-route-modules";
import { applyUserSession, localWorkspaceConfig } from "@/lib/user-session";
import { getWorkspaceBootstrap, type WorkspaceBootstrapPayload } from "@/services/api/workspace";
import { hydrateLocalCanvasProjectsFromBackend } from "@/services/local-workspace-repository";
import { commitModelConfig, flushModelConfig, hydrateModelConfig } from "@/services/model-config-repository";
import {
    clearWorkspaceStartupFailure,
    consumePrimedWorkspaceBootstrap,
    getDesktopBootSnapshot,
    normalizeWorkspaceStartupFailure,
    recordWorkspaceStartupFailure,
    subscribeDesktopBootSnapshot,
    type WorkspaceStartupFailure,
} from "@/services/workspace-startup-state";
import { normalizeConfigSnapshot, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function WorkspaceBootstrapHydrator({ children }: { children: ReactNode }) {
    const hydrated = useUserStore((state) => state.hydrated);
    const bootSnapshot = useSyncExternalStore(subscribeDesktopBootSnapshot, getDesktopBootSnapshot, getDesktopBootSnapshot);
    const modelConfigReady = useRef(false);
    const [restoreStatus, setRestoreStatus] = useState<"loading" | "ready" | "error">("loading");
    const [startupFailure, setStartupFailure] = useState<WorkspaceStartupFailure | null>(null);
    const [retrying, setRetrying] = useState(false);

    const runHydration = useCallback(async (isRetry: boolean, isCancelled: () => boolean) => {
        if (isRetry) {
            setRetrying(true);
            clearWorkspaceStartupFailure();
        }
        let bootstrapLoaded = false;
        const loadWorkspace = async (): Promise<WorkspaceBootstrapPayload> => {
            if (!isRetry) {
                const primed = consumePrimedWorkspaceBootstrap();
                if (primed) {
                    bootstrapLoaded = true;
                    return primed;
                }
            }
            const payload = await getWorkspaceBootstrap();
            bootstrapLoaded = true;
            return payload;
        };

        try {
            await initializeWorkspaceState({
                loadWorkspace,
                applySession: async (payload) => {
                    await applyUserSession(payload);
                    if (isEmbeddedRuntime()) await hydrateLocalCanvasProjectsFromBackend();
                },
                restoreModelConfig: hydrateLocalModelConfig,
            });
            if (isCancelled()) return;
            modelConfigReady.current = true;
            setStartupFailure(null);
            setRestoreStatus("ready");
            preloadWorkspaceRoute(appPathname());
        } catch (error) {
            if (isCancelled()) return;
            // The browser cache deliberately has no credentials. If the
            // canonical file could not be read, never autosave that cache
            // over the existing workspace when the backend comes back.
            modelConfigReady.current = false;
            useUserStore.getState().setHydrated(true);
            const stage = bootstrapLoaded ? "session_hydration" : undefined;
            const recorded = recordWorkspaceStartupFailure(error, stage);
            setStartupFailure(recorded);
            setRestoreStatus("error");
        } finally {
            if (!isCancelled()) setRetrying(false);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        void runHydration(false, () => cancelled);
        return () => {
            cancelled = true;
        };
    }, [runHydration]);

    useEffect(() => {
        let ready = false;
        const unsubscribe = useConfigStore.subscribe((state) => {
            if (applyingHydratedModelConfig || !shouldSaveLocalModelConfig({ subscriptionReady: ready, modelConfigReady: modelConfigReady.current, channelCount: state.config.channels.length })) return;
            void commitModelConfig(state.config);
        });
        const flush = () => { void flushModelConfig(); };
        window.addEventListener("pagehide", flush);
        const markReady = () => { ready = true; };
        if (modelConfigReady.current) markReady();
        else window.setTimeout(markReady, 0);
        return () => {
            unsubscribe();
            window.removeEventListener("pagehide", flush);
            void flushModelConfig();
        };
    }, []);

    if (restoreStatus === "error") {
        const activeFailure = startupFailure || bootSnapshot.failure || normalizeWorkspaceStartupFailure(null);
        return (
            <WorkspaceStartupError
                failure={activeFailure}
                retrying={retrying}
                onRetry={() => {
                    void runHydration(true, () => false);
                }}
            />
        );
    }

    return hydrated && restoreStatus === "ready" ? (
        children
    ) : (
        <FullScreenLoader
            label="正在准备本地工作区"
            detail={bootSnapshot.detail || "加载项目、画布与模型配置"}
        />
    );
}

export async function initializeWorkspaceState<T>({
    loadWorkspace,
    applySession,
    restoreModelConfig,
}: {
    loadWorkspace: () => Promise<T>;
    applySession: (payload: T) => Promise<void>;
    restoreModelConfig: () => Promise<void>;
}) {
    let primaryError: unknown;
    try {
        await applySession(await loadWorkspace());
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        // The provider snapshot is an independent, canonical desktop file.
        // Browser persistence may be corrupt or unavailable; that must never
        // prevent configured channels and credentials from being restored.
        if (primaryError !== undefined) {
            await restoreModelConfig().catch(() => undefined);
        } else {
            await restoreModelConfig();
        }
    }
}

export function shouldSaveLocalModelConfig({ subscriptionReady, modelConfigReady, channelCount }: { subscriptionReady: boolean; modelConfigReady: boolean; channelCount: number }) {
    return subscriptionReady && modelConfigReady && channelCount > 0;
}

let applyingHydratedModelConfig = false;

export async function hydrateLocalModelConfig() {
    const result = await hydrateModelConfig();
    // 还有没保存的设置修改：界面保留它，等它保存，不用读回的旧快照覆盖。
    if (result.supersededByLocalEdit) return;
    const normalizedConfig = localWorkspaceConfig(normalizeConfigSnapshot({ config: result.config }).config);
    applyingHydratedModelConfig = true;
    try {
        useConfigStore.getState().replaceConfig(normalizedConfig);
    } finally {
        applyingHydratedModelConfig = false;
    }
    if (shouldPersistHydratedModelConfig(result.health)) await commitModelConfig(normalizedConfig);
}

export function shouldPersistHydratedModelConfig(health: string) {
    return health === "migrated" || health === "recovered";
}
