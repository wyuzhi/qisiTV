import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PLUGIN_API_VERSION, type PluginManifestV2 } from "../src/lib/plugins/plugin-types";
import { usePluginStore } from "../src/stores/use-plugin-store";
import { setPluginActivation } from "../src/services/plugin-sync";
import { http } from "../src/services/api/request";
import type { PluginState } from "../src/services/api/plugins";

function manifest(id: string, version = "1.0.0"): PluginManifestV2 {
    return { apiVersion: PLUGIN_API_VERSION, id, name: id, version, description: "", permissions: [], contributes: {} };
}

describe("syncBackendPlugins", () => {
    beforeEach(() => {
        usePluginStore.setState({ installations: [], pluginStates: {}, runtimeStatuses: {} });
    });

    test("writes the whole list at once, however many plugins there are", () => {
        let writes = 0;
        const unsubscribe = usePluginStore.subscribe(() => {
            writes += 1;
        });
        const plugins = Array.from({ length: 100 }, (_, index) => ({ manifest: manifest(`p${index}`), enabled: index % 2 === 0 }));
        usePluginStore.getState().syncBackendPlugins(plugins, {});
        unsubscribe();

        expect(writes).toBe(1);
        const installations = usePluginStore.getState().installations;
        expect(installations).toHaveLength(100);
        expect(installations.filter((item) => item.enabled)).toHaveLength(50);
    });

    test("keeps what the user configured and follows the backend for the rest", () => {
        const store = usePluginStore.getState();
        store.syncBackendPlugins([{ manifest: manifest("kept"), enabled: true }], {});
        store.updateConfig("kept", { theme: "dark" });
        store.setError("kept", "加载失败");

        store.syncBackendPlugins([{ manifest: manifest("kept", "2.0.0"), enabled: false }], {});

        const [installation] = usePluginStore.getState().installations;
        expect(installation.manifest.version).toBe("2.0.0");
        expect(installation.enabled).toBe(false);
        expect(installation.config).toEqual({ theme: "dark" });
        expect(installation.lastError).toBeUndefined();
    });
});

describe("shared plugin activation", () => {
    beforeEach(() => usePluginStore.setState({ installations: [], pluginStates: {} }));

    for (const scope of ["system", "user"] as const) {
        test(`${scope} activation follows the backend effective state`, async () => {
            const state: PluginState = { pluginId: "builtin-tool", platformAvailable: true, userEnabled: true, userConfigured: false, effectiveEnabled: false, canToggle: true, canConfigure: false };
            const request = spyOn(http, scope === "system" ? "post" : "put").mockResolvedValue({ state });
            try {
                await setPluginActivation("builtin-tool", true, scope);
                if (scope === "system") expect(request).toHaveBeenCalledWith("/plugins/builtin-tool/enable");
                else expect(request).toHaveBeenCalledWith("/plugins/builtin-tool/activation", { enabled: true });
                expect(usePluginStore.getState().pluginStates["builtin-tool"]).toEqual(state);
                expect(usePluginStore.getState().installations[0].enabled).toBe(false);
            } finally { request.mockRestore(); }
        });
    }

    test("failed activation never pretends the plugin was enabled locally", async () => {
        usePluginStore.getState().syncBackendPlugins([{ manifest: manifest("builtin-tool"), enabled: false }], {});
        const request = spyOn(http, "put").mockRejectedValue(new Error("不允许启用"));
        try {
            await expect(setPluginActivation("builtin-tool", true, "user")).rejects.toThrow("不允许启用");
            expect(usePluginStore.getState().installations[0].enabled).toBe(false);
            expect(usePluginStore.getState().pluginStates).toEqual({});
        } finally { request.mockRestore(); }
    });
});
