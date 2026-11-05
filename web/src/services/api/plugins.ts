import { http } from "@/services/api/request";
import type { RegisteredPlugin } from "@/lib/plugins/plugin-types";

export type BackendPlugin = {
    manifest: RegisteredPlugin["manifest"];
    source: "bundled" | "uploaded" | "package" | "local" | string;
    fileName: string;
    package: string;
    sha256: string;
    installedAt: string;
    updatedAt: string;
    status: "enabled" | "disabled" | "invalid" | string;
    error?: string;
    packageSpec?: string;
    management: PluginManagement;
};

export type WorkflowPluginStatus = "enabled" | "disabled" | "invalid" | string;

export type PluginManagement = {
    origin: "official" | "system" | "uploaded" | "package";
    kind: "protocol" | "application";
    activationScope: "system" | "user";
    configurationScope: "none" | "system" | "user";
};

export type PluginState = {
    pluginId: string;
    platformAvailable: boolean;
    userEnabled: boolean;
    userConfigured: boolean;
    effectiveEnabled: boolean;
    canToggle: boolean;
    canConfigure: boolean;
    blockedReason?: string;
};

export async function fetchPlugins() {
    return http.get<{ plugins: BackendPlugin[]; states: Record<string, PluginState> }>("/plugins");
}

export async function fetchPluginRuntimeState() {
    return http.get<{ statuses: Record<string, WorkflowPluginStatus>; states: Record<string, PluginState> }>("/plugins/status");
}

// npm downloads a package and its dependencies; the backend allows up to three minutes.
const PACKAGE_INSTALL_TIMEOUT_MS = 200_000;

export async function uploadPlugin(file: File) {
    const body = new FormData();
    body.append("file", file);
    const result = await http.post<{ plugin: BackendPlugin }>("/plugins", body, { timeout: PACKAGE_INSTALL_TIMEOUT_MS });
    return result.plugin;
}

/** source is an npm spec, a local package directory or a sample name shipped with BeefTV. */
export async function installPluginPackage(payload: { source: string; registry?: string }) {
    const result = await http.post<{ plugin: BackendPlugin }>("/plugins/install", payload, { timeout: PACKAGE_INSTALL_TIMEOUT_MS });
    return result.plugin;
}

export async function updatePluginPackage(id: string, registry?: string) {
    const result = await http.post<{ plugin: BackendPlugin }>(`/plugins/${encodeURIComponent(id)}/update`, { registry }, { timeout: PACKAGE_INSTALL_TIMEOUT_MS });
    return result.plugin;
}

export type PluginUpdateNotice = { id: string; version: string; latest: string; official?: boolean };
/** updates 是有新版本的插件，upToDate 是确认已是最新的插件；两边都不在的插件没法比较版本。 */
export type PluginUpdateCheck = { updates: PluginUpdateNotice[]; upToDate: string[] };

export async function fetchPluginUpdates(signal?: AbortSignal) {
    return http.get<PluginUpdateCheck>("/plugins/updates", { signal, timeout: 15_000 });
}

export async function reportPluginLoadError(id: string, error: string) {
    return http.post<{ status?: string }>(`/plugins/${encodeURIComponent(id)}/load-error`, { error });
}

export async function setUserPluginEnabled(id: string, enabled: boolean) {
    const result = await http.put<{ state: PluginState }>(`/plugins/${encodeURIComponent(id)}/activation`, { enabled });
    return result.state;
}

/** System-scoped plugins (protocols, packages) are switched for the whole workspace. */
export async function setPluginPlatformEnabled(id: string, enabled: boolean) {
    const result = await http.post<{ state: PluginState }>(`/plugins/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`);
    return result.state;
}

export async function uninstallPlugin(id: string) {
    await http.delete<{ deleted: boolean }>(`/plugins/${encodeURIComponent(id)}`);
}
