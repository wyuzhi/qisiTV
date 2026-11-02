import { http } from "@/services/api/request";
import type { PluginTrustTier, RegisteredPlugin } from "@/lib/plugins/plugin-types";

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
    clientUrl?: string;
    trustTier?: PluginTrustTier;
    updateAvailable?: string;
    management: PluginManagement;
};

export type PluginMarketEntry = {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    source: string;
    trustTier?: PluginTrustTier;
    permissions?: string[];
    hasClientCode?: boolean;
    hasNativeHostCode?: boolean;
    spec?: string;
};

export type WorkflowPluginStatus = "enabled" | "disabled" | "invalid" | string;

export type PluginManagement = {
    origin: "official" | "system" | "uploaded";
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

export async function uploadPlugin(file: File) {
    const body = new FormData();
    body.append("file", file);
    const result = await http.post<{ plugin: BackendPlugin }>("/plugins", body);
    return result.plugin;
}

export async function installPluginPackage(payload: {
    spec?: string;
    packageUrl?: string;
    localPath?: string;
    source?: string;
    sha256?: string;
    trustTier?: PluginTrustTier;
}) {
    const result = await http.post<{ plugin: BackendPlugin }>("/plugins/install", payload);
    return result.plugin;
}

export async function updatePluginPackage(id: string) {
    const result = await http.post<{ plugin: BackendPlugin }>(`/plugins/${encodeURIComponent(id)}/update`, {});
    return result.plugin;
}

export async function reportPluginLoadError(id: string, error: string) {
    return http.post<{ status?: string }>(`/plugins/${encodeURIComponent(id)}/load-error`, { error });
}

export async function fetchPluginMarketRegistry() {
    return http.get<{ items: PluginMarketEntry[] }>("/plugins/market");
}

export async function setUserPluginEnabled(id: string, enabled: boolean) {
    const result = await http.put<{ state: PluginState }>(`/plugins/${encodeURIComponent(id)}/activation`, { enabled });
    return result.state;
}

export async function uninstallPlugin(id: string) {
    await http.delete<{ deleted: boolean }>(`/plugins/${encodeURIComponent(id)}`);
}
