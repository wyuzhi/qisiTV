import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, Copy, Eye, Palette, Pencil, Plus, Search, SlidersHorizontal, Star, Trash2, UserRound } from "lucide-react";
import { App, Button, Input } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { nanoid } from "nanoid";

import { StyleProfileEditorModal } from "@/components/canvas/style-profile-editor-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { resolveEmbeddedAssetUrl } from "@/lib/embedded-runtime";
import { createStyleProfileSnapshot, parseStyleProfile, serializeStyleProfile, type StyleProfileSnapshot } from "@/lib/canvas/style-profile";
import {
    canvasStylePresets,
    resolveCanvasStylePreset,
    resolveProjectCanvasStyle,
    type CanvasStylePreset,
} from "@/lib/canvas/canvas-style-catalog";
import { createStyleProfile, deleteStyleProfile, listStyleProfiles, setStyleProfileFavorite, touchStyleProfile, updateStyleProfile, type UserStyleProfile } from "@/services/api/style-profiles";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";


export { canvasStylePresets, resolveCanvasStylePreset, resolveProjectCanvasStyle, type CanvasStylePreset };

const STYLE_FAVORITES_KEY = "canvas:style-library:favorites";
const STYLE_RECENT_KEY = "canvas:style-library:recent";
const LOCAL_STYLE_PROFILES_KEY = "canvas:style-library:profiles";

type StyleCenterTab = "system" | "mine" | "favorites" | "recent";
type SystemStyleLibraryItem = { kind: "system"; preset: CanvasStylePreset };
type UserStyleLibraryItem = { kind: "user"; preset: CanvasStylePreset; entity: UserStyleProfile };
type StyleLibraryItem = SystemStyleLibraryItem | UserStyleLibraryItem;
type StyleEditorState = { profile: StyleProfileSnapshot; entityId?: string };

