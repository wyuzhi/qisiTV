import { Button, Input, Skeleton, Tree, Tooltip } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";

import { SegmentedControl } from "@/components/ui/base/segmented-control";
import type { DataNode } from "antd/es/tree";
import { Check, ChevronRight, Code2, ExternalLink, File, FileArchive, FileCode2, FileImage, FileText, Folder, FolderOpen, Heart, Pencil, Plus, RefreshCw, Users } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { skillMarkdownBody } from "./skill-document";
import { skillFailureMessage } from "./skill-feedback";

import { formatSkillCount, formatSkillDate, skillCategoryLabel } from "@/pages/skills/skill-catalog";
import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { getSkillFile, getSkillFileBlob, listSkillFiles, type Skill, type SkillCategory, type SkillPackageFile, type SkillPackageFileContent } from "@/services/api/skills";
import { saveAs } from "file-saver";

type PreviewMode = "preview" | "source";

export function SkillDetailModal({ skill, loading, mutating, categories, onClose, onAdd, onLike, onEdit, onSync, fileOnly = false }: { skill: Skill | null; loading: boolean; mutating: boolean; categories: SkillCategory[]; onClose: () => void; onAdd: (skill: Skill) => void; onLike: (skill: Skill) => void; onEdit: (skill: Skill) => void; onSync: (skill: Skill) => void; fileOnly?: boolean }) {
    const [files, setFiles] = useState<SkillPackageFile[]>([]);
    const [filesLoading, setFilesLoading] = useState(false);
    const [filesError, setFilesError] = useState("");
    const [activePath, setActivePath] = useState("SKILL.md");
    const [content, setContent] = useState<SkillPackageFileContent | null>(null);
    const [contentLoading, setContentLoading] = useState(false);
    const [contentError, setContentError] = useState("");
    const [previewMode, setPreviewMode] = useState<PreviewMode>("preview");
    const [pathFilter, setPathFilter] = useState("");

    useEffect(() => {
        if (!skill) {
            setFiles([]);
            setContent(null);
            return;
        }
        let cancelled = false;
        setFilesLoading(true);
        setFilesError("");
        setPathFilter("");
        listSkillFiles(skill.skillId)
            .then((result) => {
                if (cancelled) return;
                setFiles(result.files);
                const first = result.files.find((file) => file.path === "SKILL.md")?.path || result.files[0]?.path || "";
                setActivePath(first);
            })
            .catch((error) => {
                if (cancelled) return;
                setFiles([]);
                setFilesError(skillFailureMessage(error, "技能文件加载失败", "请关闭详情后重新打开。"));
            })
            .finally(() => {
                if (!cancelled) setFilesLoading(false);
            });
        return () => { cancelled = true; };
    }, [skill?.skillId, skill?.versionId]);

    useEffect(() => {
        if (!skill || !activePath) {
            setContent(null);
            return;
        }
        let cancelled = false;
        setContentLoading(true);
        setContentError("");
        getSkillFile(skill.skillId, activePath)
            .then((result) => { if (!cancelled) setContent(result.file); })
            .catch((error) => {
                if (cancelled) return;
                setContent(null);
                setContentError(skillFailureMessage(error, "文件读取失败", "请重新选择文件，或关闭详情后重试。"));
            })
            .finally(() => { if (!cancelled) setContentLoading(false); });
        return () => { cancelled = true; };
    }, [activePath, skill?.skillId, skill?.versionId]);

    useEffect(() => {
        setPreviewMode("preview");
    }, [activePath]);

    const visibleFiles = useMemo(() => {
        const needle = pathFilter.trim().toLowerCase();
        return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
    }, [files, pathFilter]);
    const treeData = useMemo(() => buildSkillTree(visibleFiles), [visibleFiles]);
    const filePaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
    const selectedFile = files.find((file) => file.path === activePath);
    const canPreviewMarkdown = selectedFile?.kind === "markdown" && !content?.binary;

    return (
        <AppModal
            className="skill-package-modal"
            open={Boolean(skill)}
            width="82vw"
            footer={null}
            destroyOnHidden
            onCancel={onClose}
            flush styles={{ container: { height: "82vh" }, body: { height: "100%" } }}
        >
            {skill ? (
                <div className="skill-package-shell">
                    <header className="skill-package-header">
                        <div className="skill-package-heading">
                            <h1>{skill.skillName}</h1>
                            <SkillPackageAbout skill={skill} categories={categories} />
                        </div>
                        {!fileOnly ? <div className="skill-package-actions">
                            {skill.sourceType === "github" && skill.isOwner ? <Tooltip title={skill.syncError || "从 GitHub 检查并同步最新提交"}><Button loading={mutating} icon={<RefreshCw className="size-4" />} onClick={() => onSync(skill)}>同步</Button></Tooltip> : null}
                            {skill.isOwner ? <Button icon={<Pencil className="size-4" />} onClick={() => onEdit(skill)}>编辑</Button> : null}
                            <Button loading={mutating} icon={<Heart className={`size-4 ${skill.isLike ? "fill-current text-rose-500" : ""}`} />} onClick={() => onLike(skill)}>{skill.isLike ? "已收藏" : "收藏"}</Button>
                            <Button type={skill.isAdded ? "default" : "primary"} loading={mutating} icon={skill.isAdded ? <Check className="size-4" /> : <Plus className="size-4" />} onClick={() => onAdd(skill)}>{skill.isAdded ? "已启用" : "启用技能"}</Button>
                        </div> : null}
                    </header>

                    <div className="skill-package-workspace">
                        <aside className="skill-package-sidebar" aria-label="技能文件">
                            <div className="skill-package-sidebar-summary">
                                <span><FileArchive className="size-3.5" />{skill.fileCount || files.length} 个文件</span>
                                <span>{formatBytes(skill.totalBytes)}</span>
                            </div>
                            <Input allowClear size="small" value={pathFilter} onChange={(event) => setPathFilter(event.target.value)} placeholder="筛选文件…" prefix={<File className="size-3.5 text-foreground/30" />} />
                            <div className="skill-package-tree thin-scrollbar">
                                {filesLoading || loading ? <Skeleton active title={false} paragraph={{ rows: 10 }} /> : filesError ? <div className="skill-package-empty">{filesError}</div> : treeData.length ? (
                                    <Tree
                                        blockNode
                                        showIcon
                                        showLine={false}
                                        defaultExpandAll
                                        expandAction="click"
                                        selectedKeys={activePath ? [activePath] : []}
                                        treeData={treeData}
                                        switcherIcon={({ expanded, isLeaf }) => isLeaf ? null : <ChevronRight aria-hidden="true" className={`skill-package-tree-chevron size-3.5 ${expanded ? "is-expanded" : ""}`} />}
                                        onSelect={(keys, info) => { if (!info.node.children?.length && keys[0]) setActivePath(String(keys[0])); }}
                                    />
                                ) : <div className="skill-package-empty">没有匹配文件</div>}
                            </div>
                            {!fileOnly ? <div className="skill-package-sidebar-footer">
                                <span className="inline-flex items-center gap-1"><Users className="size-3.5" />{formatSkillCount(skill.addedCount)} 人加入</span>
                                <span>{skill.isPrivate ? "仅自己可见" : "公开"}</span>
                            </div> : null}
                        </aside>

                        <main className="skill-package-preview">
                            <div className="skill-package-preview-toolbar">
                                <div className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/58">{activePath || "请选择文件"}</div>
{canPreviewMarkdown ? <SegmentedControl size="sm" value={previewMode} onChange={(value) => setPreviewMode(value as PreviewMode)} options={[{ value: "preview", label: <span className="inline-flex items-center gap-1"><FileText className="size-3.5" />预览</span> }, { value: "source", label: <span className="inline-flex items-center gap-1"><Code2 className="size-3.5" />源码</span> }]} /> : null}
                                {activePath ? <SkillFileDownload skillId={skill.skillId} path={activePath} /> : null}
                            </div>
                            <div className="skill-package-preview-body thin-scrollbar">
                                {contentLoading ? <Skeleton active paragraph={{ rows: 18 }} /> : contentError ? <div className="skill-package-empty">{contentError}</div> : content && selectedFile ? (
                                    <SkillFilePreview skill={skill} file={selectedFile} content={content} mode={previewMode} filePaths={filePaths} onNavigate={setActivePath} />
                                ) : <div className="skill-package-empty">从左侧选择一个文件</div>}
                            </div>
                        </main>
                    </div>
                </div>
            ) : null}
        </AppModal>
    );
}

