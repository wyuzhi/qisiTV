import { http } from "@/services/api/request";
import type { WorkspaceCapabilityContract } from "@/services/workspace-mode";
import type { AiConfig } from "@/stores/use-config-store";
import type { FeatureAvailability, LocalUser, RuntimeLimits } from "@/stores/use-user-store";
import { isBrowserWorkspace } from "@/services/browser-workspace";

export type LocalWorkspace = {
    id: string;
    name: string;
    owner: "local";
    storage: "sqlite" | "indexeddb";
};

export type WorkspaceBootstrapPayload = {
    contractVersion: number;
    profile: "local";
    capabilities: WorkspaceCapabilityContract["capabilities"];
    user: LocalUser;
    workspace: LocalWorkspace;
    storageMode: "local";
    runtimeLimits?: RuntimeLimits;
    features?: FeatureAvailability;
};

export function getWorkspaceBootstrap() {
    if (isBrowserWorkspace()) return Promise.resolve(createLocalWorkspacePayload());
    return http.get<WorkspaceBootstrapPayload>("/workspace/bootstrap");
}

export function createLocalWorkspacePayload(): WorkspaceBootstrapPayload {
    return {
        contractVersion: 1,
        profile: "local",
        capabilities: { localAssets: true, providerCalls: true },
        user: { id: "local", username: "local", displayName: "本地工作区", role: "user", status: "active", createdAt: "", updatedAt: "" },
        workspace: { id: "local", name: "本地工作区", owner: "local", storage: isBrowserWorkspace() ? "indexeddb" : "sqlite" },
        storageMode: "local",
        features: { shortDramaEnabled: true, taskCenterEnabled: true, customChannelsEnabled: true, frontendModelsEnabled: false, pluginCenterEnabled: !isBrowserWorkspace(), systemPluginsVisibleToUsers: !isBrowserWorkspace() },
    };
}

export function getLocalModelConfig() {
	return http.get<LocalModelConfigPayload>("/workspace/model-config");
}

export type LocalModelConfigPayload = {
	config: AiConfig;
	revision: number;
	health: "ready" | "default" | "migrated" | "recovered";
	source: "builtin+local";
};

export function saveLocalModelConfig(config: AiConfig, expectedRevision: number) {
	return http.put<{ saved: boolean; revision: number }>("/workspace/model-config", { config, expectedRevision });
}
