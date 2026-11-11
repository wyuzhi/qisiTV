import { fetchPlugins, setPluginPlatformEnabled, setUserPluginEnabled, type PluginManagement } from "@/services/api/plugins";
import { usePluginStore } from "@/stores/use-plugin-store";

export async function setPluginActivation(pluginId: string, enabled: boolean, scope: PluginManagement["activationScope"] = "user") {
    const next = scope === "system"
        ? await setPluginPlatformEnabled(pluginId, enabled)
        : await setUserPluginEnabled(pluginId, enabled);
    const store = usePluginStore.getState();
    store.setPluginStates({ ...store.pluginStates, [next.pluginId]: next });
    store.setEnabled(pluginId, next.effectiveEnabled);
    return next;
}

// The backend registry decides which plugins are installed and enabled. Every
// route follows it through the plugin store, so plugin canvas nodes render even
// when the plugin center was never opened in this window.
export async function syncPluginsFromBackend() {
    const result = await fetchPlugins();
    const plugins = (result.plugins || []).map((item) => ({
        manifest: {
            ...item.manifest,
            trusted: item.manifest.trusted ?? (item.source === "official" || item.source === "bundled" || item.source === "system"),
        },
        enabled: result.states?.[item.manifest.id]?.effectiveEnabled ?? item.status === "enabled",
    }));
    usePluginStore.getState().syncBackendPlugins(plugins, result.states || {});
    return result;
}
