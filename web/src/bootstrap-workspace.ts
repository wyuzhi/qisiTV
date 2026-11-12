import { bootstrapDesktopRuntime } from "@/services/desktop-runtime";
import { isEmbeddedRuntime } from "@/lib/embedded-runtime";
import { setWorkspaceStorageScope } from "@/lib/user-scope";
import { getWorkspaceBootstrap } from "@/services/api/workspace";

export async function startApplication() {
    await bootstrapDesktopRuntime();
    if (isEmbeddedRuntime()) {
        const payload = await getWorkspaceBootstrap();
        // Store modules automatically hydrate on import. Select this document's
        // durable workspace before they can read another window's last scope.
        setWorkspaceStorageScope(payload.workspace.id);
    }
    const [{ useCanvasStore }, { hydrateLocalCanvasProjectsFromBackend }, { bootstrapAppearance }] = await Promise.all([
        import("@/stores/canvas/use-canvas-store"),
        import("@/services/local-workspace-repository"),
        import("@/services/appearance-bootstrap"),
    ]);
    // 浏览器缓存晚于后端读入完成时，会用旧连接数组盖掉刚合并的画布。
    await useCanvasStore.persist.rehydrate();
    if (!isEmbeddedRuntime()) await hydrateLocalCanvasProjectsFromBackend();
    await bootstrapAppearance().catch(() => console.warn("外观初始化未完成，继续打开工作区"));
    await import("./application");
}
