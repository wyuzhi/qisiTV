import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { App } from "antd";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { navigateToSettings } from "@/lib/settings-navigation";
import { workspaceRouteLocation, workspaceRouteUrl } from "@/lib/workspace-url";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { initializeClientDiagnostics, setDiagnosticUserScope } from "@/services/diagnostics/client-diagnostics";
import { fetchPluginRuntimeState, setUserPluginEnabled } from "@/services/api/plugins";
import { usePluginStore } from "@/stores/use-plugin-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { appQueryClient } from "@/lib/query-client";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { getActiveUserScope } from "@/lib/user-scope";
import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const config = useConfigStore((state) => state.config);
    const userId = useUserStore((state) => state.user?.id || "");
    const storageMode = useUserStore((state) => state.storageMode);
    const user = useUserStore((state) => state.user);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const canvasHydrated = useCanvasStore((state) => state.hydrated);
    const localMode = isLocalWorkspaceMode() || storageMode === "local" || user?.username === "local";
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const setRuntimeStatuses = usePluginStore((state) => state.setRuntimeStatuses);
    const setPluginStates = usePluginStore((state) => state.setPluginStates);
    const pluginStoreHydrated = usePluginStore((state) => state.hydrated);
    const localMediaCleanupScope = useRef("");
    const [folderInitialized, setFolderInitialized] = useState(!isBrowserWorkspace());

    useEffect(() => {
        if (!isBrowserWorkspace()) return;
        const onSaveError = (event: Event) => {
            const detail = (event as CustomEvent<{ message?: string }>).detail;
            message.error(detail?.message || "Agent 生成结果未能写入项目文件夹，请检查目录授权后重试保存", 8);
        };
        window.addEventListener("qisitv:agent-save-error", onSaveError);
        return () => window.removeEventListener("qisitv:agent-save-error", onSaveError);
    }, [message]);

    useEffect(() => {
        if (!isBrowserWorkspace() || !canvasHydrated) return;
        let active = true;
        void import("@/services/local-workspace-repository")
            .then((module) => module.hydrateLocalCanvasProjectsFromBackend())
            .catch((error: unknown) => { if (active) message.warning(error instanceof Error ? error.message : "请重新连接项目文件夹"); })
            .finally(() => { if (active) setFolderInitialized(true); });
        return () => { active = false; };
    }, [canvasHydrated, message]);

    useEffect(() => () => {
        usePluginStore.getState().setRuntimeStatuses({});
        usePluginStore.getState().setPluginStates({});
    }, []);

    useEffect(() => {
        if (!userId || localMode || !pluginStoreHydrated) return;
        let cancelled = false;
        void appQueryClient.fetchQuery({ queryKey: ["plugin-runtime", userId], queryFn: fetchPluginRuntimeState, staleTime: 30_000 })
            .then(async (runtime) => {
                if (cancelled || useUserStore.getState().user?.id !== userId) return;
                const statuses = { ...runtime.statuses };
                const states = { ...runtime.states };
                const legacyEnabledIds = usePluginStore
                    .getState()
                    .installations.filter((installation) => installation.enabled && states[installation.manifest.id]?.canToggle && !states[installation.manifest.id]?.userConfigured)
                    .map((installation) => installation.manifest.id);
                if (legacyEnabledIds.length) {
                    try {
                        const migrated = await Promise.all(legacyEnabledIds.map((pluginId) => setUserPluginEnabled(pluginId, true)));
                        for (const state of migrated) states[state.pluginId] = state;
                        for (const pluginId of legacyEnabledIds) statuses[pluginId] = states[pluginId]?.effectiveEnabled ? "enabled" : "disabled";
                    } catch (error) {
                        console.warn("迁移用户插件启用状态失败，已保留服务端状态", error);
                    }
                }
                if (!cancelled && useUserStore.getState().user?.id === userId) {
                    setRuntimeStatuses(statuses);
                    setPluginStates(states);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setRuntimeStatuses({});
                    setPluginStates({});
                }
            });
        return () => {
            cancelled = true;
        };
    }, [localMode, pluginStoreHydrated, setPluginStates, setRuntimeStatuses, userId]);

    useEffect(() => {
        initializeClientDiagnostics();
    }, []);

    useEffect(() => {
        if (isBrowserWorkspace() || !localMode || !assetsHydrated || !canvasHydrated) return;
        const scope = getActiveUserScope();
        if (localMediaCleanupScope.current === scope) return;
        localMediaCleanupScope.current = scope;
        void useAssetStore.getState().cleanupImages().catch((error) => {
            // Cache cleanup is best effort; it must never block opening the local workspace.
            console.warn("本地媒体缓存清理失败，已保留当前工作区", { scope, error });
        });
    }, [assetsHydrated, canvasHydrated, localMode]);

    useEffect(() => {
        setDiagnosticUserScope(userId);
    }, [userId]);

    useEffect(() => {
        const interactiveSelector = 'button, [role="button"], a, [class*="card"], [class*="Card"]';
        const blurPointerFocus = (event: PointerEvent) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            const target = event.target instanceof Element ? event.target.closest<HTMLElement>(interactiveSelector) : null;
            if (!target || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return;
            // 浏览器可能把鼠标点击误判为 :focus-visible；下一帧只清掉这次指针点击产生的焦点。
            window.requestAnimationFrame(() => {
                if (document.activeElement === target) target.blur();
            });
        };
        document.addEventListener("pointerdown", blurPointerFocus, true);
        return () => document.removeEventListener("pointerdown", blurPointerFocus, true);
    }, []);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const route = workspaceRouteLocation(window.location);
        const searchParams = new URLSearchParams(route.search);
        const outerParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl") || outerParams.get("baseUrl") || outerParams.get("baseurl");
        const ignoredApiKey = [searchParams, outerParams].some((params) => params.has("apiKey") || params.has("apikey"));
        if (!baseUrl && !ignoredApiKey) return;
        handledConfigParams.current = true;
        for (const params of [searchParams, outerParams]) {
            for (const key of ["baseUrl", "baseurl", "apiKey", "apikey"]) params.delete(key);
        }
        const cleanPath = `${route.pathname}${searchParams.size ? `?${searchParams}` : ""}`;
        const cleanUrl = new URL(workspaceRouteUrl(cleanPath));
        if (isBrowserWorkspace()) cleanUrl.search = outerParams.toString();
        else cleanUrl.hash = window.location.hash;
        window.history.replaceState(null, "", cleanUrl.href);
        if (isBrowserWorkspace()) {
            navigateToSettings({ section: "channels" });
            if (ignoredApiKey) message.warning("出于安全考虑，链接中的 API Key 已忽略，请在配置中手动填写");
            else message.info("当前使用 LikeAI 官方地址，请在配置中填写 API Key");
            return;
        }
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: "默认渠道", baseUrl: baseUrl || undefined })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        navigateToSettings({ section: "channels" });
        if (ignoredApiKey) message.warning("出于安全考虑，链接中的 API Key 已忽略，请在配置中手动填写");
        else message.success("已导入本地直连地址");
    }, [config.channels, message, updateConfig]);

    return folderInitialized ? <>{children}</> : <FullScreenLoader label="正在打开本机项目" detail="检查项目文件夹与浏览器缓存" />;
}