function SkillFilePreview({ skill, file, content, mode, filePaths, onNavigate }: { skill: Skill; file: SkillPackageFile; content: SkillPackageFileContent; mode: PreviewMode; filePaths: Set<string>; onNavigate: (path: string) => void }) {
    const [preview, setPreview] = useState<{ key: string; url?: string; error?: string }>();
    const key = `${skill.skillId}/${skill.versionId}/${file.path}`;
    useEffect(() => {
        if (!content.binary) return;
        const controller = new AbortController(); let objectURL = "";
        void getSkillFileBlob(skill.skillId, file.path, controller.signal).then(blob => {
            if (controller.signal.aborted) return;
            objectURL = URL.createObjectURL(blob); setPreview({ key, url: objectURL });
        }).catch(error => { if (!controller.signal.aborted) setPreview({ key, error: error instanceof Error ? error.message : "文件读取失败" }); });
        return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL); };
    }, [key, content.binary]);
    const rawURL = preview?.key === key ? preview.url : undefined;
    if (content.binary) {
        if (preview?.key === key && preview.error) return <div role="alert">{preview.error}</div>;
        if (!rawURL) return <Skeleton active paragraph={{ rows: 3 }} />;
        if (file.kind === "image") return <div className="skill-package-media-stage"><img src={rawURL} alt={file.path} /></div>;
        if (file.kind === "video") return <div className="skill-package-media-stage"><video src={rawURL} controls playsInline preload="metadata" /></div>;
        if (file.kind === "audio") return <div className="skill-package-media-stage"><audio src={rawURL} controls preload="metadata" /></div>;
        return <div className="skill-package-empty"><FileArchive className="mb-3 size-9" /><div>该文件不支持在线预览</div><SkillFileDownload skillId={skill.skillId} path={file.path} /></div>;
    }
    if (file.kind === "markdown" && mode === "preview") {
        return <SkillMarkdown source={content.content} currentPath={file.path} filePaths={filePaths} onNavigate={onNavigate} />;
    }
    return <pre className="skill-package-source"><code>{content.content}</code></pre>;
}

