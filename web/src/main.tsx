import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { startCheckedWorkspace } from "@/services/diagnostics/startup-preflight";

void startCheckedWorkspace(async () => {
    if (import.meta.env?.VITE_QISITV_ENGINE === "1") {
        await import("@/services/browser-engine-migration").then((module) => module.captureBrowserMigrationScope());
        await import("@/services/engine-bootstrap").then((module) => module.requireEngineConnection());
        await import("@/services/api/request").then((module) => module.configureEngineApiRuntime());
    }
    await import("./bootstrap-workspace").then((module) => module.startApplication());
});
