import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronRight, FileText, Folder, Image as ImageIcon, Music2, Pencil, Search, UserRound, Video, Workflow } from "lucide-react";

import { canvasPopoverLayer } from "@/lib/canvas/canvas-popover-layer";
import { canvasResourceDisplayName, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssetCategory } from "@/stores/use-asset-store";
import { CanvasNodeType } from "@/types/canvas";
import { mentionMenuPosition, referencePreviewUrl } from "./canvas-mention-editable-dom";
import { useResolvedCanvasResourceReferences } from "./use-resolved-canvas-resource-references";

export function MentionMenu({ anchor, connectedReferences, assetReferences, filteredReferences, query, cursorOffset, activeReferenceId, preferredWidth, onQueryChange, onClose, onSelect, onNavigate, nodeSectionLabel, replacing }: {
    replacing?: boolean;
    nodeSectionLabel: string;
    anchor: HTMLElement;
    connectedReferences: CanvasResourceReference[];
    assetReferences: CanvasResourceReference[];
    filteredReferences: CanvasResourceReference[];
    query: string;
    cursorOffset: number;
    activeReferenceId?: string;
    preferredWidth: number;
    onQueryChange: (query: string) => void;
    onClose: () => void;
    onSelect: (reference: CanvasResourceReference) => void;
    onNavigate?: (direction: "up" | "down") => void;
}) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const selectedRef = useRef(false);
    const [category, setCategory] = useState<AssetCategory | null>(null);
    const [position, setPosition] = useState(() => mentionMenuPosition(anchor, cursorOffset, preferredWidth));
    const popoverLayer = canvasPopoverLayer(anchor);

    useLayoutEffect(() => {
        let frame = 0;
        const updatePosition = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setPosition(mentionMenuPosition(anchor, cursorOffset, preferredWidth)));
        };
        updatePosition();
        const observer = new ResizeObserver(updatePosition);
        observer.observe(anchor);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [anchor, cursorOffset, preferredWidth]);

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => {
        event.stopPropagation();
        const target = event.target as HTMLElement | null;
        if (target?.tagName !== "INPUT") {
            event.preventDefault();
        }
    };
    const selectReference = (reference: CanvasResourceReference) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(reference);
    };
    const connectedNodes = connectedReferences.filter((item) => item.kind !== "skill");
    const skillReferences = connectedReferences.filter((item) => item.kind === "skill");
    const visibleReferences = query
        ? filteredReferences
        : category
          ? assetReferences
          : [];

    useLayoutEffect(() => {
        const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
            const target = event.target;
            const path = typeof event.composedPath === "function" ? event.composedPath() : [];
            const isInsideMenu = Boolean(
                (target instanceof Node && menuRef.current?.contains(target)) ||
                (menuRef.current && path.includes(menuRef.current)) ||
                (target instanceof Element && Boolean(target.closest("[data-canvas-resource-mention-menu]")))
            );
            const isInsideAnchor = Boolean(
                (target instanceof Node && anchor.contains(target)) ||
                path.includes(anchor)
            );
            if (isInsideMenu || isInsideAnchor) return;
            onClose();
        };
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    }, [anchor, onClose]);

    return createPortal(
        <div
            ref={menuRef}
            data-canvas-resource-mention-menu="true"
            className="canvas-resource-mention-menu fixed z-[var(--z-dialog-popover)]"
            data-placement={position.showAbove ? "top" : "bottom"}
            style={{ zIndex: popoverLayer, "--z-dialog-popover": typeof popoverLayer === "number" ? String(popoverLayer) : undefined, left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, transform: position.showAbove ? "translateY(-100%)" : undefined } as CSSProperties}
            onPointerDown={stopCanvasInteraction}
            onMouseDown={(event) => {
                stopCanvasInteraction(event);
                // Category buttons are replaced when navigating. Keep focus in
                // the editor/search so its blur timer cannot dismiss the menu.
                if (event.target instanceof Element && event.target.closest("button")) event.preventDefault();
            }}
            onClick={(event) => event.stopPropagation()}
        >
            {replacing ? <div className="flex items-center justify-between gap-3 px-2 py-1 text-[var(--fs-tiny)]"><span>选择替换素材</span><button type="button" onClick={onClose}>取消重新选择</button></div> : null}
            <div className="canvas-resource-mention-search">
                <Search aria-hidden />
                <input
                    value={query}
                    placeholder={nodeSectionLabel === "工作流节点" ? "搜索工作流节点" : "搜索节点、素材或技能"}
                    aria-label="搜索引用素材"
                    onChange={(event) => onQueryChange(event.target.value)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            onClose();
                            anchor.focus();
                            return;
                        }
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            onNavigate?.("down");
                            return;
                        }
                        if (event.key === "ArrowUp") {
                            event.preventDefault();
                            onNavigate?.("up");
                            return;
                        }
                        if ((event.key === "Enter" || event.key === "Tab") && filteredReferences.length) {
                            event.preventDefault();
                            const active = filteredReferences.find((item) => item.id === activeReferenceId);
                            selectReference(active || filteredReferences[0]);
                        }
                    }}
                />
            </div>
            <div className="canvas-resource-mention-scroll thin-scrollbar">
                {query ? (
                    <MentionReferenceList references={visibleReferences} activeReferenceId={activeReferenceId} onSelect={selectReference} />
                ) : category ? (
                    <>
                        <button
                            type="button"
                            className="canvas-resource-mention-back"
                            onPointerDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setCategory(null);
                            }}
                        >
                            <ArrowLeft aria-hidden />
                            <span>个人资产库</span>
                            <small>{visibleReferences.length}</small>
                        </button>
                        <MentionReferenceList references={visibleReferences} activeReferenceId={activeReferenceId} onSelect={selectReference} />
                    </>
                ) : (
                    <>
                        {connectedNodes.length ? (
                            <section className="canvas-resource-mention-section">
                                <h4><span>{nodeSectionLabel}</span><small>{connectedNodes.length}</small></h4>
                                <MentionReferenceList references={connectedNodes} activeReferenceId={activeReferenceId} onSelect={selectReference} />
                            </section>
                        ) : null}
                        {skillReferences.length ? (
                            <section className="canvas-resource-mention-section">
                                <h4><span>技能库</span><small>{skillReferences.length}</small></h4>
                                <MentionReferenceList references={skillReferences} activeReferenceId={activeReferenceId} onSelect={selectReference} />
                            </section>
                        ) : null}
                        {assetReferences.length ? (
                            <section className="canvas-resource-mention-section">
                                    <button
                                        type="button"
                                        className="canvas-resource-mention-folder"
                                        onPointerDown={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                        }}
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            setCategory("other");
                                        }}
                                    >
                                        <Folder aria-hidden />
                                        <span>个人资产库</span>
                                        <small>{assetReferences.length}</small>
                                        <ChevronRight aria-hidden />
                                    </button>
                            </section>
                        ) : null}
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}

