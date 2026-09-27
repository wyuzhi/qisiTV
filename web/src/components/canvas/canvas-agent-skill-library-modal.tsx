import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "antd";
import { Check, LibraryBig, LoaderCircle, Plus, Search, Sparkles, Users } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { Skill, SkillCategory } from "@/services/api/skills";

type SkillLibraryTab = "enabled" | "installed" | "market";

type CanvasAgentSkillLibraryModalProps = {
    open: boolean;
    theme: CanvasTheme;
    installedSkills: Skill[];
    marketSkills: Skill[];
    selectedSkillIds: string[];
    categories: SkillCategory[];
    category: string;
    search: string;
    loading: boolean;
    hasMore: boolean;
    onClose: () => void;
    onCategoryChange: (value: string) => void;
    onSearch: (value: string) => void;
    onToggle: (skillId: string) => void;
    onInstall: (skill: Skill) => Promise<void>;
    onLoadMore: () => Promise<void>;
};

export function CanvasAgentSkillLibraryModal({
    open,
    theme,
    installedSkills,
    marketSkills,
    selectedSkillIds,
    categories,
    category,
    search,
    loading,
    hasMore,
    onClose,
    onCategoryChange,
    onSearch,
    onToggle,
    onInstall,
    onLoadMore,
}: CanvasAgentSkillLibraryModalProps) {
    const [tab, setTab] = useState<SkillLibraryTab>("enabled");
    const listRef = useRef<HTMLDivElement>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const wasOpenRef = useRef(false);
    const selectedCount = selectedSkillIds.length;

    useEffect(() => {
        if (open && !wasOpenRef.current) setTab(selectedCount > 0 ? "enabled" : "installed");
        wasOpenRef.current = open;
    }, [open, selectedCount]);

    const visibleSkills = useMemo(() => {
        const keyword = search.trim().toLocaleLowerCase("zh-CN");
        const source = tab === "enabled"
            ? installedSkills.filter((skill) => selectedSkillIds.includes(skill.skillId))
            : tab === "installed"
                ? installedSkills
                : marketSkills;

        return source.filter((skill) => {
            if (category !== "all" && skill.tag !== category) return false;
            if (!keyword) return true;
            return `${skill.skillName} ${skill.description || ""} ${skill.effectiveUser?.name || ""}`
                .toLocaleLowerCase("zh-CN")
                .includes(keyword);
        });
    }, [category, installedSkills, marketSkills, search, selectedSkillIds, tab]);

    useEffect(() => {
        const target = loadMoreRef.current;
        if (tab !== "market" || !target || !hasMore || loading || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) void onLoadMore();
        }, { root: listRef.current, rootMargin: "180px 0px" });
        observer.observe(target);
        return () => observer.disconnect();
    }, [hasMore, loading, onLoadMore, tab, visibleSkills.length]);

    const categoryItems = useMemo(() => {
        const unique = new Map<string, SkillCategory>();
        categories.forEach((item) => {
            if (item.value && item.label) unique.set(item.value, item);
        });
        return [{ value: "all", label: "全部" }, ...unique.values()];
    }, [categories]);

    const emptyText = tab === "enabled"
        ? "本轮还没有启用 Skill，可在“已加入”中选择"
        : tab === "installed"
            ? "还没有匹配的已加入 Skill，可前往“发现 Skills”添加"
            : "没有匹配的公开 Skill，换个关键词或分类试试";

    return (
        <AppModal
            rootClassName="canvas-agent-skill-library-modal"
            open={open}
            title={null}
            footer={null}
            centered
            width="min(1180px, calc(100vw - 24px))"
            onCancel={onClose}
            flush
        >
            <section
                className="canvas-agent-skill-library-shell"
                style={{ color: theme.node.text, background: theme.node.panel }}
                data-canvas-no-zoom
                data-canvas-wheel-scroll
                aria-label="Agent Skills 技能库"
            >
                <header className="canvas-agent-skill-library-header">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-lg font-semibold">
                            <LibraryBig className="size-5" aria-hidden="true" />
                            Skills 技能库
                        </div>
                        <p className="mt-1 text-xs" style={{ color: theme.node.muted }}>按分类浏览和搜索技能，本轮最多启用 8 个，发送消息时固定版本。</p>
                    </div>
                    <div className="canvas-agent-skill-library-count" style={{ color: theme.node.muted }}>
                        已启用 <strong style={{ color: selectedCount >= 8 ? "var(--destructive)" : theme.accent.primary }}>{selectedCount}</strong>/8
                    </div>
                </header>

                <div className="canvas-agent-skill-library-toolbar">
                    <div className="canvas-agent-skill-library-tabs" role="tablist" aria-label="Skills 视图">
                        <SkillTab active={tab === "enabled"} label="已启用" count={selectedCount} onClick={() => setTab("enabled")} />
                        <SkillTab active={tab === "installed"} label="已加入" count={installedSkills.length} onClick={() => setTab("installed")} />
                        <SkillTab active={tab === "market"} label="发现 Skills" onClick={() => setTab("market")} />
                    </div>
                    <Input
                        allowClear
                        prefix={<Search className="size-4" style={{ color: theme.node.muted }} aria-hidden="true" />}
                        value={search}
                        onChange={(event) => onSearch(event.target.value)}
                        placeholder="搜索 Skill 名称、说明或作者"
                        aria-label="搜索 Skills"
                        className="canvas-agent-skill-library-search"
                    />
                </div>

                <nav className="canvas-agent-skill-library-categories" aria-label="Skill 分类">
                    {categoryItems.map((item) => (
                        <button
                            key={item.value}
                            type="button"
                            className={`canvas-agent-skill-category ${category === item.value ? "is-active" : ""}`}
                            aria-pressed={category === item.value}
                            onClick={() => onCategoryChange(item.value)}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>

                <div ref={listRef} className="canvas-agent-skill-library-list thin-scrollbar" role="tabpanel">
                    {visibleSkills.map((skill) => (
                        <SkillLibraryCard
                            key={skill.skillId}
                            skill={skill}
                            theme={theme}
                            categories={categories}
                            selected={selectedSkillIds.includes(skill.skillId)}
                            canSelect={selectedCount < 8 || selectedSkillIds.includes(skill.skillId)}
                            onToggle={() => onToggle(skill.skillId)}
                            onInstall={() => onInstall(skill)}
                        />
                    ))}
                    {loading && visibleSkills.length === 0 ? (
                        <div className="canvas-agent-skill-library-state" style={{ color: theme.node.muted }}>
                            <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                            正在读取技能库…
                        </div>
                    ) : null}
                    {!loading && visibleSkills.length === 0 ? (
                        <div className="canvas-agent-skill-library-state" style={{ color: theme.node.muted }}>
                            <Sparkles className="size-6" aria-hidden="true" />
                            <span>{emptyText}</span>
                            {tab !== "market" ? <Button size="small" onClick={() => setTab("market")}>浏览公开 Skills</Button> : null}
                        </div>
                    ) : null}
                    {tab === "market" && hasMore ? <div ref={loadMoreRef} className="col-span-full h-px" aria-hidden="true" /> : null}
                </div>

                <footer className="canvas-agent-skill-library-footer" style={{ color: theme.node.muted, borderColor: theme.node.stroke }}>
                    <span>{tab === "enabled" ? `${selectedCount} 个技能将在本轮生效` : tab === "installed" ? `${visibleSkills.length} 个已加入技能` : `已加载 ${marketSkills.length} 个公开技能`}</span>
                    {tab === "market" && hasMore ? (
                        <Button size="small" disabled={loading} loading={loading} onClick={() => void onLoadMore()}>{loading ? "加载中" : "加载更多"}</Button>
                    ) : <span>{tab === "market" ? "已加载全部" : "最多启用 8 个"}</span>}
                </footer>
            </section>
        </AppModal>
    );
}

function SkillTab({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
    return (
        <button type="button" role="tab" aria-selected={active} className={`canvas-agent-skill-library-tab ${active ? "is-active" : ""}`} onClick={onClick}>
            {label}
            {typeof count === "number" ? <span>{count}</span> : null}
        </button>
    );
}

function SkillLibraryCard({ skill, theme, categories, selected, canSelect, onToggle, onInstall }: {
    skill: Skill;
    theme: CanvasTheme;
    categories: SkillCategory[];
    selected: boolean;
    canSelect: boolean;
    onToggle: () => void;
    onInstall: () => Promise<void>;
}) {
    const [installing, setInstalling] = useState(false);
    const [coverFailed, setCoverFailed] = useState(false);
    const coverUrl = skill.showcaseMedia?.find((item) => item.showcaseUrl)?.showcaseUrl;
    const categoryLabel = categories.find((item) => item.value === skill.tag)?.label || "其他";
    const author = skill.effectiveUser?.name || "qisiTV 创作者";
    const addedCount = formatSkillCount(skill.addedCount || 0);

    useEffect(() => setCoverFailed(false), [coverUrl]);

    const install = async () => {
        if (installing) return;
        setInstalling(true);
        try {
            await onInstall();
        } finally {
            setInstalling(false);
        }
    };

    return (
        <article className={`canvas-agent-skill-card ${selected ? "is-selected" : ""}`} style={{ borderColor: selected ? theme.accent.primary : theme.node.stroke }}>
            <div className="canvas-agent-skill-card-cover" style={{ background: theme.node.fill }}>
                {coverUrl && !coverFailed ? (
                    <img src={coverUrl} alt="" loading="lazy" onError={() => setCoverFailed(true)} />
                ) : (
                    <div className="canvas-agent-skill-card-placeholder" aria-hidden="true">
                        <Sparkles className="size-7" />
                    </div>
                )}
                <span className="canvas-agent-skill-card-category">{categoryLabel}</span>
            </div>
            <div className="canvas-agent-skill-card-body">
                <div className="canvas-agent-skill-card-title-row">
                    <h3 title={skill.skillName}>{skill.skillName}</h3>
                    {skill.version ? <span className="canvas-agent-skill-card-version">v{skill.version}</span> : null}
                </div>
                <p title={skill.description || "暂无技能说明"}>{skill.description || "暂无技能说明"}</p>
                <div className="canvas-agent-skill-card-meta" style={{ color: theme.node.muted }}>
                    <span className="min-w-0 truncate">{author}</span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex shrink-0 items-center gap-1"><Users className="size-3.5" aria-hidden="true" />{addedCount}</span>
                </div>
            </div>
            <div className="canvas-agent-skill-card-action">
                {skill.isAdded ? (
                    <Button
                        size="small"
                        type="default"
                        className={selected ? "is-selected" : ""}
                        icon={selected ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
                        disabled={!canSelect}
                        aria-pressed={selected}
                        title={!canSelect ? "本轮最多启用 8 个 Skills" : undefined}
                        onClick={onToggle}
                    >
                        {selected ? "已启用" : "启用"}
                    </Button>
                ) : (
                    <Button size="small" icon={<Plus className="size-3.5" />} loading={installing} disabled={installing} onClick={() => void install()}>
                        加入
                    </Button>
                )}
            </div>
        </article>
    );
}

function formatSkillCount(value: number) {
    return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