function SkillFileDownload({ skillId, path }: { skillId: string; path: string }) {
    const [busy, setBusy] = useState(false); const [error, setError] = useState("");
    return <><Tooltip title="下载原始文件"><button type="button" className="skill-package-raw-link" aria-label="下载原始文件" disabled={busy} onClick={() => {
        setBusy(true); setError("");
        void getSkillFileBlob(skillId, path).then(blob => saveAs(blob, path.split("/").at(-1) || "skill-file")).catch(error => setError(error instanceof Error ? error.message : "下载失败")).finally(() => setBusy(false));
    }}><ExternalLink className="size-4" /></button></Tooltip>{error ? <span role="alert">{error}</span> : null}</>;
}

function SkillMarkdown({ source, currentPath, filePaths, onNavigate }: { source: string; currentPath: string; filePaths: Set<string>; onNavigate: (path: string) => void }) {
    const navigate = (event: MouseEvent<HTMLAnchorElement>, href?: string) => {
        const target = resolveSkillPath(currentPath, href || "");
        if (!target || !filePaths.has(target)) return;
        event.preventDefault();
        onNavigate(target);
    };
    return (
        <article className="skill-package-markdown">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    a: ({ children, href }) => <a href={href} target={isExternalURL(href) ? "_blank" : undefined} rel={isExternalURL(href) ? "noreferrer" : undefined} onClick={(event) => navigate(event, href)}>{children}</a>,
                    table: ({ children }) => <div className="skill-package-table-wrap"><table>{children}</table></div>,
                    img: ({ src, alt }) => {
                        if (isExternalURL(src)) return <img src={src} alt={alt || ""} loading="lazy" />;
                        const target = resolveSkillPath(currentPath, src || "");
                        if (target && filePaths.has(target)) return <button type="button" className="skill-package-inline-file" onClick={() => onNavigate(target)}><FileImage className="size-4" />{alt || target}</button>;
                        return <span className="skill-package-inline-missing">{alt || src || "图片"}</span>;
                    },
                }}
            >{skillMarkdownBody(source)}</ReactMarkdown>
        </article>
    );
}