export function CanvasStylePickerModal({ open, value, currentProfile, startInEditor = false, applying = false, onClose, onSelect }: {
    open: boolean;
    value?: string;
    currentProfile?: StyleProfileSnapshot | null;
    startInEditor?: boolean;
    applying?: boolean;
    onClose: () => void;
    onSelect: (preset: CanvasStylePreset) => void;
}) {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const theme = canvasThemes[useActiveTheme()];
    const localMode = isLocalWorkspaceMode();
    const [detailPreset, setDetailPreset] = useState<CanvasStylePreset | null>(null);
    const [tab, setTab] = useState<StyleCenterTab>("system");
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("全部");
    const [systemFavoriteIds, setSystemFavoriteIds] = useState<string[]>([]);
    const [recentIds, setRecentIds] = useState<string[]>([]);
    const [editor, setEditor] = useState<StyleEditorState | null>(null);
    const [localProfiles, setLocalProfiles] = useState<UserStyleProfile[]>(readLocalStyleProfiles);
    const profilesQuery = useQuery({ queryKey: ["style-profiles"], queryFn: listStyleProfiles, enabled: open && !localMode });
    const profileEntities = localMode ? localProfiles : profilesQuery.data?.profiles || [];

    useEffect(() => {
        if (!open) return;
        setTab("system");
        setQuery("");
        setCategory("全部");
        setSystemFavoriteIds(readStyleIds(STYLE_FAVORITES_KEY));
        setRecentIds(readStyleIds(STYLE_RECENT_KEY));
        if (localMode) setLocalProfiles(readLocalStyleProfiles());
        setEditor(startInEditor && currentProfile?.source !== "user" && currentProfile ? { profile: editableCopy(currentProfile) } : null);
    }, [currentProfile, localMode, open, startInEditor]);

    const userItems = useMemo<UserStyleLibraryItem[]>(() => profileEntities.flatMap((entity) => {
        const preset = userStylePreset(entity);
        return preset ? [{ kind: "user" as const, preset, entity }] : [];
    }), [profileEntities]);
    const systemItems = useMemo<SystemStyleLibraryItem[]>(() => canvasStylePresets.map((preset) => ({ kind: "system", preset })), []);
    const categories = useMemo(() => ["全部", ...Array.from(new Set(canvasStylePresets.map((preset) => preset.category)))], []);

    useEffect(() => {
        if (!open || !startInEditor || !currentProfile || currentProfile.source !== "user" || editor || (!localMode && (profilesQuery.isFetching || profilesQuery.isError))) return;
        const sourceId = currentProfile.sourceProfileId || currentProfile.presetId;
        const sourceEntity = profileEntities.find((profile) => profile.id === sourceId);
        const sourceProfile = sourceEntity ? parseStyleProfile(sourceEntity.profileJson) : null;
        if (sourceEntity && sourceProfile) {
            setEditor({ profile: editableCopy(sourceProfile, sourceEntity.id), entityId: sourceEntity.id });
            return;
        }
        if (localMode || profilesQuery.isFetched) setEditor({ profile: editableCopy(currentProfile) });
    }, [currentProfile, editor, localMode, open, profileEntities, profilesQuery.isError, profilesQuery.isFetched, profilesQuery.isFetching, startInEditor]);

    const visibleItems = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase("zh-CN");
        let source: StyleLibraryItem[] = tab === "system" ? systemItems : tab === "mine" ? userItems : tab === "favorites"
            ? [...systemItems.filter((item) => systemFavoriteIds.includes(item.preset.id)), ...userItems.filter((item) => item.kind === "user" && item.entity.favorite)]
            : [...userItems.filter((item) => item.kind === "user" && item.entity.lastUsedAt).sort((a, b) => String(b.entity.lastUsedAt).localeCompare(String(a.entity.lastUsedAt))), ...recentIds.flatMap((id) => systemItems.filter((item) => item.preset.id === id))];
        if (tab === "system" && category !== "全部") source = source.filter((item) => item.preset.category === category);
        if (keyword) source = source.filter((item) => `${item.preset.title} ${item.preset.category} ${item.preset.description} ${item.preset.tags.join(" ")}`.toLocaleLowerCase("zh-CN").includes(keyword));
        return source;
    }, [category, query, recentIds, systemFavoriteIds, systemItems, tab, userItems]);

    const saveMutation = useMutation({
        mutationFn: ({ profile, apply }: { profile: StyleProfileSnapshot; apply: boolean }) => {
            if (localMode) {
                const id = editor?.entityId || nanoid();
                const now = new Date().toISOString();
                const existing = localProfiles.find((item) => item.id === id);
                const entity: UserStyleProfile = {
                    id,
                    userId: "local",
                    name: profile.title || "未命名风格",
                    description: profile.description || "",
                    coverUrl: profile.coverUrl || "",
                    tagsJson: JSON.stringify(profile.tags || []),
                    profileJson: serializeStyleProfile(profile),
                    favorite: existing?.favorite ?? false,
                    lastUsedAt: existing?.lastUsedAt,
                    revision: (existing?.revision || 0) + 1,
                    createdAt: existing?.createdAt || now,
                    updatedAt: now,
                };
                const next = [entity, ...localProfiles.filter((item) => item.id !== id)];
                setLocalProfiles(next);
                persistLocalStyleProfiles(next);
                return Promise.resolve({ profile: entity, apply });
            }
            return editor?.entityId
                ? updateStyleProfile(editor.entityId, serializeStyleProfile(profile)).then((result) => ({ ...result, apply }))
                : createStyleProfile(serializeStyleProfile(profile)).then((result) => ({ ...result, apply }));
        },
        onSuccess: async ({ profile, apply }) => {
            await queryClient.invalidateQueries({ queryKey: ["style-profiles"] });
            const preset = userStylePreset(profile);
            setEditor(null);
            setTab("mine");
            message.success("风格已保存到“我的风格”");
            if (apply && preset) selectItem({ kind: "user", preset, entity: profile });
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "风格保存失败"),
    });
    const favoriteMutation = useMutation({
        mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => {
            if (localMode) {
                const next = localProfiles.map((item) => item.id === id ? { ...item, favorite, updatedAt: new Date().toISOString() } : item);
                setLocalProfiles(next);
                persistLocalStyleProfiles(next);
                return Promise.resolve({ id, favorite });
            }
            return setStyleProfileFavorite(id, favorite);
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["style-profiles"] }),
        onError: (error) => message.error(error instanceof Error ? error.message : "收藏状态更新失败"),
    });
    const deleteMutation = useMutation({
        mutationFn: (id: string) => {
            if (localMode) {
                const next = localProfiles.filter((item) => item.id !== id);
                setLocalProfiles(next);
                persistLocalStyleProfiles(next);
                return Promise.resolve({ id });
            }
            return deleteStyleProfile(id);
        },
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["style-profiles"] }); message.success("风格已删除"); },
        onError: (error) => message.error(error instanceof Error ? error.message : "风格删除失败"),
    });

    function selectItem(item: StyleLibraryItem) {
        if (applying) return;
        const { preset } = item;
        const next = [preset.id, ...recentIds.filter((id) => id !== preset.id)].slice(0, 12);
        setRecentIds(next);
        localStorage.setItem(STYLE_RECENT_KEY, JSON.stringify(next));
        if (item.kind === "user") {
            if (localMode) {
                const nextProfiles = localProfiles.map((entity) => entity.id === item.entity.id ? { ...entity, lastUsedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : entity);
                setLocalProfiles(nextProfiles);
                persistLocalStyleProfiles(nextProfiles);
            } else {
                void touchStyleProfile(item.entity.id).then(() => queryClient.invalidateQueries({ queryKey: ["style-profiles"] })).catch((error) => message.warning(error instanceof Error ? error.message : "最近使用记录更新失败"));
            }
        }
        onSelect(preset);
    }
    function toggleSystemFavorite(presetId: string) {
        const next = systemFavoriteIds.includes(presetId) ? systemFavoriteIds.filter((id) => id !== presetId) : [presetId, ...systemFavoriteIds];
        setSystemFavoriteIds(next);
        localStorage.setItem(STYLE_FAVORITES_KEY, JSON.stringify(next));
    }
    function createNewStyle() {
        setEditor({ profile: blankUserStyle() });
    }
    function copyPreset(preset: CanvasStylePreset) {
        setEditor({ profile: editableCopy(preset.profile || createStyleProfileSnapshot(preset), undefined, `${preset.title} 副本`, preset.imageUrl) });
    }
    function confirmDelete(entity: UserStyleProfile) {
        modal.confirm({ title: `删除“${entity.name}”？`, content: "项目中已经保存的快照不会被删除，但该风格将从“我的风格”中移除。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => deleteMutation.mutateAsync(entity.id) });
    }

    return (
        <>
            <AppModal rootClassName="canvas-style-picker-modal" open={open} title={null} footer={null} centered width="min(1240px, calc(100vw - 24px))" onCancel={onClose} flush>
                <div className="canvas-style-center-shell flex min-h-0 flex-col overflow-hidden" style={{ color: theme.node.text, background: theme.node.panel }}>
                    <header className="flex min-h-16 flex-col gap-3 border-b px-4 py-3 pr-12 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:pr-14" style={{ borderColor: theme.node.stroke }}>
                        <div className="min-w-0">
                            <h2 className="text-base font-semibold">风格中心</h2>
                            <p className="mt-0.5 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>系统规范 · 个人风格 · 项目快照</p>
                        </div>
                        <div className="flex min-w-0 gap-2 sm:items-center">
                            <Input allowClear className="style-center-search min-w-0 flex-1" prefix={<Search className="size-3.5 text-foreground/35" />} value={query} placeholder="搜索风格、题材或媒介" onChange={(event) => setQuery(event.target.value)} />
                            <Button type="primary" className="shrink-0" icon={<Plus className="size-3.5" />} onClick={createNewStyle}>新建风格</Button>
                        </div>
                    </header>
                    <div className="style-center-workspace grid min-h-0 flex-1">
                        <aside className="style-center-sidebar thin-scrollbar min-h-0 overflow-auto border-b p-2 sm:p-3 lg:border-b-0 lg:border-r" style={{ borderColor: theme.node.stroke }}>
                            <nav className="style-center-primary-nav flex gap-1 lg:flex-col" aria-label="风格中心视图">
                                <StyleCenterNavItem active={tab === "system"} icon={<Palette className="size-3.5" />} label="系统风格" count={systemItems.length} onClick={() => setTab("system")} />
                                <StyleCenterNavItem active={tab === "mine"} icon={<UserRound className="size-3.5" />} label="我的风格" count={userItems.length} onClick={() => setTab("mine")} />
                                <StyleCenterNavItem active={tab === "favorites"} icon={<Star className="size-3.5" />} label="收藏" onClick={() => setTab("favorites")} />
                                <StyleCenterNavItem active={tab === "recent"} icon={<Clock3 className="size-3.5" />} label="最近使用" onClick={() => setTab("recent")} />
                            </nav>
                            {tab === "system" ? (
                                <div className="style-center-category-panel mt-2 border-t pt-2 lg:mt-4 lg:pt-3" style={{ borderColor: theme.node.stroke }}>
                                    <div className="hidden px-2 pb-1.5 text-[var(--fs-tiny)] font-medium lg:block" style={{ color: theme.node.muted }}>分类</div>
                                    <nav className="style-center-category-nav flex gap-1 lg:flex-col" aria-label="系统风格分类">
                                        {categories.map((item) => <button key={item} type="button" aria-current={category === item ? "page" : undefined} className={`style-center-category-item h-9 shrink-0 rounded-md px-2.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 ${category === item ? "is-active font-medium" : ""}`} onClick={() => setCategory(item)}>{item}</button>)}
                                    </nav>
                                </div>
                            ) : null}
                        </aside>
                        <main className="flex min-h-0 min-w-0 flex-col">
                            <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-4" style={{ borderColor: theme.node.stroke }}>
                                <div className="min-w-0 truncate text-xs font-medium">{styleCenterViewTitle(tab, category)}</div>
                                <div className="shrink-0 text-[var(--fs-tiny)] tabular-nums" style={{ color: theme.node.muted }}>{visibleItems.length} 个风格</div>
                            </div>
                            <div className="style-center-grid thin-scrollbar min-h-0 flex-1 content-start overflow-y-auto p-3 sm:p-4">
                            {visibleItems.map((item) => (
                                <StyleCenterCard
                                    key={`${item.kind}-${item.preset.id}`}
                                    item={item}
                                    active={item.preset.id === value}
                                    applying={applying}
                                    favorite={item.kind === "user" ? item.entity.favorite : systemFavoriteIds.includes(item.preset.id)}
                                    theme={theme}
                                    onApply={() => selectItem(item)}
                                    onDetail={() => setDetailPreset(item.preset)}
                                    onFavorite={() => item.kind === "user" ? favoriteMutation.mutate({ id: item.entity.id, favorite: !item.entity.favorite }) : toggleSystemFavorite(item.preset.id)}
                                    onCopy={() => copyPreset(item.preset)}
                                    onEdit={item.kind === "user" ? () => setEditor({ profile: editableCopy(item.preset.profile!, item.entity.id), entityId: item.entity.id }) : undefined}
                                    onDelete={item.kind === "user" ? () => confirmDelete(item.entity) : undefined}
                                />
                            ))}
                            {!visibleItems.length ? <EmptyStyleCenter tab={tab} loading={!localMode && profilesQuery.isLoading} failed={!localMode && profilesQuery.isError} color={theme.node.muted} onCreate={createNewStyle} onBrowse={() => { setTab("system"); setQuery(""); }} /> : null}
                            </div>
                        </main>
                    </div>
                </div>
            </AppModal>
            <CanvasStyleDetailModal open={Boolean(detailPreset)} preset={detailPreset} selected={detailPreset?.id === value} onClose={() => setDetailPreset(null)} onSelect={(preset) => { setDetailPreset(null); const item = [...systemItems, ...userItems].find((candidate) => candidate.preset.id === preset.id); if (item) selectItem(item); }} />
            <StyleProfileEditorModal open={Boolean(editor)} initialProfile={editor?.profile || null} saving={saveMutation.isPending} onClose={() => setEditor(null)} onSave={(profile, apply) => saveMutation.mutate({ profile, apply })} />
        </>
    );
}

function readStyleIds(key: string) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string").slice(0, 100) : [];
    } catch {
        return [];
    }
}

