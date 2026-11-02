import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { startCheckedWorkspace } from "@/services/diagnostics/startup-preflight";
import { isEngineWebsite, isWebsiteWorkspace, rememberWebsiteMode } from "@/services/browser-workspace";
import { setActiveUserScope } from "@/lib/user-scope";

void startCheckedWorkspace(async () => {
    rememberWebsiteMode();
    // Select the browser namespace before importing any persisted store. The
    // last tab's engine workspace id in localStorage is never a browser cache.
    if (isWebsiteWorkspace()) setActiveUserScope("local");
    if (isEngineWebsite()) {
        await import("@/services/browser-engine-migration").then((module) => module.captureBrowserMigrationScope());
        await import("@/services/engine-bootstrap").then((module) => module.requireEngineConnection());
        const { configureEngineApiRuntime, http } = await import("@/services/api/request");
        configureEngineApiRuntime();
        const { workspace } = await http.get<{ workspace: { id: string } }>("/workspace/bootstrap");
        if (typeof workspace?.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(workspace.id) || workspace.id === "local") throw new Error("本机引擎未提供独立的工作区身份");
        setActiveUserScope(workspace.id);
    }
    await import("./bootstrap-workspace").then((module) => module.startApplication());
});
