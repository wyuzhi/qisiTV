import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { preloadWorkspaceRoute } from "@/lib/workspace-route-modules";
import { workspaceRouteLocation } from "@/lib/workspace-url";
import { applyUserSession, localWorkspaceConfig } from "@/lib/user-session";
import { getWorkspaceBootstrap, createLocalWorkspacePayload } from "@/services/api/workspace";
import { commitModelConfig, flushModelConfig, hydrateModelConfig } from "@/services/model-config-repository";
import { normalizeConfigSnapshot, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function WorkspaceBootstrapHydrator({ children }: { children: ReactNode }) {
    const hydrated = useUserStore((state) => state.hydrated);
    const modelConfigReady = useRef(false);

    useEffect(() => {
        let cancelled = false;
        const loadWorkspace = () => {
            const bootstrap = getWorkspaceBootstrap();
            const timeout = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("本地工作区启动超时")), 15_000));
            return Promise.race([bootstrap, timeout]);
        };
        void initializeWorkspaceState({
            loadWorkspace,
            createLocalWorkspace: createLocalWorkspacePayload,
            applySession: applyUserSession,
            restoreModelConfig: hydrateLocalModelConfig,
        })
            .then(() => {
                modelConfigReady.current = true;
                if (!cancelled) preloadWorkspaceRoute(workspaceRouteLocation(window.location).pathname);
            })
            .catch(() => {
                if (cancelled) return;
                modelConfigReady.current = true;
                useUserStore.getState().setHydrated(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let ready = false;
        const unsubscribe = useConfigStore.subscribe((state) => {
            if (!shouldSaveLocalModelConfig({ subscriptionReady: ready, modelConfigReady: modelConfigReady.current, channelCount: state.config.channels.length })) return;
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

    return hydrated ? children : <FullScreenLoader label="正在准备本地工作区" detail="加载项目、画布与模型配置" />;
}

export async function initializeWorkspaceState<T>({
    loadWorkspace,
    createLocalWorkspace,
    applySession,
    restoreModelConfig,
}: {
    loadWorkspace: () => Promise<T>;
    createLocalWorkspace: () => T;
    applySession: (payload: T) => Promise<void>;
    restoreModelConfig: () => Promise<void>;
}) {
    try {
        try {
            await applySession(await loadWorkspace());
        } catch {
            // Keep the desktop usable while the embedded backend is still
            // starting. There is no remote/account fallback in a local build.
            await applySession(createLocalWorkspace());
        }
    } finally {
        // The provider snapshot is an independent, canonical desktop file.
        // Browser persistence may be corrupt or unavailable; that must never
        // prevent configured channels and credentials from being restored.
        await restoreModelConfig();
    }
}

export function shouldSaveLocalModelConfig({ subscriptionReady, modelConfigReady, channelCount }: { subscriptionReady: boolean; modelConfigReady: boolean; channelCount: number }) {
    return subscriptionReady && modelConfigReady && channelCount > 0;
}

async function hydrateLocalModelConfig() {
    const result = await hydrateModelConfig();
    const normalizedConfig = localWorkspaceConfig(normalizeConfigSnapshot({ config: result.config }).config);
    useConfigStore.getState().replaceConfig(normalizedConfig);
    if (shouldPersistHydratedModelConfig(result.health)) await commitModelConfig(normalizedConfig);
}

export function shouldPersistHydratedModelConfig(health: string) {
    return health === "migrated" || health === "recovered";
}
