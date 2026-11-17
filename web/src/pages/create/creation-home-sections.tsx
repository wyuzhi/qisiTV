import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Dropdown } from "antd";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useNavigate } from "react-router";
import {
    ArrowUp,
    ChevronDown,
    Clapperboard,
    Download,
    FileText,
    Image as ImageIcon,
    MessageSquareText,
    MoreHorizontal,
    Pencil,
    Plus,
    Search,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";

import { AppDrawer } from "@/components/ui/product/app-drawer";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { resolveEmbeddedAssetUrl } from "@/lib/embedded-runtime";
import { listAddedSkills, type Skill } from "@/services/api/skills";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { useUserStore } from "@/stores/use-user-store";
import { type CreationMode } from "./creation-assets";
import { conversationTimestamp } from "./creation-conversations";
import { creationFeaturedWorks, inspirationSource } from "./creation-inspirations";
import { displayCreationPrompt } from "./creation-references";
import {
    conversationTimeFormatter,
    historyDayFormatter,
    modeLabels,
    type CreationConversation,
    type CreationMessage,
} from "./creation-types";

function creationConversationBucket(updatedAt: string): "today" | "yesterday" | "week" | "earlier" {
    const at = new Date(updatedAt).getTime();
    if (!Number.isFinite(at)) return "earlier";
    const nowStart = new Date();
    nowStart.setHours(0, 0, 0, 0);
    const targetStart = new Date(at);
    targetStart.setHours(0, 0, 0, 0);
    const days = Math.round((nowStart.getTime() - targetStart.getTime()) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return "week";
    return "earlier";
}

const creationBucketLabels: Record<"today" | "yesterday" | "week" | "earlier", string> = { today: "今天", yesterday: "昨天", week: "近 7 天", earlier: "更早" };

export function formatMessageTime(value: string) {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? conversationTimeFormatter.format(timestamp) : "";
}

function buildConversationExportMarkdown(conversation: CreationConversation, assistantName: string, userName: string) {
    const lines: string[] = [`# ${conversation.title.trim() || "新创作"}`, ""];
    for (const message of conversation.messages) {
        const stamp = formatMessageTime(message.createdAt);
        const modeTag = message.mode && message.mode !== "text" ? (message.mode === "image" ? "[图像生成] " : "[视频生成] ") : "";
        const speaker = message.role === "user" ? (userName || "我") : assistantName;
        if (message.role === "user") {
            const prompt = displayCreationPrompt(message.content, message.references || []).trim();
            if (!prompt) continue;
            lines.push(`## ${speaker} · ${stamp}`, "", prompt, "");
        } else {
            const body = (message.content || "").trim();
            if (body) lines.push(`## ${speaker} · ${stamp}`, "", `${modeTag}${body}`, "");
            else if (message.resultUrls?.length) lines.push(`## ${speaker} · ${stamp}`, "", `${modeTag}已生成，素材保留在项目中。`, "");
            else continue;
            if (message.reasoning?.trim()) lines.push("> 思考过程：", message.reasoning.trim(), "");
        }
    }
    return lines.join("\n").trim() + "\n";
}

function downloadCreationConversation(conversation: CreationConversation, assistantName: string, userName: string) {
    const safeTitle = (conversation.title.trim() || "新创作").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "新创作";
    const blob = new Blob([buildConversationExportMarkdown(conversation, assistantName, userName)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeTitle}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

function conversationPreviewMessage(conversation: CreationConversation) {
    let fallback: CreationMessage | undefined;
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
        const message = conversation.messages[index];
        if (!message.content.trim()) continue;
        fallback ||= message;
        if (message.role === "user") return message;
    }
    return fallback;
}

function formatHistoryRelativeTime(value: string) {
    const timestamp = conversationTimestamp(value);
    if (!timestamp) return "";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return "刚刚";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} 天前`;
    return historyDayFormatter.format(timestamp);
}

function formatConversationTime(value: string) {
    const timestamp = conversationTimestamp(value);
    if (!timestamp) return "时间未知";
    return conversationTimeFormatter.format(timestamp);
}

export function CreationHistoryDrawer({ open, conversations, activeId, onNew, onClose, onSelect, onDelete, onRename }: { open: boolean; conversations: CreationConversation[]; activeId: string; onNew: () => void; onClose: () => void; onSelect: (conversation: CreationConversation) => void; onDelete: (conversation: CreationConversation) => void; onRename: (conversation: CreationConversation, title: string) => void }) {
    const [keyword, setKeyword] = useState("");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
    const renameInputRef = useRef<HTMLInputElement>(null);
    const skipRenameCommitRef = useRef(false);

    const assistantName = useAppearanceStore((state) => state.appearance.brandName);
    const exportUser = useUserStore((state) => state.user);

    const { message: drawerToast } = App.useApp();

    useEffect(() => {
        if (!open) return;
        setKeyword("");
        setRenamingId(null);
        setMenuOpenId(null);
    }, [open]);

    const commitRename = (conversation: CreationConversation) => {
        const shouldSkip = skipRenameCommitRef.current;
        skipRenameCommitRef.current = false;
        const value = renameInputRef.current?.value.trim() || "";
        setRenamingId(null);
        if (shouldSkip || !value) return;
        const original = conversation.title.trim() || "新创作";
        if (value === original) return;
        onRename(conversation, value);
    };

    const cancelRename = () => {
        skipRenameCommitRef.current = true;
        setRenamingId(null);
    };

    const beginRename = (conversation: CreationConversation) => {
        skipRenameCommitRef.current = false;
        setMenuOpenId(null);
        setRenamingId(conversation.id);
    };

    const visibleConversations = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        if (!query) return conversations;
        return conversations.filter((conversation) => {
            const latest = conversationPreviewMessage(conversation);
            const searchable = [
                conversation.title,
                ...conversation.messages.flatMap((message) => [message.content, displayCreationPrompt(message.content, message.references || [])]),
                latest?.mode ? modeLabels[latest.mode] : "创作",
                formatConversationTime(conversation.updatedAt),
            ].filter(Boolean).join(" ").toLowerCase();
            return searchable.includes(query);
        });
    }, [conversations, keyword]);

    return <AppDrawer flush open={open} onClose={onClose} placement="right" size="min(440px, 100vw)" closeIcon={<X className="size-4" />} className="creation-history-drawer" rootClassName="creation-history-drawer-root" title={<div className="creation-history-title"><span>历史对话</span><small>{conversations.length} 个对话</small></div>}>
        <div className="creation-history-content">
            <label className="creation-history-search">
                <Search aria-hidden="true" />
                <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索对话标题或内容" aria-label="搜索历史对话" />
            </label>

            <button type="button" className="creation-history-new" onClick={onNew}><span className="creation-history-new-icon"><Plus /></span><span className="creation-history-new-copy"><strong>新建创作</strong><small>开启一个新的创作对话</small></span></button>
            {visibleConversations.length ? <ul className="creation-history-list" aria-label="历史对话，按更新时间倒序排列">
                {visibleConversations.flatMap((conversation, index) => {
                    const showGroupHead = !keyword.trim() && (index === 0 || creationConversationBucket(conversation.updatedAt) !== creationConversationBucket(visibleConversations[index - 1].updatedAt));
                    const latest = conversationPreviewMessage(conversation);
                    const active = conversation.id === activeId;
                    const HistoryTypeIcon = latest?.mode === "video" ? Clapperboard : latest?.mode === "image" ? ImageIcon : latest?.mode === "text" ? MessageSquareText : Sparkles;
                    return [
                        showGroupHead ? <li key={`${conversation.id}-group`} className="creation-history-group-head"><h4>{creationBucketLabels[creationConversationBucket(conversation.updatedAt)]}</h4></li> : null,
                        <li key={conversation.id} className={active ? "is-active" : undefined}>
                            {renamingId === conversation.id ? (
                                <div className="creation-history-rename">
                                    <input ref={renameInputRef} className="creation-history-rename-input" defaultValue={conversation.title.trim() || "新创作"} aria-label="重命名对话标题" autoFocus onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === "Escape") { cancelRename(); } }} onBlur={() => commitRename(conversation)} />
                                </div>
                            ) : (
                                <div className={menuOpenId === conversation.id ? "creation-history-row is-menu-open" : "creation-history-row"}>
                                    <button type="button" className="creation-history-item-main" aria-current={active ? "page" : undefined} onClick={() => { setMenuOpenId(null); onSelect(conversation); }}>
                                        <span className="creation-history-item-icon" aria-hidden="true"><HistoryTypeIcon /></span>
                                        <span className="creation-history-item-text">
                                            <strong className="creation-history-item-heading">{conversation.title.trim() || "新创作"}</strong>
                                            <span className="creation-history-snippet">{latest ? <><em>{latest.mode ? modeLabels[latest.mode] : "创作"}</em><span>{displayCreationPrompt(latest.content, latest.references || []).trim() || "还没有开始创作"}</span></> : <><em>创作</em><span>还没有开始创作</span></>}</span>
                                        </span>
                                    </button>
                                    <span className="creation-history-time-slot" aria-hidden={menuOpenId === conversation.id}><time dateTime={conversation.updatedAt}>{formatHistoryRelativeTime(conversation.updatedAt)}</time></span>
                                    <Dropdown trigger={["click"]} placement="bottomRight" open={menuOpenId === conversation.id} onOpenChange={(open) => setMenuOpenId(open ? conversation.id : null)} overlayClassName="creation-history-menu-overlay" menu={{ items: [{ key: "rename", label: "重命名", icon: <Pencil /> }, { key: "export", label: "导出对话", icon: <Download /> }, { key: "delete", label: "删除对话", danger: true, icon: <Trash2 /> }], onClick: ({ key }) => { setMenuOpenId(null); if (key === "rename") { beginRename(conversation); } else if (key === "export") { downloadCreationConversation(conversation, assistantName, exportUser?.displayName || "你"); drawerToast.success("对话已导出为 Markdown"); } else { onDelete(conversation); } } }}>
                                        <button type="button" className={menuOpenId === conversation.id ? "creation-history-more is-open" : "creation-history-more"} aria-label={`更多操作：${conversation.title.trim() || "新创作"}`} onClick={(event) => event.preventDefault()}><MoreHorizontal /></button>
                                    </Dropdown>
                                </div>
                            )}
                        </li>,
                    ];
                })}
            </ul> : <div className="creation-history-empty">{keyword.trim() ? "没有找到匹配的对话" : "暂无历史对话"}</div>}
        </div>
    </AppDrawer>;
}

const creationEmptySuggestions: Array<{ mode: CreationMode; icon: typeof Clapperboard; title: string; hint: string; prompt: string; openLibrary?: boolean }> = [
    { mode: "video", icon: Clapperboard, title: "生成第一个镜头", hint: "描述画面、镜头运动与光线", prompt: "雨夜天台，镜头缓缓推近霓虹灯牌下的主角，她回眸看向镜头，强对比电影感布光" },
    { mode: "image", icon: ImageIcon, title: "从参考图开始", hint: "上传风格图，生成同风格画面", prompt: "", openLibrary: true },
    { mode: "text", icon: FileText, title: "续写故事", hint: "和 AI 讨论剧情、角色与对白", prompt: "帮我续写一个短剧故事，先聊聊剧情走向：" },
    { mode: "video", icon: Sparkles, title: "引用技能增强", hint: "@技能 调用分镜、配音等专业能力", prompt: "调用分镜技能，帮我规划这个镜头的拍摄方案：" },
];

export function CreationEmptySuggest({ onStartPrompt, onOpenLibrary }: { onStartPrompt: (mode: CreationMode, prompt: string) => void; onOpenLibrary: () => void }) {
    const reducedMotion = useReducedMotion();
    const [hovered, setHovered] = useState<string | null>(null);
    return <LayoutGroup id="creation-empty-suggest">
        <div className="creation-empty-suggest" aria-label="快捷创作入口">
        {creationEmptySuggestions.map((item) => {
            const Icon = item.icon;
            const start = () => {
                if (item.openLibrary) onOpenLibrary();
                else onStartPrompt(item.mode, item.prompt);
            };
            return <motion.button
                key={item.title}
                type="button"
                className="suggest-card"
                onClick={start}
                onHoverStart={() => setHovered(item.title)}
                onHoverEnd={() => setHovered(null)}
                whileHover={reducedMotion ? undefined : { y: -2 }}
                transition={aceternityMotion.spring.surface}
            >
                {hovered === item.title ? (
                    <motion.span
                        layoutId="creation-suggest-hover"
                        className="suggest-card-hover"
                        aria-hidden
                        transition={reducedMotion ? { duration: 0 } : aceternityMotion.spring.surface}
                    />
                ) : null}
                <span className="library-icon-tile suggest-icon"><Icon size={18} strokeWidth={2} /></span>
                <span className="suggest-copy">
                    <strong>{item.title}</strong>
                    <span>{item.hint}</span>
                </span>
            </motion.button>;
        })}
        </div>
    </LayoutGroup>;
}

const creationSkillWorks = [
    { title: "东方巨构美学短剧", description: "一站式生成东方巨构美学短剧", image: "/short-drama-styles/ink-narrative.jpg", prompt: "@xianxia-drama-planner 规划一个东方巨构美学短剧的第一幕", author: "鲍鱼chill", uses: "4.4k" },
    { title: "仙侠氛围美学短片", description: "仙侠氛围美学短片", image: "/short-drama-styles/fantasy-3d.jpg", prompt: "@oriental-aesthetic-film 设计一段仙侠氛围美学短片", author: "鲍鱼chill", uses: "2.3k" },
    { title: "梦核美学", description: "从概念到成片一体化创作梦核视觉短片", image: "/short-drama-styles/nature-healing.jpg", prompt: "@dreamcore-generator 创作一段梦核视觉短片", author: "鲍鱼chill", uses: "1.3k" },
    { title: "A24电影美学", description: "高级怪诞电影美学，以作者视角，用粗粝真实的镜头语言", image: "/short-drama-styles/real-life.jpg", prompt: "@a24-cinematic-aesthetic 设计一段 A24 电影美学镜头", author: "鲍鱼chill", uses: "1.4k" },
    { title: "POP MV", description: "一句话生成国际流行音乐 MV 创作方案", image: "/short-drama-styles/cyberpunk-neon.jpg", prompt: "@pop-music-video 设计一支 POP MV", author: "鲍鱼chill", uses: "2.6k" },
    { title: "真实感美妆UGC产品种草", description: "把美妆卖点变成可见证据与自然口播", image: "/short-drama-styles/urban-live-action.jpg", prompt: "@beauty-blogger-reviewer 设计一支美妆 UGC", author: "刘不住Wa...", uses: "2.1k" },
];

export function CreationFeaturedWorks({ onStartPrompt }: { onStartPrompt: (mode: CreationMode, prompt: string) => void }) {
    const navigate = useNavigate();
    const [filter, setFilter] = useState<"all" | CreationMode>("all");
    const [limit, setLimit] = useState(12);
    const [collection, setCollection] = useState<"inspiration" | "skill">("inspiration");
    const [skillSection, setSkillSection] = useState<"recommended" | "mine">("recommended");
    const [mySkills, setMySkills] = useState<Skill[]>([]);
    const [mySkillsLoaded, setMySkillsLoaded] = useState(false);
    const filtered = creationFeaturedWorks.filter((item) => filter === "all" || item.mode === filter);
    const isSkill = collection === "skill";
    useEffect(() => {
        if (!isSkill || skillSection !== "mine" || mySkillsLoaded) return;
        let cancelled = false;
        void listAddedSkills()
            .then(({ skills }) => { if (!cancelled) setMySkills(skills); })
            .catch(() => { if (!cancelled) setMySkills([]); })
            .finally(() => { if (!cancelled) setMySkillsLoaded(true); });
        return () => { cancelled = true; };
    }, [isSkill, mySkillsLoaded, skillSection]);
    const installedSkillWorks = mySkills.map((skill) => ({
        title: skill.skillName,
        description: skill.description || "已安装到本地工作区",
        image: skill.showcaseMedia[0]?.showcaseUrl || "/short-drama-styles/urban-live-action.jpg",
        prompt: `@${skill.skillName} `,
        author: skill.effectiveUser?.name || "本地 Skill",
        uses: skill.version || "已安装",
    }));
    const visibleSkills = skillSection === "mine" ? installedSkillWorks : creationSkillWorks;
    return <section className="creation-featured-works" aria-labelledby="creation-featured-title">
        <div className="creation-featured-heading">
            <div className="flex items-center gap-6">
                <button type="button" className={`creation-collection-tab ${!isSkill ? "is-active" : ""}`} aria-pressed={!isSkill} onClick={() => setCollection("inspiration")}>精选灵感</button>
                <button type="button" className={`creation-collection-tab ${isSkill ? "is-active" : ""}`} aria-pressed={isSkill} onClick={() => setCollection("skill")}>Skill</button>
            </div>
        </div>
        {isSkill ? <div className="creation-skill-toolbar">
            <div className="creation-skill-subpages" role="tablist" aria-label="Skill 子页面">
                <button type="button" role="tab" aria-selected={skillSection === "recommended"} onClick={() => setSkillSection("recommended")}>推荐</button>
                <button type="button" role="tab" aria-selected={skillSection === "mine"} onClick={() => setSkillSection("mine")}>我的</button>
            </div>
            {skillSection === "mine" ? <button type="button" className="creation-skill-create" onClick={() => navigate("/skills?create=1")}><Plus size={16} />创建 Skill</button> : null}
        </div> : <div className="creation-inspiration-filters" role="group" aria-label="灵感类型">
            {(["all", "video", "image", "text"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(12); }}>{value === "all" ? "全部灵感" : modeLabels[value]}<span>{creationFeaturedWorks.filter((item) => value === "all" || item.mode === value).length}</span></button>)}
        </div>}
        <div className={`creation-featured-layout ${isSkill ? "creation-skill-grid" : ""}`}>
            {isSkill ? visibleSkills.map((item) => <button key={item.title} type="button" className="product-collection-card creation-featured-card creation-skill-card" onClick={() => onStartPrompt("video", item.prompt)}>
                <span className="creation-featured-media"><img src={resolveEmbeddedAssetUrl(item.image)} alt="" loading="lazy" /><span className="creation-skill-type">视频</span><span className="creation-skill-hover-use"><Sparkles />使用</span></span>
                <span className="creation-featured-copy"><strong>{item.title}</strong><span>{item.description}</span><em><Sparkles />{item.author} · {item.uses}</em></span>
            </button>) : filtered.slice(0, limit).map((item, index) => <button key={item.title} type="button" className={`product-collection-card creation-featured-card ${index === 0 ? "is-featured-hero" : ""}`} onClick={() => onStartPrompt(item.mode, item.prompt)}>
                <span className="creation-featured-media"><img src={resolveEmbeddedAssetUrl(item.image)} alt="" loading="lazy" /><span className="creation-inspiration-overlay"><ArrowUp />使用这个创意</span></span>
                <span className="creation-featured-copy"><strong>{item.title}</strong><span>{item.description}</span><em><Sparkles />{item.source ? "开源改编 · CC0" : "原创提示词"} · {modeLabels[item.mode]}</em></span>
            </button>)}
        </div>
        {isSkill && skillSection === "mine" && mySkillsLoaded && !visibleSkills.length ? <div className="creation-skill-empty"><Sparkles /><strong>还没有安装 Skill</strong><span>上传、安装或创建一个 Skill 后，它会显示在这里。</span></div> : null}
        <footer className="creation-inspiration-footer">{isSkill ? <span>已展示 {visibleSkills.length} 个 Skill</span> : <>{limit < filtered.length ? <Button onClick={() => setLimit((count) => count + 12)}>展开更多灵感<ChevronDown /></Button> : <span>已展示全部 {filtered.length} 个创意</span>}<details><summary>模板与封面来源</summary><p>{inspirationSource.notice}</p><a href={inspirationSource.repository} target="_blank" rel="noreferrer">awesome-chatgpt-prompts · CC0</a></details></>}</footer>
    </section>;
}
