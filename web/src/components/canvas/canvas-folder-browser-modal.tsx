import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App } from "antd";
import {
    CornerUpRight,
    Download,
    FileAudio,
    FileText,
    FolderOpen,
    Image as ImageIcon,
    Layers3,
    Maximize2,
    Pencil,
    Search,
    SlidersHorizontal,
    Sparkles,
    Trash2,
    Video,
    X,
} from "lucide-react";

import { batchDownloadCanvasMediaNodes, collectDownloadableMediaNodes } from "@/lib/canvas/canvas-batch-download";
import { canvasNodeVideoPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type CanvasFolderBrowserModalProps = {
    folder: CanvasNodeData | null;
    childNodes: CanvasNodeData[];
    readOnly?: boolean;
    onClose: () => void;
    onRenameNode: (nodeId: string, title: string) => void;
    onOpenNode: (node: CanvasNodeData) => void;
    onExtractNode: (nodeId: string) => void;
    onUnpackFolder: (folderId: string) => void;
    onDeleteNode: (nodeId: string) => void;
};

export function CanvasFolderBrowserModal({
    folder,
    childNodes,
    readOnly = false,
    onClose,
    onRenameNode,
    onOpenNode,
    onExtractNode,
    onUnpackFolder,
    onDeleteNode,
}: CanvasFolderBrowserModalProps) {
    const { message } = App.useApp();
    const theme = canvasThemes[useActiveTheme()];
    const [editingFolderTitle, setEditingFolderTitle] = useState(false);
    const [folderTitle, setFolderTitle] = useState(folder?.title || "");
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editingNodeTitle, setEditingNodeTitle] = useState("");
    const [query, setQuery] = useState("");
    const [downloading, setDownloading] = useState(false);
    const overlayRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        setFolderTitle(folder?.title || "");
        setEditingFolderTitle(false);
        setEditingNodeId(null);
        setQuery("");
        if (folder?.id) {
            overlayRef.current?.focus();
        }
    }, [folder?.id, folder?.title]);

    useEffect(() => {
        if (!folder) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            if (editingFolderTitle) {
                setEditingFolderTitle(false);
                setFolderTitle(folder.title);
                return;
            }
            if (editingNodeId) {
                setEditingNodeId(null);
                return;
            }
            event.stopPropagation();
            onClose();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [editingFolderTitle, editingNodeId, folder, onClose]);

    const orderedChildren = useMemo(
        () => [...childNodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x),
        [childNodes],
    );

    const filteredChildren = useMemo(() => {
        const trimmed = query.trim().toLowerCase();
        if (!trimmed) return orderedChildren;
        return orderedChildren.filter((node) => {
            const titleMatch = node.title.toLowerCase().includes(trimmed);
            const contentMatch = typeof node.metadata?.content === "string" && !node.metadata.content.startsWith("data:") && node.metadata.content.toLowerCase().includes(trimmed);
            return titleMatch || contentMatch;
        });
    }, [orderedChildren, query]);

    const downloadableNodes = useMemo(
        () => collectDownloadableMediaNodes(orderedChildren, orderedChildren.map((node) => node.id)),
        [orderedChildren],
    );

    if (!folder || typeof document === "undefined") return null;

    const commitFolderTitle = () => {
        const next = folderTitle.trim() || "未命名文件夹";
        setFolderTitle(next);
        setEditingFolderTitle(false);
        onRenameNode(folder.id, next);
    };

    const commitChildTitle = (node: CanvasNodeData) => {
        const next = editingNodeTitle.trim() || node.title || "未命名节点";
        setEditingNodeId(null);
        onRenameNode(node.id, next);
    };

    const handleDownloadAll = async () => {
        if (!downloadableNodes.length || downloading) return;
        setDownloading(true);
        try {
            const { downloaded, failed } = await batchDownloadCanvasMediaNodes(downloadableNodes);
            if (failed === 0) message.success(`已批量下载 ${downloaded} 个素材`);
            else if (downloaded > 0) message.warning(`已下载 ${downloaded} 个素材，${failed} 个下载失败`);
            else message.warning("素材下载失败，请稍后重试");
        } finally {
            setDownloading(false);
        }
    };

    const handleBackdropClick = (event: React.MouseEvent<HTMLElement>) => {
        const target = event.target;
        if (target instanceof Element && target.closest("[data-folder-browser-card],[data-folder-browser-header]")) return;
        onClose();
    };

    return createPortal(
        <div
            ref={overlayRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={`${folder.title} 文件夹内容`}
            data-canvas-no-zoom
            data-canvas-folder-browser
            className="fixed inset-0 z-[var(--z-popover)] flex flex-col bg-black/82 outline-none backdrop-blur-md"
            style={{ color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onClick={handleBackdropClick}
        >
            <header
                data-folder-browser-header
                className="mx-auto mt-5 flex w-[min(1440px,calc(100vw-40px))] shrink-0 flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 shadow-xl backdrop-blur-2xl"
                style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border }}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex min-w-0 items-center gap-2.5">
                    <span
                        className="grid size-9 shrink-0 place-items-center rounded-xl border"
                        style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}
                    >
                        <FolderOpen className="size-4" />
                    </span>
                    <div className="min-w-0">
                        {editingFolderTitle ? (
                            <input
                                autoFocus
                                className="h-8 w-56 max-w-full rounded-lg border bg-transparent px-2 text-sm font-semibold outline-none"
                                style={{ borderColor: theme.frame.activeStroke, color: theme.node.text }}
                                value={folderTitle}
                                onChange={(event) => setFolderTitle(event.target.value)}
                                onBlur={commitFolderTitle}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") commitFolderTitle();
                                    if (event.key === "Escape") {
                                        event.stopPropagation();
                                        setFolderTitle(folder.title);
                                        setEditingFolderTitle(false);
                                    }
                                }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="group flex max-w-full items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left text-base font-semibold transition hover:bg-white/8"
                                title={readOnly ? folder.title : `${folder.title} · 点击重命名`}
                                onClick={() => {
                                    if (!readOnly) setEditingFolderTitle(true);
                                }}
                            >
                                <span className="truncate">{folder.title}</span>
                                {!readOnly ? <Pencil className="size-3.5 shrink-0 opacity-55 group-hover:opacity-100" /> : null}
                            </button>
                        )}
                        <div className="px-1.5 text-xs" style={{ color: theme.node.muted }}>
                            共 {orderedChildren.length} 项内容 · 点击空白处或按 Esc 收回画布卡片
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {orderedChildren.length > 4 ? (
                        <label
                            className="flex h-9 items-center gap-2 rounded-xl border px-3 text-xs"
                            style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}
                        >
                            <Search className="size-3.5 opacity-55" />
                            <input
                                className="w-44 bg-transparent outline-none placeholder:opacity-50"
                                placeholder="搜索文件夹内节点..."
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                            {query ? (
                                <button
                                    type="button"
                                    className="opacity-60 hover:opacity-100"
                                    aria-label="清空搜索"
                                    onClick={() => setQuery("")}
                                >
                                    <X className="size-3.5" />
                                </button>
                            ) : null}
                        </label>
                    ) : null}

                    {downloadableNodes.length > 0 ? (
                        <button
                            type="button"
                            disabled={downloading}
                            className="flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition hover:bg-white/8 disabled:opacity-45"
                            style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}
                            onClick={() => void handleDownloadAll()}
                        >
                            <Download className="size-3.5" />
                            <span>批量下载 ({downloadableNodes.length})</span>
                        </button>
                    ) : null}

                    {!readOnly && orderedChildren.length > 0 ? (
                        <button
                            type="button"
                            className="flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition hover:bg-white/8"
                            style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}
                            title="将文件夹内所有节点按网格排回画布并移除文件夹外壳"
                            onClick={() => onUnpackFolder(folder.id)}
                        >
                            <Layers3 className="size-3.5" />
                            <span>解散到画布</span>
                        </button>
                    ) : null}

                    <button
                        type="button"
                        className="flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition hover:bg-white/8"
                        style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}
                        aria-label="收起文件夹"
                        onClick={onClose}
                    >
                        <X className="size-4" />
                        <span>收起</span>
                    </button>
                </div>
            </header>

            <div
                data-canvas-wheel-scroll
                className="thin-scrollbar flex-1 overflow-y-auto px-5 py-6"
                onClick={handleBackdropClick}
            >
                <div className="mx-auto w-[min(1440px,100%)]" onClick={handleBackdropClick}>
                    {filteredChildren.length > 0 ? (
                        <div
                            className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                            onClick={handleBackdropClick}
                        >
                            {filteredChildren.map((node) => {
                                const isEditingNode = editingNodeId === node.id;
                                return (
                                    <div
                                        key={node.id}
                                        data-folder-browser-card
                                        className="group flex flex-col gap-1.5"
                                        onClick={(event) => event.stopPropagation()}
                                    >
                                        <div className="flex items-center justify-between gap-2 px-1">
                                            {isEditingNode ? (
                                                <input
                                                    autoFocus
                                                    className="h-6 min-w-0 flex-1 rounded border bg-black/40 px-1.5 text-xs font-medium outline-none"
                                                    style={{ borderColor: theme.frame.activeStroke, color: theme.node.text }}
                                                    value={editingNodeTitle}
                                                    onChange={(event) => setEditingNodeTitle(event.target.value)}
                                                    onBlur={() => commitChildTitle(node)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === "Enter") commitChildTitle(node);
                                                        if (event.key === "Escape") {
                                                            event.stopPropagation();
                                                            setEditingNodeId(null);
                                                        }
                                                    }}
                                                />
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium opacity-85 transition hover:opacity-100"
                                                    title={readOnly ? node.title : `${node.title} · 点击重命名`}
                                                    onClick={() => {
                                                        if (readOnly) return;
                                                        setEditingNodeId(node.id);
                                                        setEditingNodeTitle(node.title);
                                                    }}
                                                >
                                                    <NodeKindIcon node={node} />
                                                    <span className="truncate">{node.title}</span>
                                                    {!readOnly ? <Pencil className="size-3 shrink-0 opacity-0 transition group-hover:opacity-65" /> : null}
                                                </button>
                                            )}

                                            <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                                                <button
                                                    type="button"
                                                    className="grid size-6 place-items-center rounded-md border transition hover:bg-white/15"
                                                    style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border }}
                                                    title="打开或预览节点"
                                                    aria-label={`打开 ${node.title}`}
                                                    onClick={() => onOpenNode(node)}
                                                >
                                                    <Maximize2 className="size-3" />
                                                </button>
                                                {!readOnly ? (
                                                    <>
                                                        <button
                                                            type="button"
                                                            className="grid size-6 place-items-center rounded-md border transition hover:bg-white/15"
                                                            style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border }}
                                                            title="移出文件夹到画布"
                                                            aria-label={`将 ${node.title} 移出文件夹`}
                                                            onClick={() => onExtractNode(node.id)}
                                                        >
                                                            <CornerUpRight className="size-3" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="grid size-6 place-items-center rounded-md border transition hover:bg-red-500/20"
                                                            style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.accent.danger }}
                                                            title="删除节点"
                                                            aria-label={`删除 ${node.title}`}
                                                            onClick={() => onDeleteNode(node.id)}
                                                        >
                                                            <Trash2 className="size-3" />
                                                        </button>
                                                    </>
                                                ) : null}
                                            </div>
                                        </div>

                                        <div
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => onOpenNode(node)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    onOpenNode(node);
                                                }
                                            }}
                                            className="relative aspect-video w-full cursor-pointer overflow-hidden rounded-xl border transition duration-150 group-hover:border-white/35"
                                            style={{ background: theme.node.fill, borderColor: theme.node.stroke }}
                                        >
                                            <FolderBrowserCardMedia node={node} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div
                            data-folder-browser-header
                            className="mx-auto my-16 flex max-w-md flex-col items-center gap-3 rounded-2xl border p-8 text-center"
                            style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border }}
                        >
                            <FolderOpen className="size-8 opacity-55" />
                            <div className="text-sm font-semibold">
                                {query ? "没有匹配的节点" : "文件夹还是空的"}
                            </div>
                            <div className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                                {query
                                    ? "换个关键词试试，或清空搜索查看全部内容。"
                                    : "回到画布后，把任意节点直接拖到这个文件夹卡片上松手，或框选多个节点点击「收纳到文件夹」即可收进来。"}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

