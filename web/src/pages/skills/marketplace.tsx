import { App, Alert, Button, Dropdown, Select, Skeleton } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { CollectionHeader } from "@/components/layout/collection-header";
import { AppModal } from "@/components/ui/product/app-modal";
import { addSkill, deleteSkill, getSkill, listSkills, removeSkill, type Skill } from "@/services/api/skills";
import { forkSkill, getInstalledVersions, getMarketRelease, installMarketRelease, rollbackSkill, searchSkillMarket, type InstalledVersion, type MarketItem, type MarketRelease } from "@/services/api/skill-market";
import { SkillEditorDrawer } from "./skill-editor-drawer";
import { SkillInstallModal } from "./skill-install-modal";
import { SkillDetailModal } from "./skill-detail-drawer";
import { SkillPublishingPanel } from "./publishing-panel";
import { MarketFilePreview } from "./market-file-preview";
import { MarketReviewSummary } from "./market-review-summary";
import { SkillFileDetails } from "./skill-file-details";
import { skillFailureMessage } from "./skill-feedback";
import { capabilityOptions, requirementLabel } from "./market-copy";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import { Switch } from "@/components/ui/base/switch";
import "./marketplace.css";

const SKILL_PAGE_SIZE = 20;

export default function SkillMarketplace() {
    const { message, modal } = App.useApp();
    const [params, setParams] = useSearchParams();
    const tab = ["market", "mine", "publish"].includes(params.get("tab") || "") ? params.get("tab")! : "market";
    const [items, setItems] = useState<MarketItem[]>([]);
    const [installed, setInstalled] = useState<Skill[]>([]);
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
    const [versions, setVersions] = useState<{ skill: Skill; items: InstalledVersion[] } | null>(null);
    const [versionId, setVersionId] = useState("");
    const reload = useCallback(() => setRevision(n => n + 1), []);
    const changeTab = (next: string) => { setParams({ tab: next }); setPage(1); setQuery(""); };
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
                ? searchSkillMarket(query, page).then(value => { if (!stale && clampPage(value.total)) setItems(value.items || []); })
                : listSkills({ scope: "mine", page, pageSize: SKILL_PAGE_SIZE, search: query }).then(value => { if (!stale && clampPage(value.totalCount)) setLocal(value.skills); });
            void work.catch(e => { if (!stale) setError(e.message || "暂时无法读取技能"); }).finally(() => { if (!stale) setLoading(false); });
        }, 200);
        return () => { stale = true; clearTimeout(timer); };
    }, [tab, page, query, revision]);
    useEffect(() => {
        if (tab !== "market") return;
        let stale = false;
        void (async () => {
            const skills: Skill[] = [];
            for (let page = 1; ; page++) {
                const result = await listSkills({ scope: "mine", page, pageSize: 100 });
                if (stale) return;
                skills.push(...result.skills);
                if (!result.hasMore) break;
            }
            if (!stale) setInstalled(skills);
        })().catch(() => { if (!stale) setInstalled([]); });
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
    const install = () => { if (release) void action(async () => { await installMarketRelease(release.skillId, release.releaseId); setRelease(null); changeTab("mine"); }, "已安装，可在画布助手中选择使用"); };
    const headerProps = {
        title: "技能",
        navigationLabel: "技能分类",
        tabs: [{ value: "market", label: "技能市场" }, { value: "mine", label: "我的技能" }, { value: "publish", label: "我的投稿" }],
        value: tab,
        onChange: changeTab,
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
            {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={reload}>重试</Button>} /> : loading ? <Skeleton active paragraph={{ rows: 6 }} /> : <>
                {tab === "market" ? items.map(item => {
                    const owned = installed.find(skill => skill.sourceType === "market" && skill.sourceRef === item.skillId);
                    return <article className="workspace-list-row" key={`${item.skillId}/${item.releaseId}`}>
                        <div className="workspace-list-copy">
                            <h2><button type="button" className="workspace-item-title" onClick={() => openRelease(item.skillId, item.releaseId)}>{item.name}</button></h2>
                            {item.compatibility?.status === "unsupported" ? <p className="skill-market-warning">当前环境不满足：{item.compatibility.reasons?.join("、")}</p> : null}
                        </div>
                        <div className="workspace-list-controls">
                            {owned ? <span className="skill-market-state">{owned.sourceCommit === item.releaseId ? "已安装" : "可更新"}</span> : null}
                            <Button size="small" onClick={() => openRelease(item.skillId, item.releaseId)} disabled={busy}>查看详情</Button>
                        </div>
                    </article>;
                }) : local.map(skill => <article className="workspace-list-row" key={skill.skillId}>
                    <div className="workspace-list-copy">
                        <h2><button type="button" className="workspace-item-title" onClick={() => void openLocal(skill)}>{skill.skillName}</button></h2>
                    </div>
                    <div className="workspace-list-controls">
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
                </article>)}
                {total === 0 ? <p className="skill-market-empty">{tab === "mine" ? "还没有技能。可以从市场安装，或导入自己的 SKILL.md。" : "没有找到匹配的技能。"}</p> : null}
            </>}
            </div>
            {!loading && !error && (total > SKILL_PAGE_SIZE || page > 1) ? <nav className="skill-market-pagination" aria-label="技能分页"><Button disabled={page <= 1} onClick={() => setPage(n => n - 1)}>上一页</Button><span>第 {page} / {Math.max(1, Math.ceil(total / SKILL_PAGE_SIZE))} 页 · 共 {total} 项</span><Button disabled={page * SKILL_PAGE_SIZE >= total} onClick={() => setPage(n => n + 1)}>下一页</Button></nav> : null}
        </>}
        <AppModal scrollBody open={Boolean(release)} title="技能详情" onCancel={() => { setRelease(null); setParams({ tab: "market" }); }} footer={<Button type="primary" loading={busy} disabled={release?.requirements.some(value => !capabilityOptions.some(item => item.value === value))} onClick={install}>安装此版本</Button>} width={720}>
            {release ? <div className="skill-market-preview">
                <h2>{release.name} · {release.versionLabel}</h2><p>{release.description}</p><p>许可：{release.license}</p>
                <p>使用条件：{release.requirements.length ? release.requirements.map(requirementLabel).join("、") : "没有额外工具要求"}</p>{release.requirementNotes ? <p>{release.requirementNotes}</p> : null}
                {release.requirements.some(value => value.startsWith("model.")) ? <Alert type="info" title="使用前需要在模型配置中选择支持所需理解能力的模型。安装不代表这些条件已满足。" /> : null}
                <p>模型与费用请按技能说明确认。安装只保存文件，使用时由你选择模型。</p><p>安装后不会自动运行，也不会替你切换模型。后续更新需要再次确认。</p>
                <SkillFileDetails files={release.files} info={[{ label: "内容哈希", value: release.contentHash }, { label: "压缩包 SHA-256", value: release.archiveSha256 }, { label: "压缩包大小（字节）", value: release.archiveBytes }, { label: "技能编号", value: release.skillId }, { label: "版本编号", value: release.releaseId }]} />
                <MarketReviewSummary review={release.review} /><MarketFilePreview key={release.releaseId} skillId={release.skillId} releaseId={release.releaseId} />
            </div> : null}
        </AppModal>
        <AppModal scrollBody open={Boolean(versions)} title="恢复本机历史版本" onCancel={() => setVersions(null)} onOk={() => { if (versions) void action(async () => { await rollbackSkill(versions.skill.skillId, versionId); setVersions(null); }, "已恢复指定版本"); }} okText="恢复此版本" okButtonProps={{ disabled: !versions || versionId === versions.skill.versionId, loading: busy }}>
            <p>恢复后新对话可选择此版本。已有对话保留原先选定的版本。</p><Select className="w-full" value={versionId} onChange={setVersionId} options={versions?.items.map(v => ({ value: v.id, label: `${v.versionLabel} · ${v.createdAt.slice(0, 10)}${v.id === versions.skill.versionId ? "（当前）" : ""}` }))} />
        </AppModal>
        <SkillDetailModal fileOnly skill={detail} loading={false} mutating={busy} categories={[]} onClose={() => setDetail(null)} onEdit={openEditor} onAdd={() => {}} onLike={() => {}} onSync={() => {}} />
        <SkillEditorDrawer open={editorOpen} skill={edit} onClose={() => setEditorOpen(false)} onSaved={() => { setEditorOpen(false); changeTab("mine"); reload(); }} />
        <SkillInstallModal open={installOpen} onClose={() => setInstallOpen(false)} onManualCreate={() => { setInstallOpen(false); openEditor(); }} onInstalled={() => { setInstallOpen(false); changeTab("mine"); reload(); }} />
    </WorkspacePage>;
}
