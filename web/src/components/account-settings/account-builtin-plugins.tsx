import { App, Button, Input } from "antd";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/base/switch";
import { listRegisteredPlugins } from "@/lib/plugins/plugin-registry";
import type { RegisteredPlugin } from "@/lib/plugins/plugin-types";
import { isOfficialApplicationPluginId } from "@/lib/plugins/official-applications";
import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { PLUGIN_PERMISSION_LABELS, pluginOrigin } from "@/pages/plugins/plugin-documentation";
import type { BackendPlugin } from "@/services/api/plugins";
import { setPluginActivation, syncPluginsFromBackend } from "@/services/plugin-sync";
import { usePluginStore } from "@/stores/use-plugin-store";
import { useUserStore } from "@/stores/use-user-store";

export function AccountBuiltinPlugins({ onManage }: { onManage: () => void }) {
    const { message } = App.useApp();
    const [plugins, setPlugins] = useState<BackendPlugin[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [pending, setPending] = useState<string | null>(null);
    const updating = useRef(false);
    const states = usePluginStore((state) => state.pluginStates);
    const installations = usePluginStore((state) => state.installations);
    const user = useUserStore((state) => state.user);
    const systemVisible = useUserStore((state) => state.features.systemPluginsVisibleToUsers);
    useEffect(() => {
        let current = true;
        void syncPluginsFromBackend().then((result) => { if (current) setPlugins(result.plugins); }).catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : "读取插件失败"); }).finally(() => { if (current) setLoading(false); });
        return () => { current = false; };
    }, []);
    const backendById = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]));
    const registered = new Map(listRegisteredPlugins().map((plugin) => [plugin.manifest.id, plugin]));
    for (const plugin of plugins) registered.set(plugin.manifest.id, { manifest: plugin.manifest, source: plugin.source });
    const visible = [...registered.values()].filter((plugin) => {
        const remote = backendById.get(plugin.manifest.id);
        if (pluginOrigin(plugin) !== "official") return false;
        if (remote?.management.builtInInterface) return false;
        if (user?.role !== "admin" && !systemVisible && remote?.management.kind !== "application" && !isOfficialApplicationPluginId(plugin.manifest.id)) return false;
        return `${plugin.manifest.name} ${plugin.manifest.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
    });
    const toggle = async (plugin: RegisteredPlugin, enabled: boolean) => {
        if (updating.current) return;
        updating.current = true;
        setPending(plugin.manifest.id);
        try {
            const remote = backendById.get(plugin.manifest.id);
            if (!remote && !states[plugin.manifest.id] && isLocalRuntimeMode()) usePluginStore.getState().setEnabled(plugin.manifest.id, enabled);
            else await setPluginActivation(plugin.manifest.id, enabled, remote?.management.activationScope);
        }
        catch (reason) { message.error(reason instanceof Error ? reason.message : "更新插件状态失败"); }
        finally { updating.current = false; setPending(null); }
    };
    return <>
        <div className="account-plugins-toolbar"><Input aria-label="搜索内置插件" placeholder="搜索插件" prefix={<Search size={16} />} value={search} allowClear onChange={(event) => setSearch(event.target.value)} /><Button onClick={onManage}>管理全部插件</Button></div>
        {loading ? <p role="status">正在读取插件…</p> : error ? <div role="alert"><p>{error}</p><Button onClick={onManage}>前往插件页重试</Button></div> : !visible.length ? <p className="account-empty">{search ? "没有匹配的内置插件" : "暂无内置插件"}</p> : <div className="account-builtin-list">
            {visible.map((plugin) => {
                const { manifest } = plugin;
                const state = states[manifest.id];
                const remote = backendById.get(manifest.id);
                const enabled = state?.effectiveEnabled ?? installations.find((item) => item.manifest.id === manifest.id)?.enabled ?? false;
                const canToggle = state?.canToggle ?? (!remote && isLocalRuntimeMode());
                const statusLabel = !state?.platformAvailable && state?.blockedReason ? state.blockedReason : enabled ? "已启用" : "已停用";
                return <section className="account-builtin-item" key={manifest.id}>
                    <div className="account-builtin-heading"><h3>{manifest.name}</h3><span>{statusLabel}</span><Switch aria-label={`${enabled ? "停用" : "启用"}${manifest.name}`} checked={enabled} loading={pending === manifest.id} disabled={Boolean(pending) || !canToggle} title={!canToggle ? state?.blockedReason : undefined} onChange={(value) => void toggle(plugin, value)} /></div>
                    {manifest.description ? <p>{manifest.description}</p> : null}
                    <details><summary>插件信息</summary><dl><div><dt>版本</dt><dd>{manifest.version}</dd></div>{manifest.author ? <div><dt>作者</dt><dd>{manifest.author}</dd></div> : null}<div><dt>权限</dt><dd>{manifest.permissions.map((permission) => PLUGIN_PERMISSION_LABELS[permission] || permission).join("、") || "无额外权限"}</dd></div></dl></details>
                </section>;
            })}
        </div>}
    </>;
}