function NodeKindIcon({ node }: { node: CanvasNodeData }) {
    if (node.type === CanvasNodeType.Image) return <ImageIcon className="size-3.5 shrink-0 opacity-70" />;
    if (node.type === CanvasNodeType.Video) return <Video className="size-3.5 shrink-0 opacity-70" />;
    if (node.type === CanvasNodeType.Audio) return <FileAudio className="size-3.5 shrink-0 opacity-70" />;
    if (node.type === CanvasNodeType.Skill) return <Sparkles className="size-3.5 shrink-0 opacity-70" />;
    if (node.type === CanvasNodeType.Config) return <SlidersHorizontal className="size-3.5 shrink-0 opacity-70" />;
    return <FileText className="size-3.5 shrink-0 opacity-70" />;
}

function FolderBrowserCardMedia({ node }: { node: CanvasNodeData }) {
    const imageSrc =
        node.type === CanvasNodeType.Image
            ? node.metadata?.content || node.metadata?.previewContent
            : node.type === CanvasNodeType.Drawing
              ? node.metadata?.drawingPreviewUrl || node.metadata?.content
              : undefined;
    if (imageSrc) {
        return <img src={imageSrc} alt={node.title} className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]" loading="lazy" decoding="async" draggable={false} />;
    }

    if (node.type === CanvasNodeType.Video) {
        const poster = canvasNodeVideoPreviewUrl(node);
        const videoUrl = node.metadata?.content;
        if (videoUrl) {
            return (
                <video
                    src={videoUrl}
                    poster={poster || undefined}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover"
                    onMouseEnter={(event) => void event.currentTarget.play().catch(() => undefined)}
                    onMouseLeave={(event) => {
                        event.currentTarget.pause();
                        event.currentTarget.currentTime = 0;
                    }}
                />
            );
        }
        if (poster) {
            return <img src={poster} alt={node.title} className="h-full w-full object-cover" loading="lazy" decoding="async" draggable={false} />;
        }
        return (
            <div className="grid h-full w-full place-items-center opacity-50">
                <Video className="size-7" />
            </div>
        );
    }

    if (node.type === CanvasNodeType.Audio) {
        const audioUrl = node.metadata?.content;
        return (
            <div
                className="flex h-full w-full flex-col items-center justify-center gap-3 p-4"
                onClick={(event) => event.stopPropagation()}
            >
                <FileAudio className="size-7 opacity-65" />
                {audioUrl ? (
                    <audio controls preload="none" src={audioUrl} className="h-8 w-full max-w-[240px]" />
                ) : (
                    <span className="text-xs opacity-50">暂无音频内容</span>
                )}
            </div>
        );
    }

    if (node.type === CanvasNodeType.Script) {
        const shotCount = node.metadata?.storyboard?.rows.length || 0;
        return (
            <div className="flex h-full w-full flex-col justify-between p-3.5 text-left">
                <span className="text-xs font-semibold opacity-80">分镜脚本 · {shotCount} 镜</span>
                <p className="line-clamp-3 text-xs opacity-65">
                    {node.metadata?.storyboard?.rows.map((row) => row.plotDescription || row.dialogue).filter(Boolean).slice(0, 2).join(" / ") || "点击打开分镜表"}
                </p>
            </div>
        );
    }

    return (
        <div className="flex h-full w-full items-start p-3.5 text-left">
            <p className="line-clamp-5 text-xs leading-relaxed opacity-75">
                {node.metadata?.content || node.title}
            </p>
        </div>
    );
}