function MentionReferenceList({ references, activeReferenceId, onSelect }: { references: CanvasResourceReference[]; activeReferenceId?: string; onSelect: (reference: CanvasResourceReference) => void }) {
    if (!references.length) return <div className="canvas-resource-mention-empty">没有匹配的引用</div>;
    return references.map((reference) => (
        <button
            key={reference.id}
            type="button"
            className={`canvas-resource-mention-item ${reference.kind === "skill" ? "is-skill" : ""} ${reference.id === activeReferenceId ? "is-active" : ""}`}
            aria-selected={reference.id === activeReferenceId}
            onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
            }}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelect(reference);
            }}
        >
            <ReferencePreview reference={reference} />
            <span className="canvas-resource-mention-copy">
                <span className="canvas-resource-mention-title-row"><strong title={canvasResourceDisplayName(reference)}>{canvasResourceDisplayName(reference)}</strong>{reference.kind === "skill" ? <em>技能</em> : null}</span>
                {reference.kind === "skill" ? (
                    <span className="canvas-resource-mention-meta"><span>{reference.skill?.description || reference.text || "工作流技能"}</span><small>{reference.skill?.version ? `v${reference.skill.version}` : ""}{reference.skill?.fileCount ? ` · ${reference.skill.fileCount} 文件` : ""}</small></span>
                ) : reference.text && reference.text !== reference.title ? <span className="canvas-resource-mention-meta"><span>{reference.text}</span></span> : null}
            </span>
        </button>
    ));
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    const [visible, setVisible] = useState(false);
    const previewRef = useRef<HTMLSpanElement>(null);
    const references = useMemo(() => [reference], [reference]);
    const [resolved] = useResolvedCanvasResourceReferences(references, { videoPreviewEnabled: visible });
    useEffect(() => {
        const element = previewRef.current;
        if (!element || reference.kind !== "video") return;
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
        observer.observe(element);
        return () => observer.disconnect();
    }, [reference.kind]);
    return <span ref={previewRef} className="inline-flex shrink-0"><ResolvedReferencePreview reference={resolved} /></span>;
}

function ResolvedReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="canvas-resource-mention-preview is-image" />;
    if (reference.kind === "video" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="canvas-resource-mention-preview is-video" loading="lazy" decoding="async" />;
    if (reference.kind === "character" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="canvas-resource-mention-preview is-character" />;
    if (reference.kind === "skill") {
        return (
            <span className="canvas-resource-mention-preview is-skill">
                <Workflow aria-hidden />
            </span>
        );
    }
    const Icon = reference.sourceType === CanvasNodeType.Drawing ? Pencil : reference.kind === "character" ? UserRound : reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <span className="canvas-resource-mention-preview is-fallback">
            <Icon aria-hidden />
        </span>
    );
}

export function InlineReferencePreview({ reference, onClose }: { reference: CanvasResourceReference; onClose: () => void }) {
    const url = referencePreviewUrl(reference);
    if (!url) return null;
    return createPortal(
        <div className="fixed inset-0 z-[var(--z-dialog-popover)] grid place-items-center bg-black/80 p-6" role="dialog" aria-label={`预览${reference.label}`} onClick={onClose}>
            <div className="relative max-h-[92vh] max-w-[92vw]" onClick={(event) => event.stopPropagation()}>
                <img src={url} alt={reference.label} className="max-h-[88vh] max-w-[88vw] rounded-xl object-contain shadow-2xl" />
                <button type="button" className="absolute -right-3 -top-3 rounded-full bg-black/75 p-2 text-white shadow-lg" onClick={onClose} aria-label="关闭图片预览">×</button>
            </div>
        </div>,
        document.body,
    );
}