function readLocalStyleProfiles(): UserStyleProfile[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(LOCAL_STYLE_PROFILES_KEY) || "[]") as unknown;
        return Array.isArray(parsed) ? parsed.filter((value): value is UserStyleProfile => Boolean(value && typeof value === "object" && typeof (value as UserStyleProfile).id === "string" && typeof (value as UserStyleProfile).profileJson === "string")) : [];
    } catch {
        return [];
    }
}

function persistLocalStyleProfiles(profiles: UserStyleProfile[]) {
    try {
        localStorage.setItem(LOCAL_STYLE_PROFILES_KEY, JSON.stringify(profiles));
    } catch {
        // Private browsing or a full local quota should not make system styles unusable.
    }
}

function StyleCenterCard({ item, active, applying, favorite, theme, onApply, onDetail, onFavorite, onCopy, onEdit, onDelete }: { item: StyleLibraryItem; active: boolean; applying: boolean; favorite: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onApply: () => void; onDetail: () => void; onFavorite: () => void; onCopy: () => void; onEdit?: () => void; onDelete?: () => void }) {
    const { preset } = item;
    return (
        <article className={`style-center-card group flex min-w-0 flex-col overflow-hidden rounded-md border ${active ? "is-active" : ""}`} style={{ background: theme.canvas.background, borderColor: active ? theme.node.activeStroke : theme.node.stroke, boxShadow: active ? `inset 0 0 0 1px ${theme.node.activeStroke}` : undefined }}>
            <div className="relative overflow-hidden border-b" style={{ borderColor: theme.node.stroke }}>
                <button type="button" className="style-center-card-cover block w-full overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset" style={{ "--tw-ring-color": theme.node.activeStroke } as CSSProperties} onClick={onDetail} aria-label={`查看${preset.title}规范`}>
                    <img src={resolveEmbeddedAssetUrl(preset.imageUrl)} width="640" height="360" alt={`${preset.title}画风示意`} className="h-full w-full object-cover transition-transform" />
                </button>
                <button type="button" className={`style-center-favorite-action absolute right-2 top-2 grid size-8 place-items-center rounded-md outline-none focus-visible:ring-2 ${favorite ? "is-active" : ""}`} onClick={onFavorite} aria-label={favorite ? "取消收藏" : "收藏"} title={favorite ? "取消收藏" : "收藏"}><Star className="size-3.5" fill={favorite ? "currentColor" : "none"} /></button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col px-3 pt-3">
                <div className="flex min-w-0 items-center gap-2 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}><span className="truncate">{item.kind === "user" ? "我的风格" : preset.category}</span>{active ? <span className="ml-auto flex shrink-0 items-center gap-1 font-medium" style={{ color: theme.node.activeStroke }}><Check className="size-3" />当前</span> : null}</div>
                <h3 className="mt-1.5 truncate text-sm font-semibold">{preset.title}</h3>
                <p className="mt-1.5 line-clamp-2 text-xs leading-5" style={{ color: theme.node.muted }}>{preset.description}</p>
                <div className="mt-2 flex min-h-6 flex-wrap gap-1">{preset.tags.slice(0, 3).map((tag) => <span key={tag} className="rounded bg-foreground/5 px-1.5 py-0.5 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>{tag}</span>)}</div>
            </div>
            <footer className="mt-2 flex min-h-11 items-center gap-1 border-t px-2" style={{ borderColor: theme.node.stroke }}>
                <IconAction label="查看规范" onClick={onDetail}><Eye className="size-3.5" /></IconAction>
                <IconAction label="复制并编辑" onClick={onCopy}><Copy className="size-3.5" /></IconAction>
                {onEdit ? <IconAction label="编辑风格" onClick={onEdit}><Pencil className="size-3.5" /></IconAction> : null}
                {onDelete ? <IconAction label="删除风格" danger onClick={onDelete}><Trash2 className="size-3.5" /></IconAction> : null}
                <Button type="default" size="small" className={`style-center-apply-button ml-auto ${active ? "is-current" : ""}`} disabled={active || applying} icon={active ? <Check className="size-3.5" /> : <Palette className="size-3.5" />} onClick={onApply}>{active ? "当前" : "应用"}</Button>
            </footer>
        </article>
    );
}

function IconAction({ label, danger = false, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
    return <button type="button" className={`style-center-icon-action grid size-8 place-items-center rounded-md outline-none focus-visible:ring-2 ${danger ? "is-danger" : ""}`} onClick={onClick} aria-label={label} title={label}>{children}</button>;
}

function StyleCenterNavItem({ active, icon, label, count, onClick }: { active: boolean; icon: ReactNode; label: string; count?: number; onClick: () => void }) {
    return <button type="button" aria-current={active ? "page" : undefined} className={`style-center-nav-item flex h-11 min-w-fit items-center gap-2 rounded-md px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 lg:w-full ${active ? "is-active font-medium" : ""}`} onClick={onClick}>{icon}<span className="whitespace-nowrap">{label}</span>{count !== undefined ? <span className="ml-auto tabular-nums opacity-55">{count}</span> : null}</button>;
}

function styleCenterViewTitle(tab: StyleCenterTab, category: string) {
    if (tab === "mine") return "我的风格";
    if (tab === "favorites") return "收藏风格";
    if (tab === "recent") return "最近使用";
    return category === "全部" ? "全部系统风格" : category;
}

function EmptyStyleCenter({ tab, loading, failed, color, onCreate, onBrowse }: { tab: StyleCenterTab; loading: boolean; failed: boolean; color: string; onCreate: () => void; onBrowse: () => void }) {
    return <div className="col-span-full grid min-h-64 place-items-center text-center"><div><Search className="mx-auto size-5" style={{ color }} /><p className="mt-2 text-xs font-medium">{loading ? "正在加载风格库" : failed && tab !== "system" ? "我的风格加载失败，请检查登录状态或后端服务" : tab === "mine" ? "还没有自己的风格" : tab === "favorites" ? "还没有收藏风格" : tab === "recent" ? "还没有使用记录" : "没有匹配的系统风格"}</p><div className="mt-3 flex justify-center gap-2">{tab === "mine" && !failed ? <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreate}>新建风格</Button> : null}<Button size="small" onClick={onBrowse}>浏览系统风格</Button></div></div></div>;
}

export function userStylePreset(entity: UserStyleProfile): CanvasStylePreset | null {
    const profile = parseStyleProfile(entity.profileJson);
    if (!profile) return null;
    return { id: profile.presetId, title: profile.title, category: "我的风格", description: profile.description, tags: [...profile.tags], prompt: profile.prompt, imageUrl: profile.coverUrl || entity.coverUrl || "/short-drama-styles/real-life.jpg", profile };
}

function blankUserStyle(): StyleProfileSnapshot {
    return createStyleProfileSnapshot({ presetId: `draft-${nanoid()}`, title: "未命名风格", description: "", tags: [], prompt: "", assets: [], source: "user", revision: 1 });
}

function editableCopy(profile: StyleProfileSnapshot, entityId?: string, title?: string, coverUrl?: string): StyleProfileSnapshot {
    return createStyleProfileSnapshot({ ...profile, presetId: entityId || `draft-${nanoid()}`, sourceProfileId: entityId, title: title || profile.title, coverUrl: profile.coverUrl || coverUrl, source: "user", revision: entityId ? profile.revision : 1 });
}

export function CanvasStyleDetailModal({ open, preset, selected = false, onClose, onSelect }: { open: boolean; preset: CanvasStylePreset | null; selected?: boolean; onClose: () => void; onSelect?: (preset: CanvasStylePreset) => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const sections = preset ? parseStyleSections(preset.prompt) : [];
    return (
        <AppModal rootClassName="canvas-style-detail-modal" open={open} title={null} footer={null} centered destroyOnHidden width="min(820px, calc(100vw - 24px))" onCancel={onClose} flush>
            {preset ? <div className="canvas-style-detail-shell flex flex-col overflow-hidden" style={{ color: theme.node.text, background: theme.node.panel }}>
                <div className="flex h-44 shrink-0 items-center justify-center overflow-hidden border-b sm:h-52" style={{ borderColor: theme.node.stroke, background: theme.canvas.background }}>
                    <img src={resolveEmbeddedAssetUrl(preset.imageUrl)} width="960" height="540" alt={`${preset.title}画风示意`} className="h-full w-full object-contain" style={preset.id === "black-white-noir" ? { filter: "grayscale(1) contrast(1.08)" } : undefined} />
                </div>
                <header className="border-b px-4 py-3 pr-12 sm:px-5 sm:pr-12" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex items-center gap-2 text-[var(--fs-tiny)] font-medium" style={{ color: theme.node.activeStroke }}><span>{preset.category}</span><span className="flex items-center gap-1" style={{ color: theme.node.muted }}><SlidersHorizontal className="size-3" />{preset.profile?.assets.length ? `${preset.profile.assets.length} 个执行资产` : "Prompt 通用"}</span></div>
                    <h2 className="mt-1 text-base font-semibold">{preset.title}</h2>
                    <p className="mt-1.5 text-xs leading-5" style={{ color: theme.node.muted }}>{preset.description}</p>
                </header>
                <div className="grid shrink-0 grid-cols-3 divide-x border-b text-[var(--fs-tiny)]" style={{ borderColor: theme.node.stroke }}>
                    <StyleDetailMetric label="执行方式" value={preset.profile?.assets.length ? "组合资产" : "Prompt 通用"} muted={theme.node.muted} />
                    <StyleDetailMetric label="执行策略" value={preset.profile?.executionPolicy === "strict-assets" ? "严格校验" : "兼容降级"} muted={theme.node.muted} />
                    <StyleDetailMetric label="快照版本" value={`r${preset.profile?.revision || 1}`} muted={theme.node.muted} />
                </div>
                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-5">
                    {preset.profile?.assets.length ? <section className="border-b py-3" style={{ borderColor: theme.node.stroke }}><h3 className="text-xs font-semibold">执行资产</h3><div className="mt-2 divide-y" style={{ borderColor: theme.node.stroke }}>{preset.profile.assets.map((asset) => <div key={asset.id} className="flex items-center justify-between gap-3 py-2 text-xs"><span className="min-w-0"><span className="block truncate font-medium">{asset.title}</span><span className="mt-0.5 block text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>{kindOptionsLabel(asset.kind)} · {asset.provider}</span></span><span className="shrink-0 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>{asset.status === "validated" ? "已验证" : asset.status === "unavailable" ? "不可用" : "待验证"}</span></div>)}</div></section> : null}
                    {sections.map((section) => <section key={section.title} className="border-b py-3 last:border-b-0" style={{ borderColor: theme.node.stroke }}><h3 className="text-xs font-semibold">{section.title}</h3><p className="mt-1.5 text-xs leading-5" style={{ color: theme.node.muted }}>{section.content}</p></section>)}
                    {preset.profile?.negativePrompt ? <section className="border-b py-3 last:border-b-0" style={{ borderColor: theme.node.stroke }}><h3 className="text-xs font-semibold">全局负面 Prompt</h3><p className="mt-1.5 whitespace-pre-wrap text-xs leading-5" style={{ color: theme.node.muted }}>{preset.profile.negativePrompt}</p></section> : null}
                </div>
                <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-4 py-3 sm:px-5" style={{ borderColor: theme.node.stroke }}><Button onClick={onClose}>关闭</Button>{onSelect ? <Button type="primary" disabled={selected} icon={selected ? <Check className="size-3.5" /> : <Palette className="size-3.5" />} onClick={() => onSelect(preset)}>{selected ? "当前画风" : "选择该画风"}</Button> : null}</footer>
            </div> : null}
        </AppModal>
    );
}

function StyleDetailMetric({ label, value, muted }: { label: string; value: string; muted: string }) {
    return <div className="min-w-0 px-3 py-2.5 text-center"><span className="block" style={{ color: muted }}>{label}</span><span className="mt-0.5 block truncate font-medium">{value}</span></div>;
}

function kindOptionsLabel(kind: string) {
    return kind === "lora" ? "LoRA" : kind === "template" ? "图片模板" : kind === "reference" ? "参考图组" : "提示词模块";
}

function parseStyleSections(prompt: string) {
    return prompt.split("\n").map((line) => {
        const match = line.match(/^【([^】]+)】(.*)$/);
        return match ? { title: match[1], content: match[2] } : { title: "补充规范", content: line };
    }).filter((section) => section.content);
}
