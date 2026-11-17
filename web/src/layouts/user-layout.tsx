import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button, ConfigProvider } from "antd";

import { AppWorkspaceShell } from "@/components/layout/app-top-nav";
import { FirstCreationGuide } from "@/components/onboarding/first-creation-guide";
import { WorkspaceOperationProgress } from "@/components/layout/workspace-operation-progress";
import { WorkspaceNoticeStack, type WorkspaceNoticeItem } from "@/components/layout/workspace-notice";
import { addWorkspaceNotice } from "@/lib/workspace-notices";
import { hydrateLocalModelConfig } from "@/components/workspace/workspace-bootstrap-hydrator";
import { cn } from "@/lib/utils";
import { appPathname } from "@/lib/app-routing";
import { isEmbeddedRuntime, publishEmbeddedContext } from "@/lib/embedded-runtime";
import { createEmbeddedCanvasNoticeGate, createEmbeddedWorkspaceSyncHandler } from "@/lib/embedded-workspace-sync";
import { useEmbeddedAskResult } from "@/hooks/use-embedded-ask-result";
import { isSpatialWorkbenchPath } from "@/lib/workspace-routes";
import { getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import { useWorkspaceButtonFeedback } from "@/hooks/use-workspace-button-feedback";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { notifyExternalCanvasEvent } from "@/services/canvas-external-writes";
import { hydrateLocalCanvasProjectsFromBackend, openLocalCanvasProjectFromBackend, refreshLocalCanvasProjectIfChanged } from "@/services/local-workspace-repository";
import { syncPluginsFromBackend } from "@/services/plugin-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import "@/styles/workspace-product.css";

const workspaceTheme = getWorkspaceAntThemeConfig();

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const [canvasNoticeGate] = useState(() => createEmbeddedCanvasNoticeGate());
    const [workspaceNotices, setWorkspaceNotices] = useState<WorkspaceNoticeItem[]>([]);
    const dismissWorkspaceNotice = useCallback((id: string) => setWorkspaceNotices((items) => items.filter((item) => item.id !== id)), []);
    const showEmbeddedAskNotice = useCallback((text: string) => {
        setWorkspaceNotices((items) => addWorkspaceNotice(items, { id: "ask-result", tone: "warning", title: text, onClose: () => dismissWorkspaceNotice("ask-result") }));
    }, [dismissWorkspaceNotice]);
    useEmbeddedAskResult(showEmbeddedAskNotice);
    useEffect(() => {
        if (!workspaceNotices.some((item) => item.id === "ask-result")) return;
        const timer = setTimeout(() => dismissWorkspaceNotice("ask-result"), 5000);
        return () => clearTimeout(timer);
    }, [dismissWorkspaceNotice, workspaceNotices]);
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
        const onMessage = createEmbeddedWorkspaceSyncHandler({
            getPathname: () => appPathname(),
            hydrateProjects: () => { void hydrateLocalCanvasProjectsFromBackend(); },
            syncExtensions: () => {
                void syncPluginsFromBackend().catch(() => undefined);
                void hydrateLocalModelConfig().catch(() => undefined);
            },
            openCanvas: async (canvasId) => { await openLocalCanvasProjectFromBackend(canvasId); },
            refreshCanvas: async (canvasId) => { await refreshLocalCanvasProjectIfChanged(canvasId); },
            markExternalChange: notifyExternalCanvasEvent,
            findCanvasTitle: (canvasId) => useCanvasStore.getState().projects.find((project) => project.id === canvasId)?.title,
            canNotify: (canvasId) => canvasNoticeGate.allow(canvasId),
            openCanvasInUi: (canvasId) => navigate(`/canvas/${encodeURIComponent(canvasId)}`),
            notifyCanvasChange: (notice) => {
                const id = `canvas:${notice.canvasId}`;
                setWorkspaceNotices((items) => addWorkspaceNotice(items, {
                    id,
                    tone: "info",
                    title: notice.text,
                    action: <Button size="small" autoInsertSpace={false} onClick={() => { dismissWorkspaceNotice(id); notice.onOpen(); }}>打开</Button>,
                    onClose: () => dismissWorkspaceNotice(id),
                }));
            },
        });
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [canvasNoticeGate, dismissWorkspaceNotice, navigate]);

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
                <WorkspaceNoticeStack notices={workspaceNotices} />
            </div>
        </ConfigProvider>
    );
}
