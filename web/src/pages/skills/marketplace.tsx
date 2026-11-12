import { App, Alert, Button, Dropdown, Select, Skeleton, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { CollectionHeader } from "@/components/layout/collection-header";
import { AppModal } from "@/components/ui/product/app-modal";
import { SegmentedControl } from "@/components/ui/base/segmented-control";
import { addSkill, deleteSkill, getSkill, installGitHubSkill, likeSkill, listSkills, removeSkill, syncSkill, unlikeSkill, type Skill } from "@/services/api/skills";
import { getAssistantSettings, isAssistantSettingsUnavailableError, updateAssistantSettings } from "@/services/api/assistant-settings";
import { forkSkill, getInstalledVersions, getMarketRelease, getPublicSkillsAbout, installMarketRelease, rollbackSkill, searchPublicSkillMarket, searchSkillMarket, type InstalledVersion, type MarketItem, type MarketRelease, type PublicMarketSkill } from "@/services/api/skill-market";
import { SkillEditorDrawer } from "./skill-editor-drawer";
import { SkillInstallModal } from "./skill-install-modal";
import { SkillDetailModal } from "./skill-detail-drawer";
import { SkillMarketInstallConfirmModal, isOfficialBuiltinMarketSkill, type SkillMarketInstallConfirmRequest } from "./skill-market-install-confirm-modal";
import { SkillPublishingPanel } from "./publishing-panel";
import { MarketFilePreview } from "./market-file-preview";
import { SkillFileDetails } from "./skill-file-details";
import { skillFailureMessage } from "./skill-feedback";
import { canInstallMarketRelease, isPublicMarketSkillInstalled, marketInstallationState, releaseUnsupportedReasons, requirementLabel } from "./market-copy";
import { ExternalLink, MoreHorizontal, RefreshCw } from "lucide-react";
import { Switch } from "@/components/ui/base/switch";
import { fallbackSkillCategories, formatSkillCount, skillOrigin } from "./skill-catalog";
import "./marketplace.css";

const SKILL_PAGE_SIZE = 20;

export default function SkillMarketplace() {
    const { message, modal } = App.useApp();
    const [params, setParams] = useSearchParams();
    const tab = ["market", "mine", "publish"].includes(params.get("tab") || "") ? params.get("tab")! : "market";
    const [items, setItems] = useState<MarketItem[]>([]);
    const [publicItems, setPublicItems] = useState<PublicMarketSkill[]>([]);
    const [publicNotice, setPublicNotice] = useState("");
    const [marketSource, setMarketSource] = useState<"all" | "beeftv" | "public">("all");
    const [publicDetail, setPublicDetail] = useState<PublicMarketSkill | null>(null);
    const [installed, setInstalled] = useState<Skill[]>([]);
    const [installedLoading, setInstalledLoading] = useState(true);
    const [installedError, setInstalledError] = useState("");
    const [installingRelease, setInstallingRelease] = useState("");
    const installing = useRef(false);
    const [local, setLocal] = useState<Skill[]>([]);
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    const [busy, setBusy] = useState(false);
    const [release, setRelease] = useState<MarketRelease | null>(null);
    const [detail, setDetail] = useState<Skill | null>(null);
    const [edit, setEdit] = useState<Skill | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [installOpen, setInstallOpen] = useState(false);
    const [pendingInstall, setPendingInstall] = useState<{ request: SkillMarketInstallConfirmRequest; onRun: () => void } | null>(null);
    const [versions, setVersions] = useState<{ skill: Skill; items: InstalledVersion[] } | null>(null);
    const [versionId, setVersionId] = useState("");
    const [scriptAutoRun, setScriptAutoRun] = useState(false);
    const [scriptLoadState, setScriptLoadState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
    const [scriptLoadError, setScriptLoadError] = useState("");
    const [scriptReloadKey, setScriptReloadKey] = useState(0);
    const [scriptSaving, setScriptSaving] = useState(false);
    const reload = useCallback(() => setRevision(n => n + 1), []);
    const changeTab = (next: string) => { setParams({ tab: next }); setPage(1); setQuery(""); };
    useEffect(() => {
        let cancelled = false;
        setScriptLoadState("loading");
        setScriptLoadError("");
        getAssistantSettings()
            .then((settings) => {
                if (cancelled) return;
                setScriptAutoRun(settings.skillScriptAutoRun);
                setScriptLoadState("ready");
            })
            .catch((err) => {
                if (cancelled) return;
                if (isAssistantSettingsUnavailableError(err)) { setScriptLoadState("unavailable"); return; }
                // 读取失败时不能沿用默认 OFF，否则会把实际已开启的设置显示成需要确认。
                setScriptLoadState("error");
                setScriptLoadError(err instanceof Error ? err.message : "读取技能脚本设置失败");
            });
        return () => { cancelled = true; };
    }, [scriptReloadKey]);
    const toggleScriptAutoRun = async (checked: boolean) => {
        setScriptSaving(true);
        try {
            const settings = await updateAssistantSettings({ skillScriptAutoRun: checked });
            setScriptAutoRun(settings.skillScriptAutoRun);
            message.success(settings.skillScriptAutoRun ? "已开启自动运行技能脚本" : "已关闭自动运行技能脚本");
        } catch (err) {
            message.error(err instanceof Error ? err.message : "保存技能脚本设置失败");
        } finally {
            setScriptSaving(false);
        }
    };
    useEffect(() => {
        if (tab === "publish") return;
        let stale = false;
        setLoading(true); setError("");
        const timer = setTimeout(() => {
            const clampPage = (nextTotal: number) => {
                setTotal(nextTotal);
                const maxPage = Math.max(1, Math.ceil(nextTotal / SKILL_PAGE_SIZE));
                if (page > maxPage) { setPage(maxPage); return false; }
                return true;
            };
            const work = tab === "market"
                ? Promise.allSettled([searchSkillMarket(query, page), searchPublicSkillMarket(query)]).then(([hubRes, pubRes]) => {
                    if (stale) return;
                    const hubItems = hubRes.status === "fulfilled" ? (hubRes.value.items || []) : [];
                    const hubTotal = hubRes.status === "fulfilled" ? hubRes.value.total : 0;
                    const pubItems = pubRes.status === "fulfilled" ? (pubRes.value.items || []) : [];
                    const notice = pubRes.status === "fulfilled" ? (pubRes.value.notice || "") : "";
                    if (hubRes.status === "rejected" && pubRes.status === "rejected") {
                        setError(hubRes.reason?.message || "暂时无法读取技能");
                        return;
                    }
                    setPublicItems(pubItems);
                    setPublicNotice(notice || (hubRes.status === "rejected" ? "技能市场服务暂不可用，当前展示公共技能目录快照。" : ""));
                    if (clampPage(hubTotal)) setItems(hubItems);
                })
                : listSkills({ scope: "mine", page, pageSize: SKILL_PAGE_SIZE, search: query }).then(value => { if (!stale && clampPage(value.totalCount)) setLocal(value.skills); });
            void work.catch(e => { if (!stale) setError(e.message || "暂时无法读取技能"); }).finally(() => { if (!stale) setLoading(false); });
        }, 200);
        return () => { stale = true; clearTimeout(timer); };
    }, [tab, page, query, revision]);
    useEffect(() => {
        if (tab !== "market") return;
        let stale = false;
        setInstalledLoading(true);
        setInstalledError("");
        void (async () => {
            const skills: Skill[] = [];
            for (let page = 1; ; page++) {
                const result = await listSkills({ scope: "mine", page, pageSize: 100 });
                if (stale) return;
                skills.push(...result.skills);
                if (!result.hasMore) break;
            }
            if (!stale) setInstalled(skills);
        })().catch(error => { if (!stale) setInstalledError(skillFailureMessage(error, "无法读取安装状态", "请刷新技能市场后重试。")); })
            .finally(() => { if (!stale) setInstalledLoading(false); });
        return () => { stale = true; };
    }, [tab, revision]);
    useEffect(() => {
        const skillId = params.get("skillId"), releaseId = params.get("releaseId");
        if (!skillId || !releaseId) return;
        let stale = false;
        setBusy(true); setRelease(null);
        void getMarketRelease(skillId, releaseId).then(value => { if (!stale) setRelease(value); })
            .catch(e => { if (!stale) message.error(skillFailureMessage(e, "无法打开技能版本", "请刷新技能市场后重新打开。")); })
            .finally(() => { if (!stale) setBusy(false); });
        return () => { stale = true; };
    }, [params, message]);
    const action = async (work: () => Promise<unknown>, done?: string, failure = "操作未完成", nextStep = "请保留当前内容，稍后重试。") => {
        setBusy(true);
        try { await work(); if (done) { message.success(done); reload(); } } catch (e) { message.error(skillFailureMessage(e, failure, nextStep)); } finally { setBusy(false); }
    };
    const openLocal = async (skill: Skill) => action(async () => { setDetail((await getSkill(skill.skillId)).skill); }, undefined, "无法打开技能详情", "请刷新“我的技能”后重新打开。");
    const openEditor = (skill?: Skill) => { setDetail(null); setEdit(skill || null); setEditorOpen(true); };
    const openRelease = (skillId: string, releaseId: string) => setParams({ tab: "market", skillId, releaseId });
    const deleteLocal = (skill: Skill) => modal.confirm({ title: `删除本机的“${skill.skillName}”？`, content: "本机技能文件和历史版本会被删除。公开市场中的版本不会改变。", okText: "删除本机技能", cancelText: "取消", okButtonProps: { danger: true }, onOk: async () => { await deleteSkill(skill.skillId); setDetail(null); reload(); } });
    const showVersions = async (skill: Skill) => action(async () => { const value = await getInstalledVersions(skill.skillId); setVersions({ skill, items: value.versions }); setVersionId(skill.versionId); }, undefined, "无法读取历史版本", "请关闭版本窗口后重试。");
    const install = (target: Pick<MarketRelease, "skillId" | "releaseId">, showMine: boolean) => {
        if (installing.current) return;
        installing.current = true;
        setInstallingRelease(target.releaseId);
        void action(async () => {
            const { skill } = await installMarketRelease(target.skillId, target.releaseId);
            setInstalled(previous => [skill, ...previous.filter(item => item.skillId !== skill.skillId)]);
            if (showMine) { setRelease(null); changeTab("mine"); }
        }, "已安装，可在画布助手中选择使用", "安装未完成", "请查看失败原因后重试，或打开技能详情检查使用条件。")
            .finally(() => { installing.current = false; setInstallingRelease(""); });
    };
    const requestInstall = (target: Pick<MarketItem, "skillId" | "releaseId" | "name" | "versionLabel" | "author" | "description">, showMine: boolean) => {
        if (isOfficialBuiltinMarketSkill(target, installed)) {
            install(target, showMine);
            return;
        }
        setPendingInstall({
            onRun: () => install(target, showMine),
            request: {
                skillId: target.skillId,
                releaseId: target.releaseId,
                name: target.name,
                versionLabel: target.versionLabel,
                author: target.author,
                description: target.description,
                isUpdate: marketInstallationState(target, installed) === "update",
            },
        });
    };
    const installPublic = (item: PublicMarketSkill, showMine: boolean) => {
        if (installing.current) return;
        installing.current = true;
        setInstallingRelease(item.id);
        void action(async () => {
            const { skill } = await installGitHubSkill({
                url: item.sourceUrl || `https://github.com/${item.source}`,
                subdir: item.skillId,
                tag: "others",
                isPrivate: true,
                autoUpdate: true,
            });
            setInstalled(previous => [skill, ...previous.filter(existing => existing.skillId !== skill.skillId)]);
            if (showMine) { setPublicDetail(null); changeTab("mine"); }
        }, "已从 GitHub 安装技能，可在画布助手中选择使用", "GitHub 技能安装未完成", "请检查网络连接或仓库地址后重试。")
            .finally(() => { installing.current = false; setInstallingRelease(""); });
    };
    const requestPublicInstall = (item: PublicMarketSkill, showMine: boolean) => {
        setPendingInstall({
            onRun: () => installPublic(item, showMine),
            request: {
                skillId: item.skillId,
                name: item.name,
                sourceRepo: item.source,
                sourceLabel: "公共技能目录",
                description: item.description || `来自 GitHub 仓库 ${item.source}（${formatSkillCount(item.installs)} 次安装）`,
            },
        });
    };
    const openPublicSkill = (item: PublicMarketSkill) => {
        setPublicDetail(item);
        if (!item.description) {
            void getPublicSkillsAbout([item.id]).then((res) => {
                const desc = res.about?.[item.id];
                if (!desc) return;
                setPublicItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, description: desc } : entry)));
                setPublicDetail((prev) => (prev && prev.id === item.id ? { ...prev, description: desc } : prev));
            }).catch(() => {});
        }
    };
    const releaseInstallation = release ? marketInstallationState(release, installed) : "install";
    const releaseItem = release ? items.find(item => item.skillId === release.skillId && item.releaseId === release.releaseId) : undefined;
    const releaseUnsupported = release ? releaseUnsupportedReasons(release, releaseItem?.compatibility) : [];
    const publicDetailInstalled = publicDetail ? isPublicMarketSkillInstalled(publicDetail, installed) : false;
    const visibleMarketItems = marketSource === "public" ? [] : items;
    const visiblePublicItems = marketSource === "beeftv" ? [] : publicItems;
    const scriptAutoRunControl = scriptLoadState === "unavailable" ? undefined : (
        <div className="skill-script-autorun" role="group" aria-label="技能脚本设置">
            {scriptLoadState === "error" ? (
                <Tooltip title={scriptLoadError || "读取技能脚本设置失败，暂时无法修改。"} placement="bottomRight">
                    <span id="skill-script-autorun-error" role="status" className="skill-script-autorun-error">
                        读取失败
                        <button type="button" className="skill-script-autorun-retry" onClick={() => setScriptReloadKey((key) => key + 1)}>重试</button>
                    </span>
                </Tooltip>
            ) : null}
            <Tooltip title="打开后，助手运行技能里的脚本前不再询问。脚本在技能副本里运行，拿不到你的 API Key。" placement="bottomRight">
                <label className="skill-script-autorun-toggle">
                    <span>自动运行技能脚本</span>
                    <Switch
                        size="sm"
                        checked={scriptAutoRun}
                        loading={scriptLoadState === "loading" || scriptSaving}
                        disabled={scriptLoadState !== "ready" || scriptSaving}
                        aria-label="自动运行技能脚本"
                        aria-describedby={scriptLoadState === "error" ? "skill-script-autorun-error" : undefined}
                        onChange={(checked) => void toggleScriptAutoRun(checked)}
                    />
                </label>
            </Tooltip>
        </div>
    );
    const headerProps = {
        title: "技能",
        navigationLabel: "技能分类",
        tabs: [{ value: "market", label: "技能市场" }, { value: "mine", label: "我的技能" }, { value: "publish", label: "我的投稿" }],
        value: tab,
        onChange: changeTab,
        trailing: scriptAutoRunControl,
    };
    return <WorkspacePage className="skill-market-page collection-page" scroll={false}>
        {tab === "publish" ? <SkillPublishingPanel planId={params.get("planId") || undefined} renderHeader={controls => <CollectionHeader {...headerProps} {...controls} />} /> : <>
            <CollectionHeader
                {...headerProps}
                search={{ value: query, placeholder: "搜索技能", onChange: (value) => { setQuery(value); setPage(1); } }}
                actions={<button type="button" className="assets-header-compact-button" aria-label="刷新技能" title="刷新技能" disabled={loading} aria-busy={loading} onClick={reload}><RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /></button>}
                createItems={[
                    { key: "create", label: "创建技能", onClick: () => openEditor() },
                    { key: "import", label: "导入文件", onClick: () => setInstallOpen(true) },
                ]}
            />
            <div className="skill-market-content">
            {tab === "market" ? <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl size="sm" value={marketSource} onChange={(v) => setMarketSource(v as "all" | "beeftv" | "public")} options={[{ value: "all", label: "全部来源" }, { value: "beeftv", label: "BeefTV 市场" }, { value: "public", label: "公共技能目录" }]} />
            </div> : null}
            {tab === "market" && publicNotice && marketSource !== "beeftv" ? <Alert type="info" showIcon title={publicNotice} className="mb-3" /> : null}
            {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={reload}>重试</Button>} /> : loading ? <Skeleton active paragraph={{ rows: 6 }} /> : <>
                {tab === "market" && installedError ? <Alert type="warning" showIcon title={installedError} className="mb-4" action={<Button size="small" onClick={reload}>重试</Button>} /> : null}
                {tab === "market" ? <>
                    {visibleMarketItems.map(item => {
                        const installation = marketInstallationState(item, installed);
                        const installLabel = installation === "installed" ? "已安装" : installation === "update" ? "更新" : "安装";
                        const itemUnsupported = releaseUnsupportedReasons(item, item.compatibility);
                        const isOfficial = isOfficialBuiltinMarketSkill(item, installed);
                        return <article className="workspace-list-row" key={`${item.skillId}/${item.releaseId}`}>
                            <div className="workspace-list-copy">
                                <h2><button type="button" className="workspace-item-title" onClick={() => openRelease(item.skillId, item.releaseId)}>{item.name}</button></h2>
                            </div>
                            <div className="workspace-list-controls">
                                <Tooltip title={isOfficial ? "BeefTV 官方内置技能" : `作者：${item.author || "未提供"}`}><span className="skill-origin-label">{isOfficial ? "官方" : "市场"}</span></Tooltip>
                                <Button size="small" onClick={() => openRelease(item.skillId, item.releaseId)} disabled={busy}>查看详情</Button>
                                <Button type="primary" size="small" className="min-w-16" aria-label={`${installLabel}${item.name}`} loading={installingRelease === item.releaseId} disabled={!canInstallMarketRelease({ busy, installedLoading, installedError, installation, unsupportedReasons: itemUnsupported })} onClick={() => requestInstall(item, false)}>{installLabel}</Button>
                            </div>
                        </article>;
                    })}
                    {visiblePublicItems.map(item => {
                        const isInstalled = isPublicMarketSkillInstalled(item, installed);
                        const installLabel = isInstalled ? "已安装" : "安装";
                        return <article className="workspace-list-row" key={`public:${item.id}`}>
                            <div className="workspace-list-copy">
                                <h2><button type="button" className="workspace-item-title" onClick={() => openPublicSkill(item)}>{item.name}</button></h2>
                            </div>
                            <div className="workspace-list-controls">
                                <Tooltip title={`来源仓库：${item.source} · ${formatSkillCount(item.installs)} 次安装`}><span className="skill-origin-label">市场</span></Tooltip>
                                <Button size="small" onClick={() => openPublicSkill(item)} disabled={busy}>查看详情</Button>
                                <Button type="primary" size="small" className="min-w-16" aria-label={`${installLabel}${item.name}`} loading={installingRelease === item.id} disabled={busy || installedLoading || isInstalled} onClick={() => requestPublicInstall(item, false)}>{installLabel}</Button>
                            </div>
                        </article>;
                    })}
                </> : local.map(skill => {
                    const origin = skillOrigin(skill);
                    return <article className="workspace-list-row" key={skill.skillId}>
                    <div className="workspace-list-copy">
                        <h2><button type="button" className="workspace-item-title" onClick={() => void openLocal(skill)}>{skill.skillName}</button></h2>
                    </div>
                    <div className="workspace-list-controls">
                        <Tooltip title={origin.hint}><span className="skill-origin-label">{origin.label}</span></Tooltip>
                        <Button size="small" onClick={() => void openLocal(skill)} disabled={busy}>查看详情</Button>
                        <label className="skill-market-toggle"><span>{skill.isAdded ? "已启用" : "已停用"}</span><Switch size="sm" aria-label={`启用${skill.skillName}`} checked={skill.isAdded} disabled={busy} onChange={() => void action(() => skill.isAdded ? removeSkill(skill.skillId) : addSkill(skill.skillId), skill.isAdded ? "已停用，不再供助手选择" : "已启用")} /></label>
                        <Dropdown trigger={["click"]} menu={{ items: [
                            ...(skill.sourceType === "market" ? [
                                { key: "updates", label: "检查更新", onClick: () => { changeTab("market"); setQuery(skill.skillName); } },
                                { key: "versions", label: "历史版本", onClick: () => void showVersions(skill) },
                                { key: "fork", label: "创建私人副本", onClick: () => void action(async () => openEditor((await forkSkill(skill.skillId)).skill), "已创建私人副本") },
                            ] : skill.sourceType === "builtin" && !skill.isOwner ? [
                                { key: "fork", label: "创建私人副本", onClick: () => void action(async () => openEditor((await forkSkill(skill.skillId)).skill), "已创建私人副本") },
                            ] : [
                                { key: "edit", label: "编辑技能", onClick: () => void action(async () => openEditor((await getSkill(skill.skillId)).skill), undefined, "无法打开技能编辑", "请刷新“我的技能”后重新打开。") },
                                { key: "publish", label: "分享投稿", onClick: () => setParams({ tab: "publish", skillId: skill.skillId }) },
                            ]),
                            ...(skill.isOwner ? [{ type: "divider" as const }, { key: "delete", label: "删除技能", danger: true, onClick: () => deleteLocal(skill) }] : []),
                        ] }}><Button type="text" size="small" aria-label={`管理${skill.skillName}`} disabled={busy} icon={<MoreHorizontal className="size-4" />} /></Dropdown>
                    </div>
                </article>; })}
                {(tab === "mine" ? total === 0 : visibleMarketItems.length === 0 && visiblePublicItems.length === 0) ? <p className="skill-market-empty">{tab === "mine" ? "还没有技能。可以从市场安装，或导入自己的 SKILL.md。" : "没有找到匹配的技能。"}</p> : null}
            </>}
            </div>
            {!loading && !error && (total > SKILL_PAGE_SIZE || page > 1) ? <nav className="skill-market-pagination" aria-label="技能分页"><Button disabled={page <= 1} onClick={() => setPage(n => n - 1)}>上一页</Button><span>第 {page} / {Math.max(1, Math.ceil(total / SKILL_PAGE_SIZE))} 页 · 共 {total} 项</span><Button disabled={page * SKILL_PAGE_SIZE >= total} onClick={() => setPage(n => n + 1)}>下一页</Button></nav> : null}
        </>}
        <AppModal flush scrollBody className="skill-release-dialog" wrapClassName="skill-release-wrap" open={Boolean(release)} title={release?.name || "技能详情"} onCancel={() => { setRelease(null); setParams({ tab: "market" }); }} footer={<Button type="primary" loading={busy} disabled={!canInstallMarketRelease({ busy, installedLoading, installedError, installation: releaseInstallation, unsupportedReasons: releaseUnsupported })} onClick={() => { if (release) requestInstall(release, true); }}>{releaseInstallation === "installed" ? "已安装" : releaseInstallation === "update" ? "更新此版本" : "安装此版本"}</Button>} width="min(760px, calc(100vw - 32px))">
            {release ? <div className="skill-market-preview" tabIndex={0} role="region" aria-label="技能详情内容">
                <div className="skill-release-overview">
                    <dl className="skill-release-metadata">
                        <div><dt>版本</dt><dd>{release.versionLabel}</dd></div>
                        <div><dt>作者</dt><dd>{release.author || "未提供"}</dd></div>
                        <div><dt>许可</dt><dd>{release.license}</dd></div>
                    </dl>
                    <p className="skill-release-description">{release.description}</p>
                </div>
                <div className="skill-release-sections">
                    <section className="skill-release-section" aria-label="使用条件">
                        <details open={releaseUnsupported.length > 0}><summary>使用条件</summary>
                            <p>{release.requirements.length ? release.requirements.map(requirementLabel).join("、") : "没有额外工具要求"}</p>
                            {release.requirementNotes ? <p>{release.requirementNotes}</p> : null}
                            {releaseUnsupported.length ? <p className="skill-market-warning">当前环境不满足：{releaseUnsupported.join("、")}</p> : null}
                            {release.requirements.some(value => value.startsWith("model.")) ? <Alert type="info" title="使用前需要在模型配置中选择支持所需理解能力的模型。安装不代表这些条件已满足。" /> : null}
                        </details>
                    </section>
                    <section className="skill-release-section">
                        <details className="skill-release-notes"><summary>安装与运行说明</summary>
                            <p>模型与费用请按技能说明确认。安装只保存文件，使用时由你选择模型。</p><p>安装后不会自动运行，也不会替你切换模型。后续更新需要再次确认。</p>
                        </details>
                    </section>
                    <MarketFilePreview key={release.releaseId} skillId={release.skillId} releaseId={release.releaseId} />
                    <section className="skill-release-section" aria-label="技能文件与高级信息">
                        <SkillFileDetails files={release.files} info={[{ label: "内容哈希", value: release.contentHash }, { label: "压缩包 SHA-256", value: release.archiveSha256 }, { label: "压缩包大小（字节）", value: release.archiveBytes }, { label: "技能编号", value: release.skillId }, { label: "版本编号", value: release.releaseId }]} />
                    </section>
                </div>
            </div> : null}
        </AppModal>
        <AppModal flush scrollBody className="skill-release-dialog" wrapClassName="skill-release-wrap" open={Boolean(publicDetail)} title={publicDetail?.name || "技能详情"} onCancel={() => setPublicDetail(null)} footer={<Button type="primary" loading={busy || Boolean(publicDetail && installingRelease === publicDetail.id)} disabled={installedLoading || publicDetailInstalled} onClick={() => { if (publicDetail) requestPublicInstall(publicDetail, true); }}>{publicDetailInstalled ? "已安装" : "安装此技能"}</Button>} width="min(760px, calc(100vw - 32px))">
            {publicDetail ? <div className="skill-market-preview" tabIndex={0} role="region" aria-label="公共技能详情内容">
                <div className="skill-release-overview">
                    <dl className="skill-release-metadata">
                        <div><dt>来源仓库</dt><dd><a href={publicDetail.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{publicDetail.source}<ExternalLink className="size-3.5" /></a></dd></div>
                        <div><dt>技能标识</dt><dd>{publicDetail.skillId}</dd></div>
                        <div><dt>安装量</dt><dd>{formatSkillCount(publicDetail.installs)}</dd></div>
                    </dl>
                    <p className="skill-release-description">{publicDetail.description || `来自 GitHub 仓库 ${publicDetail.source} 的公开技能。安装后会从该仓库读取 SKILL.md 与附属参考文件。`}</p>
                </div>
                <div className="skill-release-sections">
                    <section className="skill-release-section">
                        <details className="skill-release-notes" open><summary>安装与运行说明</summary>
                            <p>安装时从 GitHub 仓库 {publicDetail.source} 下载技能文件。</p>
                            <p>安装后只保存技能文件，可在「我的技能」中查看完整文件、手动同步最新提交或启用给画布助手。</p>
                        </details>
                    </section>
                </div>
            </div> : null}
        </AppModal>
        <AppModal scrollBody open={Boolean(versions)} title="恢复本机历史版本" onCancel={() => setVersions(null)} onOk={() => { if (versions) void action(async () => { await rollbackSkill(versions.skill.skillId, versionId); setVersions(null); }, "已恢复指定版本"); }} okText="恢复此版本" okButtonProps={{ disabled: !versions || versionId === versions.skill.versionId, loading: busy }}>
            <p>恢复后新对话可选择此版本。已有对话保留原先选定的版本。</p><Select className="w-full" value={versionId} onChange={setVersionId} options={versions?.items.map(v => ({ value: v.id, label: `${v.versionLabel} · ${v.createdAt.slice(0, 10)}${v.id === versions.skill.versionId ? "（当前）" : ""}` }))} />
        </AppModal>
        <SkillDetailModal
            skill={detail}
            loading={false}
            mutating={busy}
            categories={fallbackSkillCategories}
            onClose={() => setDetail(null)}
            onEdit={openEditor}
            onAdd={(skill) => void action(async () => {
                const res = skill.isAdded ? await removeSkill(skill.skillId) : await addSkill(skill.skillId);
                setDetail(res.skill);
            }, skill.isAdded ? "已停用，不再供助手选择" : "已启用")}
            onLike={(skill) => void action(async () => {
                const res = skill.isLike ? await unlikeSkill(skill.skillId) : await likeSkill(skill.skillId);
                setDetail(res.skill);
            })}
            onSync={(skill) => void action(async () => {
                const res = await syncSkill(skill.skillId);
                setDetail(res.skill);
            }, "已同步最新 GitHub 提交", "GitHub 技能同步失败")}
        />
        <SkillEditorDrawer open={editorOpen} skill={edit} onClose={() => setEditorOpen(false)} onSaved={() => { setEditorOpen(false); changeTab("mine"); reload(); }} />
        <SkillInstallModal open={installOpen} onClose={() => setInstallOpen(false)} onManualCreate={() => { setInstallOpen(false); openEditor(); }} onInstalled={() => { setInstallOpen(false); changeTab("mine"); reload(); }} />
        <SkillMarketInstallConfirmModal
            open={Boolean(pendingInstall)}
            request={pendingInstall?.request ?? null}
            loading={busy || Boolean(installingRelease)}
            onCancel={() => setPendingInstall(null)}
            onConfirm={() => {
                if (!pendingInstall) return;
                const { onRun } = pendingInstall;
                setPendingInstall(null);
                onRun();
            }}
        />
    </WorkspacePage>;
}
