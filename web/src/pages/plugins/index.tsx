import { CollectionToolbar } from "@/components/layout/collection-toolbar";
import { App, Button, Input, InputNumber, Modal, Select, Typography } from "antd";
import { Switch } from "@/components/ui/base/switch";
import { ArrowUpCircle, AudioLines, CalendarDays, CheckCircle2, Clock3, ExternalLink, Film, Image as ImageIcon, MessageSquareText, Plus, PlugZap, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { EmptyState } from "@/components/ui/product/empty-state";
import { PageHeader } from "@/components/layout/workspace-page";
import { listRegisteredPlugins } from "@/lib/plugins/plugin-registry";
import "@/lib/plugins/builtin";
import { EAGLE_PLUGIN_ID } from "@/lib/plugins/builtin/eagle";
import { PROMPT_OPTIMIZER_PLUGIN_ID } from "@/lib/plugins/builtin/prompt-optimizer";
import { RUNNINGHUB_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { isOfficialApplicationPluginId } from "@/lib/plugins/official-applications";
import { deactivateClientPlugin, syncActiveClientPlugins } from "@/lib/plugins/plugin-client-loader";
import { PLUGIN_INSTALL_REQUEST_EVENT } from "@/lib/plugins/plugin-host-runtime";
import type { PluginField, PluginInstallConfirmRequest, PluginManifest, PluginManifestV2, RegisteredPlugin } from "@/lib/plugins/plugin-types";
import { usePluginSlot } from "@/lib/plugins/slot-registry";
import { EaglePluginSettingsPanel } from "@/pages/plugins/eagle";
import {
    installPluginPackage,
    setPluginPlatformEnabled,
    setUserPluginEnabled,
    uninstallPlugin,
    updatePluginPackage,
    type BackendPlugin,
    type PluginState,
} from "@/services/api/plugins";
import { syncPluginsFromBackend } from "@/services/plugin-sync";
import { usePluginStore } from "@/stores/use-plugin-store";
import { useUserStore } from "@/stores/use-user-store";
import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { workspaceCapabilities } from "@/services/workspace-mode";

import { PluginDetailsModal } from "./plugin-documentation-modals";
import { PluginInstallConfirmModal } from "./plugin-install-confirm-modal";
import "./plugins.css";

const categoryLabels: Record<string, string> = {
    provider: "模型渠道",
    "canvas-node": "画布节点",
    workflow: "工作流",
    transform: "媒体转换",
    "asset-source": "素材来源",
    "ai-capability": "AI 能力",
    "usage-observer": "用量观察",
    agent: "智能体",
    "import-export": "导入导出",
};

const surfaceLabels: Record<string, string> = {
    node: "画布节点",
    fullscreen: "全屏工作台",
    hybrid: "混合接入",
    "asset-source": "素材库",
};

const permissionLabels: Record<string, string> = {
    "canvas.read": "读取画布",
    "canvas.write": "修改画布",
    "asset.read": "读取素材",
    "asset.search": "搜索素材",
    "asset.import": "导入素材",
    "asset.upload": "上传素材",
    "generation.run": "调用生成",
    "ai.text": "调用已配置的文本/视觉理解模型",
    "media.read": "读取输入媒体",
    "external.open": "打开外部详情",
};

const pluginDateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" });

const protocolSectionMeta = [
    { key: "text", label: "文本协议", description: "对话、推理与流式响应", icon: MessageSquareText },
    { key: "image", label: "图片协议", description: "生成、编辑与参考图", icon: ImageIcon },
    { key: "video", label: "视频协议", description: "创建任务、轮询与媒体结果", icon: Film },
    { key: "audio", label: "音频协议", description: "语音与异步音频任务", icon: AudioLines },
] as const;

export default function PluginsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const features = useUserStore((state) => state.features);
    const localRuntime = isLocalRuntimeMode() || workspaceCapabilities().local;
    const visibleProtocolSectionMeta = protocolSectionMeta;
    const installations = usePluginStore((state) => state.installations);
    const ensurePlugin = usePluginStore((state) => state.ensurePlugin);
    const setEnabled = usePluginStore((state) => state.setEnabled);
    const removePlugin = usePluginStore((state) => state.removePlugin);
    const setRuntimeStatuses = usePluginStore((state) => state.setRuntimeStatuses);
    const setPluginStates = usePluginStore((state) => state.setPluginStates);
    const pluginStates = usePluginStore((state) => state.pluginStates);
    const updateConfig = usePluginStore((state) => state.updateConfig);
    const builtinPlugins = useMemo(() => listRegisteredPlugins(), []);
    const pluginCenterSections = usePluginSlot("pluginCenter.section");
    const appSettingsEntries = usePluginSlot("app.settings");
    const [backendPlugins, setBackendPlugins] = useState<BackendPlugin[]>([]);
    const [backendPluginsLoading, setBackendPluginsLoading] = useState(false);
    const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);
    const [detailsPluginId, setDetailsPluginId] = useState<string | null>(null);
    const [detailsRestoreFocus, setDetailsRestoreFocus] = useState(false);
    const [installModalOpen, setInstallModalOpen] = useState(false);
    const [installPendingRequest, setInstallPendingRequest] = useState<PluginInstallConfirmRequest | null>(null);
    const [installing, setInstalling] = useState(false);
    const [updatingPluginId, setUpdatingPluginId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [categoryFilter, setCategoryFilter] = useState("all");
    const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
    const [trustFilter, setTrustFilter] = useState<"all" | "trusted">("all");

    useEffect(() => {
        for (const plugin of builtinPlugins) ensurePlugin(plugin.manifest);
        syncActiveClientPlugins();
    }, [builtinPlugins, ensurePlugin]);

    useEffect(() => {
        const handleRequest = (event: Event) => {
            const custom = event as CustomEvent<PluginInstallConfirmRequest>;
            if (custom.detail) {
                setInstallPendingRequest(custom.detail);
                setInstallModalOpen(true);
            }
        };
        window.addEventListener(PLUGIN_INSTALL_REQUEST_EVENT, handleRequest);
        return () => window.removeEventListener(PLUGIN_INSTALL_REQUEST_EVENT, handleRequest);
    }, []);

    const reloadBackendPlugins = async () => {
        setBackendPluginsLoading(true);
        try {
            const result = await syncPluginsFromBackend();
            setBackendPlugins(result.plugins || []);
        } catch (error) {
            if (!localRuntime) {
                message.error(error instanceof Error ? error.message : "读取插件中心失败");
            }
            setBackendPlugins([]);
            if (localRuntime) {
                setPluginStates({});
            }
        } finally {
            setBackendPluginsLoading(false);
        }
    };

    useEffect(() => {
        void reloadBackendPlugins();
    }, [localRuntime, user?.id]);

    const remotePlugins = useMemo(() => backendPlugins.map(toRegisteredPlugin), [backendPlugins]);
    const registeredPlugins = useMemo(() => {
        const byId = new Map(builtinPlugins.map((plugin) => [plugin.manifest.id, plugin]));
        for (const plugin of remotePlugins) byId.set(plugin.manifest.id, plugin);
        return [...byId.values()];
    }, [builtinPlugins, remotePlugins]);
    const backendPluginById = useMemo(() => new Map(backendPlugins.map((plugin) => [plugin.manifest.id, plugin])), [backendPlugins]);

    const filteredPlugins = useMemo(() => {
        const normalizedSearch = search.trim().toLocaleLowerCase();
        return registeredPlugins.filter((plugin) => {
            const state = pluginStates[plugin.manifest.id];
            const isApplicationPlugin = backendPluginById.get(plugin.manifest.id)?.management.kind === "application" || isOfficialApplicationPluginId(plugin.manifest.id);
            if (user?.role !== "admin" && !features.systemPluginsVisibleToUsers && !isApplicationPlugin) return false;
            const installation = installations.find((item) => item.manifest.id === plugin.manifest.id);
            const enabled = state?.effectiveEnabled ?? Boolean(installation?.enabled);
            const manifest = plugin.manifest;
            if (localRuntime && manifest.id === RUNNINGHUB_PLUGIN_ID) return false;
            const contributionKinds = contributionKindsFor(manifest);
            const searchableText = [manifest.name, manifest.description, manifest.author, manifest.id, ...contributionKinds.map((kind) => categoryLabels[kind] || kind)].filter(Boolean).join(" ").toLocaleLowerCase();
            if (normalizedSearch && !searchableText.includes(normalizedSearch)) return false;
            if (categoryFilter !== "all" && !pluginMatchesCategory(manifest, categoryFilter)) return false;
            if (trustFilter === "trusted" && !manifest.trusted) return false;
            if (statusFilter === "enabled" && !enabled) return false;
            if (statusFilter === "disabled" && enabled) return false;
            return true;
        });
    }, [backendPluginById, categoryFilter, features.systemPluginsVisibleToUsers, installations, localRuntime, pluginStates, registeredPlugins, search, statusFilter, trustFilter, user?.role]);

    const pluginSections = useMemo(
        () =>
            [
                ...visibleProtocolSectionMeta.map((section) => ({ ...section, plugins: filteredPlugins.filter((plugin) => pluginMatchesCategory(plugin.manifest, section.key)) })),
                { key: "other", label: "应用插件", description: "画布、素材与工作流扩展", icon: PlugZap, plugins: filteredPlugins.filter((plugin) => pluginMatchesCategory(plugin.manifest, "other")) },
            ].filter((section) => categoryFilter === "all" || section.key === categoryFilter),
        [categoryFilter, filteredPlugins, visibleProtocolSectionMeta],
    );

    const scrollContainerRef = useRef<HTMLDivElement>(null);

    const selectCategory = (key: string) => {
        setCategoryFilter(key);
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = 0;
        }
    };

    const categoryCounts = useMemo(() => {
        const visiblePlugins = registeredPlugins.filter((plugin) => {
            if (localRuntime && plugin.manifest.id === RUNNINGHUB_PLUGIN_ID) return false;
            const isApplicationPlugin =
                backendPluginById.get(plugin.manifest.id)?.management.kind === "application" ||
                isOfficialApplicationPluginId(plugin.manifest.id);
            return user?.role === "admin" || features.systemPluginsVisibleToUsers || isApplicationPlugin;
        });
        const counts: Record<string, number> = { all: visiblePlugins.length, text: 0, image: 0, video: 0, audio: 0, other: 0 };
        for (const plugin of visiblePlugins) {
            for (const section of visibleProtocolSectionMeta) {
                if (pluginMatchesCategory(plugin.manifest, section.key)) counts[section.key] += 1;
            }
            if (pluginMatchesCategory(plugin.manifest, "other")) counts.other += 1;
        }
        return counts;
    }, [features.systemPluginsVisibleToUsers, localRuntime, registeredPlugins, user?.role, visibleProtocolSectionMeta]);

    const settingsPlugin = settingsPluginId ? registeredPlugins.find((plugin) => plugin.manifest.id === settingsPluginId) : undefined;
    const settingsInstallation = settingsPlugin ? installations.find((item) => item.manifest.id === settingsPlugin.manifest.id) : undefined;
    const detailsPlugin = detailsPluginId ? registeredPlugins.find((plugin) => plugin.manifest.id === detailsPluginId) : undefined;

    const hasCustomAppSettings = (plugin: RegisteredPlugin) =>
        appSettingsEntries.some((entry) => entry.pluginId === plugin.manifest.id);
    const hasPluginConfiguration = (plugin: RegisteredPlugin) =>
        Boolean(plugin.manifest.configuration?.fields?.length) ||
        hasCustomAppSettings(plugin);
    const canConfigurePlugin = (plugin: RegisteredPlugin) =>
        localRuntime || hasCustomAppSettings(plugin)
            ? hasPluginConfiguration(plugin)
            : Boolean(pluginStates[plugin.manifest.id]?.canConfigure) &&
              (hasPluginConfiguration(plugin) || plugin.manifest.id === RUNNINGHUB_PLUGIN_ID);

    const isPluginEnabled = (plugin: RegisteredPlugin, installation = installations.find((item) => item.manifest.id === plugin.manifest.id)) => pluginStates[plugin.manifest.id]?.effectiveEnabled ?? Boolean(installation?.enabled);

    const togglePlugin = async (plugin: RegisteredPlugin, enabled: boolean) => {
        try {
            const remote = backendPluginById.get(plugin.manifest.id);
            if (localRuntime && !remote && !(plugin.manifest.id in pluginStates)) {
                setEnabled(plugin.manifest.id, enabled);
                message.success(`${plugin.manifest.name}${enabled ? "已启用" : "已停用"}`);
                return;
            }
            const next = remote?.management.activationScope === "system"
                ? await setPluginPlatformEnabled(plugin.manifest.id, enabled)
                : await setUserPluginEnabled(plugin.manifest.id, enabled);
            setEnabled(plugin.manifest.id, next.effectiveEnabled ?? enabled);
            setPluginStates({ ...usePluginStore.getState().pluginStates, [next.pluginId]: next });
            if (next.pluginId === RUNNINGHUB_PLUGIN_ID) {
                setRuntimeStatuses({ ...usePluginStore.getState().runtimeStatuses, [next.pluginId]: next.effectiveEnabled ? "enabled" : "disabled" });
            }
            message.success(`${plugin.manifest.name}${enabled ? "已启用" : "已停用"}`);
        } catch (error) {
            if (localRuntime) {
                setEnabled(plugin.manifest.id, enabled);
                message.success(`${plugin.manifest.name}${enabled ? "已启用" : "已停用"}`);
                return;
            }
            message.error(error instanceof Error ? error.message : "更新插件状态失败");
        }
    };

    const handleInstallConfirm = async (request: PluginInstallConfirmRequest) => {
        setInstalling(true);
        try {
            const installed = await installPluginPackage({ source: request.source, registry: request.registry });
            deactivateClientPlugin(installed.manifest.id);
            setInstallModalOpen(false);
            setInstallPendingRequest(null);
            message.success(`已安装插件「${installed.manifest.name}」`);
            await reloadBackendPlugins();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "安装插件失败");
        } finally {
            setInstalling(false);
        }
    };

    const handleUpdatePlugin = async (pluginId: string) => {
        setUpdatingPluginId(pluginId);
        try {
            const updated = await updatePluginPackage(pluginId);
            deactivateClientPlugin(updated.manifest.id);
            message.success(`插件「${updated.manifest.name}」已更新到 v${updated.manifest.version}`);
            await reloadBackendPlugins();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新插件失败");
        } finally {
            setUpdatingPluginId(null);
        }
    };

    const handleUninstallPlugin = async (plugin: RegisteredPlugin) => {
        try {
            if (!localRuntime || backendPluginById.has(plugin.manifest.id)) {
                await uninstallPlugin(plugin.manifest.id);
            }
            deactivateClientPlugin(plugin.manifest.id);
            removePlugin(plugin.manifest.id);
            message.success(`已卸载插件「${plugin.manifest.name}」`);
            await reloadBackendPlugins();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "卸载插件失败");
        }
    };

    const activeCustomSection = categoryFilter.startsWith("slot:")
        ? pluginCenterSections.find((entry) => `slot:${entry.pluginId}:${entry.payload.id}` === categoryFilter)
        : undefined;
    const matchedSettingsSlot = settingsPlugin
        ? appSettingsEntries.find((entry) => entry.pluginId === settingsPlugin.manifest.id)
        : undefined;

    return (
        <main className="app-workspace-page plugins-page flex h-full min-h-0 flex-col text-foreground">
            <div ref={scrollContainerRef} className="app-workspace-scroll min-h-0 flex-1 overflow-y-auto">
                <div className="plugins-page-layout">
                    <aside className="plugins-sidebar" aria-label="插件分类">
                        <div className="plugins-sidebar-heading">
                            <PageHeader title="插件中心" description="连接模型、素材与工作流，拓展你的创作工具。" />
                        </div>
                        <nav className="plugins-sidebar-nav">
                            <button type="button" className={`plugins-sidebar-item${categoryFilter === "all" ? " is-active" : ""}`} aria-current={categoryFilter === "all" ? "page" : undefined} onClick={() => selectCategory("all")}>
                                <span className="plugins-sidebar-item-label">
                                    <PlugZap className="size-4" />
                                    全部插件
                                </span>
                                <span>{categoryCounts.all}</span>
                            </button>
                            {visibleProtocolSectionMeta.map((section) => {
                                const SectionIcon = section.icon;
                                return (
                                    <button
                                        key={section.key}
                                        type="button"
                                        className={`plugins-sidebar-item${categoryFilter === section.key ? " is-active" : ""}`}
                                        aria-current={categoryFilter === section.key ? "page" : undefined}
                                        onClick={() => selectCategory(section.key)}
                                    >
                                        <span className="plugins-sidebar-item-label">
                                            <SectionIcon className="size-4" />
                                            {section.label}
                                        </span>
                                        <span>{categoryCounts[section.key] || 0}</span>
                                    </button>
                                );
                            })}
                            <button type="button" className={`plugins-sidebar-item${categoryFilter === "other" ? " is-active" : ""}`} aria-current={categoryFilter === "other" ? "page" : undefined} onClick={() => selectCategory("other")}>
                                <span className="plugins-sidebar-item-label">
                                    <PlugZap className="size-4" />
                                    应用插件
                                </span>
                                <span>{categoryCounts.other}</span>
                            </button>
                            {pluginCenterSections.map((entry) => {
                                const slotKey = `slot:${entry.pluginId}:${entry.payload.id}`;
                                return (
                                    <button
                                        key={slotKey}
                                        type="button"
                                        className={`plugins-sidebar-item${categoryFilter === slotKey ? " is-active" : ""}`}
                                        aria-current={categoryFilter === slotKey ? "page" : undefined}
                                        onClick={() => selectCategory(slotKey)}
                                    >
                                        <span className="plugins-sidebar-item-label">
                                            {entry.payload.icon ?? <PlugZap className="size-4" />}
                                            {entry.payload.label}
                                        </span>
                                    </button>
                                );
                            })}
                        </nav>
                    </aside>
                    <div className="plugins-page-content">
                        <CollectionToolbar label="插件筛选" trailing={<div className="plugins-toolbar-actions flex items-center gap-2">
                                <Button
                                    type="primary"
                                    icon={<Plus className="size-4" />}
                                    onClick={() => {
                                        setInstallPendingRequest(null);
                                        setInstallModalOpen(true);
                                    }}
                                >
                                    安装插件
                                </Button>
                                <Button icon={<RefreshCw className="size-4" />} loading={backendPluginsLoading} onClick={() => void reloadBackendPlugins()}>
                                    刷新插件
                                </Button>
                            </div>}>
                            <Input
                                className="plugins-search"
                                prefix={<Search className="size-4 text-foreground/38" aria-hidden="true" />}
                                value={search}
                                allowClear
                                placeholder="搜索插件名称、描述或作者"
                                onChange={(event) => setSearch(event.target.value)}
                            />
                            <Select
                                className="plugins-filter"
                                value={statusFilter}
                                options={[
                                    { value: "all", label: "全部状态" },
                                    { value: "enabled", label: "已启用" },
                                    { value: "disabled", label: "已停用" },
                                ]}
                                onChange={(value) => setStatusFilter(value as "all" | "enabled" | "disabled")}
                                aria-label="按状态筛选"
                            />
                            <Select
                                className="plugins-filter"
                                value={trustFilter}
                                options={[
                                    { value: "all", label: "全部来源" },
                                    { value: "trusted", label: "可信插件" },
                                ]}
                                onChange={(value) => setTrustFilter(value as "all" | "trusted")}
                                aria-label="按来源筛选"
                            />
                        </CollectionToolbar>

                        {activeCustomSection ? (
                            <section className="plugin-section">
                                <activeCustomSection.payload.component
                                    pluginId={activeCustomSection.pluginId}
                                    installedPlugins={registeredPlugins}
                                    pluginStates={pluginStates}
                                    reloadPlugins={reloadBackendPlugins}
                                    requestInstallPlugin={(req) => {
                                        setInstallPendingRequest(req);
                                        setInstallModalOpen(true);
                                    }}
                                />
                            </section>
                        ) : filteredPlugins.length ? (
                            <div className="plugins-sections">
                                {pluginSections.map((section) => {
                                    const SectionIcon = section.icon;
                                    return (
                                        <section
                                            key={section.key}
                                            id={`plugin-section-${section.key}`}
                                            className="plugin-section"
                                            data-category={section.key === "image" ? "creative" : section.key === "video" ? "drama" : section.key === "audio" ? "social" : undefined}
                                        >
                                            <header className="plugin-section-heading">
                                                <span className="plugin-section-icon">
                                                    <SectionIcon className="size-4" />
                                                </span>
                                                <div>
                                                    <h2>{section.label}</h2>
                                                    <p>{section.description}</p>
                                                </div>
                                                <span className="plugin-section-count">{section.plugins.length}</span>
                                            </header>
                                            {section.plugins.length ? (
                                                <div className="plugins-grid">
                                                    {section.plugins.map((plugin) => {
                                                        const installation = installations.find((item) => item.manifest.id === plugin.manifest.id);
                                                        const remote = backendPluginById.get(plugin.manifest.id);
                                                        const enabled = isPluginEnabled(plugin, installation);
                                                        const trusted = Boolean(plugin.manifest.trusted);
                                                        const state = pluginStates[plugin.manifest.id];
                                                        const sourceLabel = pluginSourceLabel(plugin, state);
                                                        const canConfigure = canConfigurePlugin(plugin);
                                                        const canToggle = localRuntime || user?.role === "admin" ? true : Boolean(state?.canToggle);
                                                        const canUninstall = Boolean(remote && remote.source !== "bundled" && remote.source !== "system" && remote.source !== "official");
                                                        return (
                                                            <section key={plugin.manifest.id} className={`product-collection-card plugin-card library-card-surface${trusted ? " is-trusted" : ""}`}>
                                                                <button
                                                                    type="button"
                                                                    className="plugin-card-main"
                                                                    aria-label={`查看${plugin.manifest.name}文档`}
                                                                    onClick={(event) => {
                                                                        const openedByKeyboard = event.detail === 0;
                                                                        setDetailsRestoreFocus(openedByKeyboard);
                                                                        setDetailsPluginId(plugin.manifest.id);
                                                                        if (!openedByKeyboard) event.currentTarget.blur();
                                                                    }}
                                                                >
                                                                    <div className="plugin-card-heading">
                                                                        <span className={`plugin-icon-tile${trusted ? " is-trusted" : ""}`} aria-hidden="true">
                                                                            <SectionIcon className="size-5" />
                                                                        </span>
                                                                        <div className="min-w-0 flex-1">
                                                                            <div className="plugin-card-title-row">
                                                                                <h3>{plugin.manifest.name}</h3>
                                                                                <span className="plugin-version">v{plugin.manifest.version}</span>
                                                                            </div>
                                                                            <div className="plugin-card-labels">
                                                                                <span className={`plugin-source-label${sourceLabel === "系统插件" ? " is-system" : ""}`}>{sourceLabel}</span>
                                                                                {trusted ? (
                                                                                    <span className="plugin-trust-label">
                                                                                        <ShieldCheck className="size-3.5" />
                                                                                        可信插件
                                                                                    </span>
                                                                                ) : null}
                                                                                <span className="plugin-category-label">
                                                                                    {contributionKindsFor(plugin.manifest)
                                                                                        .map((kind) => categoryLabels[kind] ?? kind)
                                                                                        .join(" · ")}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    </div>

                                                                    <p className="plugin-card-description">{plugin.manifest.description}</p>

                                                                    <div className="plugin-card-meta">
                                                                        <span>
                                                                            <CalendarDays className="size-3.5" />
                                                                            发布 {formatPluginDate(plugin.manifest.publishedAt)}
                                                                        </span>
                                                                        <span>
                                                                            <Clock3 className="size-3.5" />
                                                                            更新 {formatPluginDate(plugin.manifest.updatedAt)}
                                                                        </span>
                                                                    </div>

                                                                    <div className="plugin-card-tags">
                                                                        {(plugin.manifest.surfaces || []).map((surface) => (
                                                                            <span key={surface}>{surfaceLabels[surface] ?? surface}</span>
                                                                        ))}
                                                                        {providerCapabilitiesFor(plugin.manifest).map((capability) => (
                                                                            <span key={capability}>{capabilityLabel(capability)}</span>
                                                                        ))}
                                                                        {plugin.manifest.contributes.providers?.some((provider) => provider.poll) ? <span>异步轮询</span> : null}
                                                                        <span>{plugin.manifest.permissions.length} 项能力</span>
                                                                    </div>
                                                                </button>

                                                                <div className="plugin-card-actions">
                                                                    <span role="status" className={`settings-channel-status ${enabled ? "is-ready" : ""}`}>
                                                                        <i aria-hidden="true" />
                                                                        {!state?.platformAvailable && state?.blockedReason ? state.blockedReason : enabled ? "已启用" : "已停用"}
                                                                    </span>
                                                                    <Switch
                                                                        className="plugin-state-switch"
                                                                        disabled={!canToggle}
                                                                        checked={enabled}
                                                                        aria-label={`${plugin.manifest.name}，当前${enabled ? "已启用，点击停用" : "已停用，点击启用"}`}
                                                                        title={state?.blockedReason}
                                                                        onChange={(checked) => void togglePlugin(plugin, checked)}
                                                                    />
                                                                    {remote?.source === "package" && remote.packageSpec ? (
                                                                        <Button
                                                                            className="plugin-settings-button"
                                                                            icon={<ArrowUpCircle className="size-4" />}
                                                                            loading={updatingPluginId === plugin.manifest.id}
                                                                            onClick={() => void handleUpdatePlugin(plugin.manifest.id)}
                                                                        >
                                                                            更新
                                                                        </Button>
                                                                    ) : null}
                                                                    {canConfigure ? (
                                                                        <Button
                                                                            className="plugin-settings-button"
                                                                            icon={<Settings2 className="size-4" />}
                                                                            aria-expanded={settingsPluginId === plugin.manifest.id}
                                                                            aria-haspopup="dialog"
                                                                            onClick={() => setSettingsPluginId(plugin.manifest.id)}
                                                                        >
                                                                            设置
                                                                        </Button>
                                                                    ) : null}
                                                                    {canUninstall ? (
                                                                        <Button
                                                                            className="plugin-settings-button"
                                                                            danger
                                                                            icon={<Trash2 className="size-4" />}
                                                                            onClick={() => void handleUninstallPlugin(plugin)}
                                                                        >
                                                                            卸载
                                                                        </Button>
                                                                    ) : null}
                                                                </div>

                                                                {installation?.lastError || remote?.error ? (
                                                                    <Typography.Text type="danger" className="plugin-error" role="alert">
                                                                        {installation?.lastError || remote?.error}
                                                                    </Typography.Text>
                                                                ) : null}
                                                            </section>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <div className="plugin-section-empty-hint">
                                                    <span>暂无该类型的插件</span>
                                                </div>
                                            )}
                                        </section>
                                    );
                                })}
                            </div>
                        ) : (
                            <EmptyState
                                className="min-h-[260px] rounded-[var(--plugins-card-radius)] bg-foreground/[0.03]"
                                icon={SlidersHorizontal}
                                title="没有匹配的插件"
                                description="试试清空搜索词，或放宽筛选条件。"
                                action={
                                    <Button
                                        onClick={() => {
                                            setSearch("");
                                            setCategoryFilter("all");
                                            setStatusFilter("all");
                                            setTrustFilter("all");
                                        }}
                                    >
                                        清除筛选
                                    </Button>
                                }
                            />
                        )}

                        <Modal
                            className="workspace-modal workspace-modal-wide plugin-settings-modal"
                            title={settingsPlugin ? `${settingsPlugin.manifest.name} 设置` : null}
                            open={Boolean(settingsPlugin)}
                            centered
                            footer={null}
                            destroyOnHidden
                            onCancel={() => setSettingsPluginId(null)}
                            styles={{ body: { maxHeight: "min(72vh, 760px)", overflowY: "auto", overscrollBehavior: "contain" } }}
                        >
                            {settingsPlugin ? (
                                <div className="plugin-settings-panel plugin-settings-modal-panel">
                                    <div className="plugin-settings-heading">
                                        <div>
                                            <p>只展示这个插件实际支持的配置项。</p>
                                        </div>
                                        {settingsPlugin.manifest.trusted ? (
                                            <span className="plugin-trust-label">
                                                <ShieldCheck className="size-3.5" />
                                                可信插件
                                            </span>
                                        ) : (
                                            <span className="plugin-category-label">第三方插件</span>
                                        )}
                                    </div>

                                    {matchedSettingsSlot ? (
                                        (() => {
                                            const SettingsComp = matchedSettingsSlot.payload.component as React.ComponentType<Record<string, unknown>>;
                                            const handleSave = async (patch: Record<string, string | number | boolean>) => {
                                                updateConfig(settingsPlugin.manifest.id, patch);
                                            };
                                            return (
                                                <SettingsComp
                                                    pluginId={settingsPlugin.manifest.id}
                                                    config={settingsInstallation?.config || {}}
                                                    updateConfig={handleSave}
                                                    onChange={handleSave}
                                                />
                                            );
                                        })()
                                    ) : settingsPlugin.manifest.id === EAGLE_PLUGIN_ID ? (
                                        <EaglePluginSettingsPanel
                                            pluginId={EAGLE_PLUGIN_ID}
                                            config={settingsInstallation?.config || {}}
                                            updateConfig={async (patch) => {
                                                updateConfig(EAGLE_PLUGIN_ID, patch);
                                            }}
                                        />
                                    ) : settingsPlugin.manifest.id === PROMPT_OPTIMIZER_PLUGIN_ID ? (
                                        <div className="rounded-[var(--r-md)] border border-border/60 bg-muted/25 px-3 py-3 text-[var(--fs-body)] leading-6 text-foreground/70">
                                            <p>在创作页或图片、视频节点的提示词编辑器中使用“优化”按钮，即可让当前文本模型整理提示词。</p>
                                            <p className="mt-2 text-[var(--fs-micro)] text-foreground/50">插件不会自动覆盖原提示词，只有点击“采用”后才会回填到当前输入框。</p>
                                        </div>
                                    ) : settingsPlugin.manifest.id === RUNNINGHUB_PLUGIN_ID ? (
                                        <div className="plugin-settings-empty">
                                            <p>RunningHub 的 API Key、Workflow / App 和字段映射在宿主设置页维护。</p>
                                            <Button
                                                type="primary"
                                                icon={<ExternalLink className="size-4" />}
                                                onClick={() => {
                                                    setSettingsPluginId(null);
                                                    navigate("/settings?section=runninghub");
                                                }}
                                            >
                                                打开工作流设置
                                            </Button>
                                        </div>
                                    ) : settingsPlugin.manifest.configuration?.fields?.length ? (
                                        <PluginFieldsConfigForm
                                            fields={settingsPlugin.manifest.configuration.fields}
                                            initialValues={settingsInstallation?.config || {}}
                                            onSave={(values) => {
                                                updateConfig(settingsPlugin.manifest.id, values as Record<string, string | number | boolean>);
                                                message.success(`${settingsPlugin.manifest.name}配置已保存`);
                                            }}
                                        />
                                    ) : (
                                        <div className="plugin-settings-empty">
                                            {`贡献能力：${
                                                contributionKindsFor(settingsPlugin.manifest)
                                                    .map((kind) => categoryLabels[kind] || kind)
                                                    .join("、") || "未声明"
                                            }。当前接入位置和权限会根据插件清单自动生效。`}
                                        </div>
                                    )}

                                    <div className="plugin-permissions">
                                        <div>
                                            <span>接入位置</span>
                                            {(settingsPlugin.manifest.surfaces || []).map((surface) => surfaceLabels[surface] ?? surface).join("、") || "由贡献点决定"}
                                        </div>
                                        <div>
                                            <span>插件能力</span>
                                            {settingsPlugin.manifest.permissions.map((permission) => permissionLabels[permission] ?? permission).join("、")}
                                        </div>
                                    </div>
                                </div>
                            ) : null}
                        </Modal>
                        <PluginDetailsModal plugin={detailsPlugin} restoreFocus={detailsRestoreFocus} onClose={() => setDetailsPluginId(null)} />
                        <PluginInstallConfirmModal
                            open={installModalOpen}
                            initialRequest={installPendingRequest}
                            loading={installing}
                            onCancel={() => {
                                setInstallModalOpen(false);
                                setInstallPendingRequest(null);
                            }}
                            onConfirm={(req) => void handleInstallConfirm(req)}
                        />
                    </div>
                </div>
            </div>
        </main>
    );
}

function PluginFieldsConfigForm({
    fields,
    initialValues,
    onSave,
}: {
    fields: PluginField[];
    initialValues: Record<string, unknown>;
    onSave: (values: Record<string, unknown>) => void;
}) {
    const [values, setValues] = useState<Record<string, unknown>>(() => {
        const defaults: Record<string, unknown> = {};
        for (const field of fields) {
            defaults[field.name] = initialValues[field.name] !== undefined ? initialValues[field.name] : field.default;
        }
        return defaults;
    });

    return (
        <>
            <div className="plugin-settings-fields">
                {fields.map((field) => {
                    const currentValue = values[field.name];
                    const labelText = field.label || field.name;
                    return (
                        <div key={field.name} className="min-w-0">
                            {field.type === "boolean" ? (
                                <div className="plugin-setting-label-row">
                                    <label htmlFor={`plugin-field-${field.name}`}>{labelText}</label>
                                    <Switch
                                        id={`plugin-field-${field.name}`}
                                        checked={Boolean(currentValue)}
                                        onChange={(checked) => setValues((prev) => ({ ...prev, [field.name]: checked }))}
                                        aria-label={labelText}
                                    />
                                </div>
                            ) : (
                                <>
                                    <label htmlFor={`plugin-field-${field.name}`}>{labelText}</label>
                                    {field.type === "select" ? (
                                        <Select
                                            id={`plugin-field-${field.name}`}
                                            aria-label={labelText}
                                            value={typeof currentValue === "string" ? currentValue : undefined}
                                            options={(field.values || []).map((val) => ({ value: val, label: val }))}
                                            onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
                                        />
                                    ) : field.type === "number" ? (
                                        <InputNumber
                                            id={`plugin-field-${field.name}`}
                                            aria-label={labelText}
                                            className="w-full"
                                            value={typeof currentValue === "number" ? currentValue : undefined}
                                            onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
                                        />
                                    ) : field.type === "secret" ? (
                                        <Input.Password
                                            id={`plugin-field-${field.name}`}
                                            aria-label={labelText}
                                            value={typeof currentValue === "string" ? currentValue : ""}
                                            onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                                        />
                                    ) : (
                                        <Input
                                            id={`plugin-field-${field.name}`}
                                            aria-label={labelText}
                                            value={typeof currentValue === "string" ? currentValue : ""}
                                            onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                                        />
                                    )}
                                </>
                            )}
                            {field.description ? <p>{field.description}</p> : null}
                        </div>
                    );
                })}
            </div>
            <div className="plugin-settings-actions">
                <Button type="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => onSave(values)}>
                    保存配置
                </Button>
            </div>
        </>
    );
}

function formatPluginDate(value?: string) {
    if (!value) return "未记录";
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? pluginDateFormatter.format(timestamp) : "未记录";
}

function toRegisteredPlugin(plugin: BackendPlugin): RegisteredPlugin {
    return { manifest: plugin.manifest, source: plugin.source };
}

function pluginSourceLabel(plugin: RegisteredPlugin, state?: PluginState) {
    if (plugin.source === "uploaded") return "自定义插件";
    if (plugin.source === "system") return "系统插件";
    if (state?.canToggle || isOfficialApplicationPluginId(plugin.manifest.id)) return "官方插件";
    return "系统插件";
}

function contributionKindsFor(manifest: PluginManifest | PluginManifestV2): string[] {
    const contributions = manifest.contributes;
    const kinds: string[] = [];
    if (contributions.providers?.length) kinds.push("provider");
    if (contributions.workflows?.length) kinds.push("workflow");
    if (contributions.canvasNodes?.length) kinds.push("canvas-node");
    if (contributions.transforms?.length) kinds.push("transform");
    if (contributions.assetSources?.length) kinds.push("asset-source");
    if (contributions.aiCapabilities?.length) kinds.push("ai-capability");
    if (contributions.usageObservers?.length) kinds.push("usage-observer");
    if (contributions.agents?.length) kinds.push("agent");
    if (contributions.importExport?.length) kinds.push("import-export");
    return kinds;
}

function providerCapabilitiesFor(manifest: PluginManifest | PluginManifestV2) {
    return [...new Set((manifest.contributes.providers || []).flatMap((provider) => provider.capabilities))];
}

function pluginMatchesCategory(manifest: PluginManifest | PluginManifestV2, category: string) {
    const providerCapabilities = providerCapabilitiesFor(manifest);
    if (category === "other") return providerCapabilities.length === 0;
    return providerCapabilities.includes(category as "text" | "image" | "video" | "audio");
}

function capabilityLabel(value: string) {
    return ({ text: "文本", image: "图片", video: "视频", audio: "音频" } as Record<string, string>)[value] || value;
}
