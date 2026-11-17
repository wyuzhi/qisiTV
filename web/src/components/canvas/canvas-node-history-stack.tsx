import { ChevronLeft, ChevronRight, History, Layers } from "lucide-react";
import type { ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { activeImageHistoryIndex, resolveCanvasNodeImageHistory } from "@/lib/canvas/canvas-image-history";
import { CanvasNodeType, type CanvasImageHistoryItem, type CanvasNodeData } from "@/types/canvas";

export function CanvasHistoryStackFrame({
    items,
    activeIndex,
    theme,
    children,
}: {
    items: CanvasImageHistoryItem[];
    activeIndex: number;
    theme: CanvasTheme;
    children: ReactNode;
}) {
    const trailingItems = items
        .filter((_, idx) => idx !== activeIndex)
        .slice(-2)
        .reverse();
    if (!trailingItems.length) return <>{children}</>;

    return (
        <div className="group/history-stack relative h-full w-full overflow-visible">
            <div className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden="true">
                {[...trailingItems].reverse().map((entry, revIdx) => {
                    const idx = trailingItems.length - 1 - revIdx;
                    const offsetX = idx === 0 ? 7 : 14;
                    const offsetY = idx === 0 ? 7 : 14;
                    return (
                        <div
                            key={entry.id}
                            data-history-stack-layer={idx + 1}
                            className="absolute inset-0 overflow-hidden rounded-[var(--node-radius)] motion-safe:transition-transform motion-safe:duration-200"
                            style={{
                                background: theme.node.panel,
                                boxShadow: `0 0 0 1px ${theme.node.stroke}, ${theme.node.shadow}`,
                                transform: `translate(${offsetX}px, ${offsetY}px) scale(${idx === 0 ? 0.992 : 0.984})`,
                            }}
                        >
                            <CachedResourceImage
                                storageKey={entry.storageKey}
                                src={entry.content}
                                previewSize={128}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                draggable={false}
                                className="h-full w-full object-cover"
                            />
                            <div
                                className="pointer-events-none absolute inset-0"
                                style={{ background: idx === 0 ? "rgba(0, 0, 0, 0.28)" : "rgba(0, 0, 0, 0.46)" }}
                            />
                        </div>
                    );
                })}
            </div>
            {children}
        </div>
    );
}

export function CanvasHistoryStackBadge({
    node,
    theme,
    interactiveSwitch,
    onOpenViewer,
    onStepHistory,
}: {
    node: CanvasNodeData;
    theme: CanvasTheme;
    interactiveSwitch: boolean;
    onOpenViewer?: (node: CanvasNodeData) => void;
    onStepHistory?: (node: CanvasNodeData, offset: -1 | 1) => void;
}) {
    const items = resolveCanvasNodeImageHistory(node);
    const currentIndex = activeImageHistoryIndex(node, items);
    if (!items.length || (currentIndex >= 0 && items.length <= 1)) return null;
    const positionText = currentIndex >= 0 ? `${currentIndex + 1}/${items.length}` : `历史 ${items.length}`;
    const canStep = interactiveSwitch && Boolean(onStepHistory) && (items.length > 1 || currentIndex < 0);

    return (
        <div
            data-canvas-no-zoom
            data-testid="canvas-image-history-badge"
            className="inline-flex h-7 shrink-0 items-center rounded-[var(--r-md)] border px-1 text-xs font-medium backdrop-blur-md"
            style={{
                background: theme.toolbar.panel,
                borderColor: theme.toolbar.border,
                color: theme.node.text,
                fontVariantNumeric: "tabular-nums",
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
        >
            {canStep && onStepHistory ? (
                <button
                    type="button"
                    className="grid size-5 place-items-center rounded-[var(--r-sm)] transition-colors hover:bg-black/8 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/10"
                    style={{ outlineColor: theme.accent.primary }}
                    aria-label="切换上一版生成图"
                    title="上一版"
                    onClick={(event) => {
                        event.stopPropagation();
                        onStepHistory(node, -1);
                    }}
                >
                    <ChevronLeft className="size-3.5" />
                </button>
            ) : null}
            <button
                type="button"
                className="inline-flex h-5 items-center gap-1 rounded-[var(--r-sm)] px-1.5 leading-none transition-colors hover:bg-black/8 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/10"
                style={{ outlineColor: theme.accent.primary }}
                aria-label={currentIndex >= 0 ? `共 ${items.length} 版生成记录，当前第 ${currentIndex + 1} 版，点击查看与对比` : `共 ${items.length} 版历史记录，当前暂无主图，点击查看与恢复`}
                title={`共 ${items.length} 版，点击查看历史与对比`}
                onClick={(event) => {
                    event.stopPropagation();
                    onOpenViewer?.(node);
                }}
            >
                <Layers className="size-3 shrink-0" style={{ color: theme.accent.primary }} />
                <span>{positionText}</span>
            </button>
            {canStep && onStepHistory ? (
                <button
                    type="button"
                    className="grid size-5 place-items-center rounded-[var(--r-sm)] transition-colors hover:bg-black/8 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/10"
                    style={{ outlineColor: theme.accent.primary }}
                    aria-label="切换下一版生成图"
                    title="下一版"
                    onClick={(event) => {
                        event.stopPropagation();
                        onStepHistory(node, 1);
                    }}
                >
                    <ChevronRight className="size-3.5" />
                </button>
            ) : null}
        </div>
    );
}

export function CanvasHistoryRestoreAction({
    node,
    theme,
    onRestore,
}: {
    node: CanvasNodeData;
    theme: CanvasTheme;
    onRestore?: (node: CanvasNodeData) => void;
}) {
    if (!onRestore || node.type !== CanvasNodeType.Image || node.metadata?.isBatchRoot) return null;
    const items = resolveCanvasNodeImageHistory(node);
    if (!items.length) return null;
    return (
        <button
            type="button"
            data-testid="canvas-restore-previous-image"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] border px-3 text-xs font-medium transition-colors hover:opacity-90 focus-visible:outline focus-visible:outline-2"
            style={{
                background: theme.node.panel,
                borderColor: theme.node.stroke,
                color: theme.node.text,
                outlineColor: theme.accent.primary,
            }}
            onClick={(event) => {
                event.stopPropagation();
                onRestore(node);
            }}
            onMouseDown={(event) => event.stopPropagation()}
        >
            <History className="size-3.5" />
            恢复上一版图片
        </button>
    );
}