function buildSkillTree(files: SkillPackageFile[]): DataNode[] {
    type MutableNode = DataNode & { children?: MutableNode[]; file?: SkillPackageFile };
    const roots: MutableNode[] = [];
    const folders = new Map<string, MutableNode>();
    for (const file of files) {
        const parts = file.path.split("/");
        let children = roots;
        let prefix = "";
        parts.forEach((part, index) => {
            const isLeaf = index === parts.length - 1;
            prefix = prefix ? `${prefix}/${part}` : part;
            if (isLeaf) {
                children.push({ key: file.path, title: treeTitle(part, file), icon: fileIcon(file), isLeaf: true, file });
                return;
            }
            let folder = folders.get(prefix);
            if (!folder) {
                folder = {
                    key: `folder:${prefix}`,
                    title: <span className="skill-package-folder-title">{part}</span>,
                    icon: ({ expanded }) => expanded ? <FolderOpen aria-hidden="true" className="size-4" /> : <Folder aria-hidden="true" className="size-4" />,
                    children: [],
                };
                folders.set(prefix, folder);
                children.push(folder);
            }
            children = folder.children || [];
        });
    }
    return roots;
}

function treeTitle(name: string, file: SkillPackageFile): ReactNode {
    return <span className="skill-package-tree-title"><span>{name}</span><span>{formatBytes(file.size)}</span></span>;
}

function fileIcon(file: SkillPackageFile) {
    if (file.kind === "markdown" || file.kind === "text") return <FileText aria-hidden="true" className="size-3.5" />;
    if (file.kind === "code") return <FileCode2 aria-hidden="true" className="size-3.5" />;
    if (file.kind === "image") return <FileImage aria-hidden="true" className="size-3.5" />;
    return <File aria-hidden="true" className="size-3.5" />;
}

function resolveSkillPath(currentPath: string, href: string) {
    const cleanHref = href.split("#", 1)[0]?.split("?", 1)[0] || "";
    if (!cleanHref || isExternalURL(cleanHref) || cleanHref.startsWith("/")) return "";
    const base = currentPath.split("/").slice(0, -1);
    let decoded = cleanHref;
    try {
        decoded = decodeURIComponent(cleanHref);
    } catch {
        return "";
    }
    for (const segment of decoded.replaceAll("\\", "/").split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") base.pop();
        else base.push(segment);
    }
    return base.join("/");
}

function isExternalURL(value?: string) {
    return Boolean(value && /^(https?:|mailto:|data:)/i.test(value));
}

export function SkillPackageAbout({ skill, categories }: { skill: Pick<Skill, "description" | "version" | "effectiveUser" | "sourceType" | "tag" | "updatedAt">; categories: SkillCategory[] }) {
    return (
        <details className="skill-package-about">
            <summary>技能介绍</summary>
            {skill.description ? <p>{skill.description}</p> : null}
            <dl>
                <div><dt>版本</dt><dd>{skill.version || "1.0.0"}</dd></div>
                {skill.effectiveUser?.name ? <div><dt>作者</dt><dd>{skill.effectiveUser.name}</dd></div> : null}
                <div><dt>来源</dt><dd>{sourceLabel(skill.sourceType)}</dd></div>
                <div><dt>分类</dt><dd>{skillCategoryLabel(skill.tag, categories)}</dd></div>
                <div><dt>更新于</dt><dd>{formatSkillDate(skill.updatedAt)}</dd></div>
            </dl>
        </details>
    );
}

export function sourceLabel(source: string) {
    if (source === "market") return "技能市场";
    if (source === "github") return "GitHub";
    if (source === "zip") return "ZIP 技能包";
    if (source === "builtin") return "内置技能";
    if (source === "plugin") return "插件";
    return "Markdown";
}

function formatBytes(value: number) {
    if (!value) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
