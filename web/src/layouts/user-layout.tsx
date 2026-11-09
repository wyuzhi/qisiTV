import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { ConfigProvider } from "antd";

import { AppWorkspaceShell } from "@/components/layout/app-top-nav";
import { FirstCreationGuide } from "@/components/onboarding/first-creation-guide";
import { WorkspaceOperationProgress } from "@/components/layout/workspace-operation-progress";
import { hydrateLocalModelConfig } from "@/components/workspace/workspace-bootstrap-hydrator";
import { cn } from "@/lib/utils";
import { isEmbeddedRuntime, publishEmbeddedContext } from "@/lib/embedded-runtime";
import { isSpatialWorkbenchPath } from "@/lib/workspace-routes";
import { getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import { useWorkspaceButtonFeedback } from "@/hooks/use-workspace-button-feedback";
import { notifyExternalCanvasEvent } from "@/services/canvas-external-writes";
import { hydrateLocalCanvasProjectsFromBackend, openLocalCanvasProjectFromBackend, refreshLocalCanvasProjectIfChanged } from "@/services/local-workspace-repository";
import { syncPluginsFromBackend } from "@/services/plugin-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import "@/styles/workspace-product.css";

const workspaceTheme = getWorkspaceAntThemeConfig();

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const spatialWorkbench = isSpatialWorkbenchPath(pathname);
    const productWorkspace = !/^\/canvas\/[^/]+(?:\/|$)/.test(pathname);
    useWorkspaceButtonFeedback(productWorkspace);

    useLayoutEffect(() => {
        publishEmbeddedContext({ route: pathname, selectedNodeIds: [] });
    }, [pathname]);

    useEffect(() => {
        // A failed read keeps the plugins remembered in this browser.
        void syncPluginsFromBackend().catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!isLocalWorkspaceMode()) return;
        const refreshProjects = () => {
            if (document.hidden) return;
            void hydrateLocalCanvasProjectsFromBackend();
        };
        window.addEventListener("focus", refreshProjects);
        document.addEventListener("visibilitychange", refreshProjects);
        return () => {
            window.removeEventListener("focus", refreshProjects);
            document.removeEventListener("visibilitychange", refreshProjects);
        };
    }, []);

    useEffect(() => {
        if (!isEmbeddedRuntime()) return;
        const onMessage = (event: MessageEvent) => {
            if (event.source !== window.parent || event.data?.type !== "beeftv:workspace-sync") return;
            const activity = event.data.activity as { kind?: string; canvasId?: string | null } | undefined;
            void hydrateLocalCanvasProjectsFromBackend();
            if (activity?.kind === "workspace-updated") {
                void syncPluginsFromBackend().catch(() => undefined);
                void hydrateLocalModelConfig().catch(() => undefined);
            }
            const canvasId = typeof activity?.canvasId === "string" ? activity.canvasId.trim() : "";
            if (!canvasId) return;
            void openLocalCanvasProjectFromBackend(canvasId).then(() => {
                void refreshLocalCanvasProjectIfChanged(canvasId);
                notifyExternalCanvasEvent(canvasId);
                if (activity?.kind === "canvas-created" || !/^\/canvas\/[^/]+(?:\/|$)/.test(window.location.pathname)) {
                    navigate(`/canvas/${encodeURIComponent(canvasId)}`);
                }
            });
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [navigate]);

    useLayoutEffect(() => {
        // Ant Design 浮层挂载在 body，必须用路由级标记隔离用户工作台与画布编辑器、运营后台。
        document.body.classList.add("app-user-overlays");
        document.body.classList.toggle("app-spatial-overlays", spatialWorkbench);
        document.body.classList.toggle("app-product-overlays", productWorkspace);
        return () => {
            document.body.classList.remove("app-user-overlays");
            document.body.classList.remove("app-spatial-overlays");
            document.body.classList.remove("app-product-overlays");
        };
    }, [spatialWorkbench, productWorkspace]);

    return (
        <ConfigProvider theme={productWorkspace ? workspaceTheme : undefined}>
            <div className={cn("app-user-workspace h-dvh overflow-hidden text-foreground", spatialWorkbench && "app-spatial-workspace", productWorkspace && "app-product-workspace", pathname === "/" && "app-home-route")}>
                <AppWorkspaceShell>{children}</AppWorkspaceShell>
                <FirstCreationGuide />
                <WorkspaceOperationProgress />
            </div>
        </ConfigProvider>
    );
}
