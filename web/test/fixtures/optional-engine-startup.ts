import "@/main";
import { beginEngineWorkspaceConnection, isBrowserWorkspace, isEngineWebsite } from "@/services/browser-workspace";
import { rememberEngineSession } from "@/services/engine-session";

Object.assign(window, {
    startEngine: beginEngineWorkspaceConnection,
    dropEngineToken: () => rememberEngineSession(),
    workspaceMode: () => isEngineWebsite() ? "engine" : isBrowserWorkspace() ? "browser" : "desktop",
});
