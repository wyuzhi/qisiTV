import { beforeEach, describe, expect, test } from "bun:test";
import { PLUGIN_API_VERSION, type PluginManifestV2 } from "../src/lib/plugins/plugin-types";
import { usePluginStore } from "../src/stores/use-plugin-store";

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
